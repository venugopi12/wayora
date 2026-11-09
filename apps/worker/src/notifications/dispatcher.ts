import type { PrismaClient } from '@wayora/database';
import type { Logger } from '../logger.js';
import { EmailDeliveryError, type EmailProvider } from './email.js';
import { renderEmail } from './templates.js';

/*
 * The notification outbox processor (docs/notifications.md#delivery).
 *
 * The API writes a `notification_deliveries` row (PENDING) in the same
 * transaction as the notification and the booking/payment change, so nothing
 * is lost if the worker or Redis is down: the rows simply wait. This
 * dispatcher, run by the worker on a schedule, works through them:
 *
 * - Claim: a batch of due PENDING rows is leased with
 *   UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED), so concurrent
 *   workers never take the same row; the lease (locked_until) expires if a
 *   worker dies, and another worker picks the row up after restart.
 * - Not configured: with no email provider, the row becomes NOT_CONFIGURED
 *   (terminal). Nothing is sent and nothing is marked SENT.
 * - Send: the delivery id is the provider's idempotency key.
 * - Finish: only the worker still holding the lease may finish the row
 *   (conditional update), so a slow worker can't overwrite a newer outcome.
 *   SENT only after the provider accepted the message. Transient failures go
 *   back to PENDING with exponential backoff (bounded); permanent failures, or
 *   MAX_ATTEMPTS transient ones, become FAILED.
 *
 * Delivery is at-least-once: a crash after the provider accepted a message
 * but before it was recorded can resend it once the lease expires (providers
 * that honour idempotency keys drop the duplicate).
 */

export const MAX_ATTEMPTS = 5;
export const LEASE_MS = 2 * 60 * 1000;
const BASE_BACKOFF_MS = 30 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

export function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

export interface Claimed {
  id: string;
  notification_id: string;
  attempts: number;
  locked_until: Date;
}

export type DeliveryStatus = 'PENDING' | 'SENT' | 'FAILED' | 'NOT_CONFIGURED';

/**
 * Leases and finishes outbox rows of one channel (EMAIL or PUSH). Each
 * channel's dispatcher only ever sees its own rows.
 */
export class DeliveryOutbox {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly channel: 'EMAIL' | 'PUSH',
    private readonly now: () => Date,
    private readonly batchSize = 20,
  ) {}

  /** Leases up to `batchSize` due deliveries. */
  claim(): Promise<Claimed[]> {
    const now = this.now();
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    return this.prisma.$queryRaw<Claimed[]>`
      UPDATE "notification_deliveries"
      SET "locked_until" = ${leaseUntil}, "attempts" = "attempts" + 1, "updated_at" = ${now}
      WHERE "id" IN (
        SELECT "id" FROM "notification_deliveries"
        WHERE "status" = 'PENDING'
          AND "channel" = ${this.channel}::"notification_channel"
          AND "next_attempt_at" <= ${now}
          AND ("locked_until" IS NULL OR "locked_until" < ${now})
        ORDER BY "next_attempt_at", "id"
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "notification_id", "attempts", "locked_until"`;
  }

  /** Finishes a row this worker still leases. Returns false if the lease was lost. */
  async finish(
    row: Claimed,
    data: {
      status: DeliveryStatus;
      lastError?: string | null;
      providerMessageId?: string;
      nextAttemptAt?: Date;
    },
  ): Promise<boolean> {
    const now = this.now();
    const result = await this.prisma.notificationDelivery.updateMany({
      where: { id: row.id, status: 'PENDING', lockedUntil: row.locked_until },
      data: {
        status: data.status,
        lockedUntil: null,
        lastError: data.lastError ?? null,
        ...(data.status === 'SENT'
          ? { sentAt: now, providerMessageId: data.providerMessageId ?? null }
          : {}),
        ...(data.nextAttemptAt ? { nextAttemptAt: data.nextAttemptAt } : {}),
      },
    });
    return result.count === 1;
  }
}

export interface DispatchResult {
  claimed: number;
  sent: number;
  notConfigured: number;
  retried: number;
  failed: number;
}

export interface DispatcherOptions {
  prisma: PrismaClient;
  provider: EmailProvider;
  logger: Logger;
  /** e.g. https://wayora.example, for links in emails. */
  webOrigin?: string | undefined;
  now?: () => Date;
  batchSize?: number;
}

export class NotificationDispatcher {
  private readonly now: () => Date;
  private readonly outbox: DeliveryOutbox;

  constructor(private readonly options: DispatcherOptions) {
    this.now = options.now ?? (() => new Date());
    this.outbox = new DeliveryOutbox(options.prisma, 'EMAIL', this.now, options.batchSize);
  }

  private claim(): Promise<Claimed[]> {
    return this.outbox.claim();
  }

  private finish(row: Claimed, data: Parameters<DeliveryOutbox['finish']>[1]): Promise<boolean> {
    return this.outbox.finish(row, data);
  }

  private link(notification: {
    paymentId: string | null;
    booking: { reference: string } | null;
  }): string | null {
    const origin = this.options.webOrigin;
    if (!origin || !notification.booking) return null;
    const base = `${origin.replace(/\/$/, '')}/trips/${notification.booking.reference}`;
    return notification.paymentId ? `${base}/payments/${notification.paymentId}` : base;
  }

  /** Processes one batch. Safe to run concurrently and repeatedly. */
  async run(): Promise<DispatchResult> {
    const result: DispatchResult = { claimed: 0, sent: 0, notConfigured: 0, retried: 0, failed: 0 };
    const claimed = await this.claim();
    result.claimed = claimed.length;
    const { prisma, provider, logger } = this.options;

    for (const row of claimed) {
      const log = logger.child({ deliveryId: row.id, attempt: row.attempts });
      if (!provider.configured) {
        if (await this.finish(row, { status: 'NOT_CONFIGURED', lastError: 'no_email_provider' })) {
          result.notConfigured += 1;
        }
        continue;
      }
      const notification = await prisma.notification.findUnique({
        where: { id: row.notification_id },
        select: {
          title: true,
          message: true,
          isDemo: true,
          paymentId: true,
          booking: { select: { reference: true } },
          user: { select: { email: true } },
        },
      });
      if (!notification) {
        await this.finish(row, { status: 'FAILED', lastError: 'notification_missing' });
        result.failed += 1;
        continue;
      }
      try {
        const sent = await provider.send(
          renderEmail({
            to: notification.user.email,
            title: notification.title,
            message: notification.message,
            isDemo: notification.isDemo,
            url: this.link(notification),
          }),
          row.id,
        );
        if (await this.finish(row, { status: 'SENT', providerMessageId: sent.messageId })) {
          result.sent += 1;
        }
      } catch (error) {
        const failure =
          error instanceof EmailDeliveryError
            ? error
            : new EmailDeliveryError('transient', 'unexpected_error');
        const retry = failure.kind === 'transient' && row.attempts < MAX_ATTEMPTS;
        const done = await this.finish(row, {
          status: retry ? 'PENDING' : 'FAILED',
          lastError: `${failure.kind}:${failure.code}`.slice(0, 255),
          ...(retry
            ? { nextAttemptAt: new Date(this.now().getTime() + backoffMs(row.attempts)) }
            : {}),
        });
        if (done && retry) result.retried += 1;
        if (done && !retry) result.failed += 1;
        // Never the address or message: the delivery id and a safe code only.
        log.warn({ code: failure.code, kind: failure.kind, retry }, 'Email delivery failed');
      }
    }
    if (claimed.length > 0) logger.info(result, 'Notification deliveries processed');
    return result;
  }
}
