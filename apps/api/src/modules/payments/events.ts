import { Prisma, type PaymentStatus as DbPaymentStatus, type PrismaClient } from '@wayora/database';
import type { Logger } from '../../utils/logger.js';
import {
  DEMO_PAID_CONFIRMATION_NOTE,
  lockBooking,
  transitionBooking,
} from '../bookings/lifecycle.js';
import { notifyPaymentChange } from '../notifications/events.js';
import { errorForLog } from '../search/errors.js';
import {
  providerPaymentEventSchema,
  type PaymentProvider,
  type ProviderEventType,
  type ProviderPaymentEvent,
} from './providers/types.js';

/*
 * Applies provider events to payments (docs/payments.md#events). Every status
 * change that comes from a provider goes through here, whatever the channel:
 * the answer to a call, reconciliation (polling), or a verified webhook.
 *
 * - Authenticity: webhook events arrive here only after the provider's
 *   verifyEvent accepted the signature; demo events are produced inside the
 *   API process and never cross the network.
 * - Structure: validated against providerPaymentEventSchema.
 * - De-duplication: the Phase 1 `webhook_events` table, unique on
 *   (provider, event id). A processed (or ignored) event is never applied
 *   twice; a failed one is retried when it arrives again.
 * - Ordering: only allowed transitions apply. An event that would move a
 *   payment backwards (e.g. "pending" after "succeeded") is stored as IGNORED.
 * - Payload kept: provider reference, type, time and failure code only (no
 *   raw bodies, signatures or personal data).
 * - The payment change, its history, the booking effect and the audit entry
 *   commit in one transaction.
 */

export const PAYMENT_TRANSITIONS: Record<DbPaymentStatus, readonly DbPaymentStatus[]> = {
  CREATED: ['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
  PENDING: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
  SUCCEEDED: ['REFUND_PENDING'],
  REFUND_PENDING: ['REFUNDED', 'SUCCEEDED'],
  FAILED: [],
  CANCELLED: [],
  REFUNDED: [],
};

export const IN_PROGRESS: DbPaymentStatus[] = ['CREATED', 'PENDING'];

const TARGET: Record<ProviderEventType, DbPaymentStatus> = {
  'payment.pending': 'PENDING',
  'payment.succeeded': 'SUCCEEDED',
  'payment.failed': 'FAILED',
  'payment.cancelled': 'CANCELLED',
  'refund.pending': 'REFUND_PENDING',
  'refund.succeeded': 'REFUNDED',
  'refund.failed': 'SUCCEEDED',
};

/** Wayora's own words for failures; provider messages are never shown. */
export function failureMessage(code: string | undefined, status: DbPaymentStatus): string {
  if (status === 'CANCELLED') return 'The payment was cancelled before it completed.';
  switch (code) {
    case 'demo_declined':
      return 'The demo payment was declined (simulated). No money was involved.';
    case 'provider_rejected':
      return 'The payment provider couldn’t start this payment.';
    default:
      return 'The payment didn’t go through.';
  }
}

const NOTES: Partial<Record<DbPaymentStatus, string>> = {
  PENDING: 'The provider is processing the payment.',
  SUCCEEDED: 'The provider reported the payment as successful.',
  FAILED: 'The provider reported the payment as failed.',
  CANCELLED: 'The provider confirmed the payment was cancelled.',
  REFUND_PENDING: 'The provider is processing a refund.',
  REFUNDED: 'The provider confirmed the refund.',
};

export type EventOutcome = 'applied' | 'duplicate' | 'ignored' | 'unknown-payment' | 'busy';

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/** A PROCESSING row older than this belongs to a crashed attempt and may be retried. */
const STALE_PROCESSING_MS = 60_000;

export class PaymentEventProcessor {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Applies one event from `provider`. `source` says how it arrived: `call`
   * and `poll` events come from this process's own provider calls,
   * `webhook` events have passed the provider's signature check.
   */
  async handle(
    provider: PaymentProvider,
    raw: ProviderPaymentEvent,
    source: 'call' | 'poll' | 'webhook',
  ): Promise<EventOutcome> {
    const event = providerPaymentEventSchema.parse(raw);
    const log = this.logger.child({ providerId: provider.id, eventId: event.id, type: event.type });

    const claimed = await this.claim(provider.id, event, source);
    if (claimed !== 'proceed') return claimed;

    try {
      const outcome = await this.apply(provider, event);
      await this.prisma.webhookEvent.update({
        where: { provider_externalId: { provider: provider.id, externalId: event.id } },
        data: {
          status:
            outcome.kind === 'applied'
              ? 'PROCESSED'
              : outcome.kind === 'ignored'
                ? 'IGNORED'
                : 'FAILED',
          lastError: outcome.reason ?? null,
          processedAt: outcome.kind === 'unknown-payment' ? null : this.now(),
        },
      });
      if (outcome.kind !== 'applied')
        log.warn({ reason: outcome.reason }, 'Payment event not applied');
      return outcome.kind;
    } catch (error) {
      const safe = errorForLog(error);
      await this.prisma.webhookEvent
        .update({
          where: { provider_externalId: { provider: provider.id, externalId: event.id } },
          data: { status: 'FAILED', lastError: `${safe.name}: ${safe.message}`.slice(0, 500) },
        })
        .catch(() => undefined);
      log.error({ err: safe }, 'Payment event processing failed');
      throw error;
    }
  }

  /** Records the event once; decides whether this caller should process it. */
  private async claim(
    providerId: string,
    event: ProviderPaymentEvent,
    source: 'call' | 'poll' | 'webhook',
  ): Promise<'proceed' | 'duplicate' | 'busy'> {
    const now = this.now();
    try {
      await this.prisma.webhookEvent.create({
        data: {
          provider: providerId,
          externalId: event.id,
          eventType: event.type,
          // Only what diagnosis needs: no raw body, signature or personal data.
          payload: {
            providerReference: event.providerReference,
            type: event.type,
            occurredAt: event.occurredAt,
            failureCode: event.failureCode ?? null,
            source,
          },
          signatureVerified: true,
          status: 'PROCESSING',
          attempts: 1,
          receivedAt: now,
        },
      });
      return 'proceed';
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    const existing = await this.prisma.webhookEvent.findUnique({
      where: { provider_externalId: { provider: providerId, externalId: event.id } },
    });
    if (!existing) return 'busy';
    if (existing.status === 'PROCESSED' || existing.status === 'IGNORED') return 'duplicate';
    const stale =
      existing.status === 'PROCESSING' &&
      now.getTime() - existing.receivedAt.getTime() > STALE_PROCESSING_MS;
    if (existing.status === 'FAILED' || existing.status === 'RECEIVED' || stale) {
      // Retry: take it over atomically, so only one retry runs.
      const taken = await this.prisma.webhookEvent.updateMany({
        where: { id: existing.id, status: existing.status, attempts: existing.attempts },
        data: { status: 'PROCESSING', attempts: { increment: 1 }, receivedAt: now },
      });
      return taken.count === 1 ? 'proceed' : 'busy';
    }
    return 'busy';
  }

  private async apply(
    provider: PaymentProvider,
    event: ProviderPaymentEvent,
  ): Promise<{ kind: 'applied' | 'ignored' | 'unknown-payment'; reason?: string }> {
    const target = TARGET[event.type];
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: {
          provider_providerReference: {
            provider: provider.id,
            providerReference: event.providerReference,
          },
        },
        select: { id: true, bookingId: true, userId: true, status: true },
      });
      if (!payment) {
        return {
          kind: 'unknown-payment' as const,
          reason: 'No payment with that provider reference.',
        };
      }
      // Payment outcomes and booking changes for one booking happen one at a time.
      await lockBooking(tx, payment.bookingId);
      const current = await tx.payment.findUniqueOrThrow({
        where: { id: payment.id },
        select: { status: true },
      });
      if (current.status === target) return { kind: 'applied' as const }; // already there
      if (!PAYMENT_TRANSITIONS[current.status].includes(target)) {
        return {
          kind: 'ignored' as const,
          reason: `Out of order or not allowed: ${current.status} → ${target}.`,
        };
      }

      const now = this.now();
      const leavingProgress = IN_PROGRESS.includes(current.status) && !IN_PROGRESS.includes(target);
      const failed = target === 'FAILED' || target === 'CANCELLED';
      const changed = await tx.payment.updateMany({
        where: { id: payment.id, status: current.status },
        data: {
          status: target,
          ...(leavingProgress ? { completedAt: now } : {}),
          ...(failed
            ? {
                failureCode: target === 'CANCELLED' ? 'cancelled' : (event.failureCode ?? 'failed'),
                failureMessage: failureMessage(event.failureCode, target),
              }
            : {}),
        },
      });
      if (changed.count !== 1) {
        return { kind: 'ignored' as const, reason: 'The payment changed concurrently.' };
      }

      let note = NOTES[target] ?? null;
      let closedBooking: string | null = null;
      if (target === 'SUCCEEDED' && current.status !== 'REFUND_PENDING') {
        const effect = await this.onSucceeded(tx, payment, now, provider);
        note = effect.note;
        closedBooking = effect.closedBookingStatus;
      }
      await tx.paymentStatusEvent.create({
        data: {
          paymentId: payment.id,
          fromStatus: current.status,
          toStatus: target,
          actorType: 'PROVIDER',
          providerEventId: event.id,
          note,
          createdAt: now,
        },
      });
      await tx.auditLog.create({
        data: {
          actorType: 'PROVIDER',
          actorId: provider.id,
          action: `payment.${target.toLowerCase()}`,
          entityType: 'payment',
          entityId: payment.id,
          metadata: {
            from: current.status,
            to: target,
            eventId: event.id,
            demo: provider.mode === 'DEMO',
          },
        },
      });
      // The owner's notification, in this same transaction (Phase 14).
      if (current.status !== 'REFUND_PENDING' || target === 'REFUNDED') {
        await notifyPaymentChange(tx, now, payment.id, target, provider.mode === 'DEMO', {
          eventKey: target,
          closedBookingStatus: closedBooking,
        });
      }
      return { kind: 'applied' as const };
    });
  }

  /**
   * The booking effect of a successful payment (docs/payments.md#booking-and-payment):
   * a booking still waiting for its demo payment gets its demo confirmation;
   * a booking that was cancelled or expired meanwhile stays as it is, and the
   * payment is flagged as owed back (refund required).
   */
  private async onSucceeded(
    tx: Prisma.TransactionClient,
    payment: { id: string; bookingId: string },
    now: Date,
    provider: PaymentProvider,
  ): Promise<{ note: string; closedBookingStatus: string | null }> {
    const booking = await tx.booking.findUniqueOrThrow({
      where: { id: payment.bookingId },
      select: { status: true, paymentMode: true },
    });
    if (booking.status === 'PENDING' && booking.paymentMode === 'DEMO') {
      const confirmed = await transitionBooking(
        tx,
        now,
        payment.bookingId,
        'PENDING',
        'CONFIRMED',
        {
          actorType: 'SYSTEM',
          note: DEMO_PAID_CONFIRMATION_NOTE,
        },
      );
      if (confirmed) {
        return {
          note:
            provider.mode === 'DEMO'
              ? 'Demo payment succeeded (simulated; no real money was charged). The booking got its demo confirmation.'
              : 'Payment succeeded. The booking was confirmed.',
          closedBookingStatus: null,
        };
      }
    }
    await tx.payment.update({ where: { id: payment.id }, data: { refundRequired: true } });
    await tx.auditLog.create({
      data: {
        actorType: 'SYSTEM',
        action: 'payment.succeeded_after_booking_closed',
        entityType: 'payment',
        entityId: payment.id,
        metadata: { bookingStatus: booking.status },
      },
    });
    return {
      note: provider.capabilities.refund
        ? 'Succeeded after the booking was closed: the booking stays closed and a refund is required.'
        : 'Succeeded after the booking was closed: the booking stays closed. A refund would be owed, but this provider can’t refund (demo: no real money was charged).',
      closedBookingStatus: booking.status === 'EXPIRED' ? 'expired' : 'cancelled',
    };
  }
}
