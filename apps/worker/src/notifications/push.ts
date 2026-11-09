import webpush from 'web-push';
import type { PrismaClient } from '@wayora/database';
import type { Logger } from '../logger.js';
import { backoffMs, DeliveryOutbox, MAX_ATTEMPTS, type Claimed } from './dispatcher.js';

/*
 * Browser push delivery (Phase 30, docs/pwa.md#push), using the Web Push
 * protocol (RFC 8030) with VAPID (RFC 8292) and message encryption
 * (RFC 8291) through the `web-push` library. The browser's push service
 * (Google FCM, Mozilla autopush, Apple…) delivers each message; nothing is
 * sent anywhere else.
 *
 * - Not configured (no VAPID keys): rows become NOT_CONFIGURED; nothing is
 *   sent and nothing is marked SENT.
 * - Each PUSH delivery goes to the user's devices whose session is still
 *   signed in (not revoked or expired). A device the push service reports as
 *   gone (404/410) is deleted.
 * - Duplicates: the message's `tag` (the notification id) makes the browser
 *   replace rather than add a second notification, and the `Topic` header
 *   lets the push service replace an undelivered copy. A delivery that
 *   reached at least one device is SENT and not retried; only when every
 *   attempt failed transiently is it retried (with backoff, bounded).
 * - Payloads hold the notification's own title and message (written by
 *   Wayora) and a path on this site; push services see only ciphertext.
 */

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** `mailto:` or `https:` contact for push services. */
  subject: string;
}

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushMessageOptions {
  /** Seconds the push service keeps an undelivered message. */
  ttl: number;
  /** Collapses undelivered copies at the push service (≤ 32 base64url characters). */
  topic: string;
  urgency: 'normal' | 'high';
}

/** `gone`: the subscription no longer exists. `transient`: may work later. `permanent`: won't. */
export class PushDeliveryError extends Error {
  constructor(
    readonly kind: 'gone' | 'transient' | 'permanent',
    readonly code: string,
  ) {
    super(`Push delivery failed (${kind}: ${code})`);
    this.name = 'PushDeliveryError';
  }
}

export interface PushSender {
  readonly configured: boolean;
  send(target: PushTarget, payload: string, options: PushMessageOptions): Promise<void>;
}

export class NotConfiguredPushSender implements PushSender {
  readonly configured = false;
  send(): Promise<void> {
    return Promise.reject(new PushDeliveryError('permanent', 'not_configured'));
  }
}

/** Classifies a push service's answer (RFC 8030 §5, §6). */
export function classifyPushStatus(status: number | undefined): PushDeliveryError['kind'] {
  if (status === 404 || status === 410) return 'gone';
  if (status === 429 || status === undefined || status >= 500) return 'transient';
  return 'permanent';
}

/** The exact `web-push` options for one message (also used by tests to inspect the request). */
export function webPushOptions(
  vapid: VapidConfig,
  options: PushMessageOptions,
  timeoutMs = 10_000,
) {
  return {
    vapidDetails: vapid,
    TTL: options.ttl,
    topic: options.topic,
    urgency: options.urgency,
    timeout: timeoutMs,
    contentEncoding: 'aes128gcm' as const,
  };
}

export class WebPushSender implements PushSender {
  readonly configured = true;
  constructor(
    private readonly vapid: VapidConfig,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(target: PushTarget, payload: string, options: PushMessageOptions): Promise<void> {
    try {
      await webpush.sendNotification(
        target,
        payload,
        webPushOptions(this.vapid, options, this.timeoutMs),
      );
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      throw new PushDeliveryError(
        classifyPushStatus(status),
        status ? `http_${status}` : 'network',
      );
    }
  }
}

/** The path a notification opens (the same pages the in-app list links to). */
export function pushTarget(n: {
  paymentId: string | null;
  booking: { reference: string } | null;
  supportTicket: { reference: string } | null;
  type: string;
}): string {
  if (n.booking) {
    return n.paymentId
      ? `/trips/${n.booking.reference}/payments/${n.paymentId}`
      : `/trips/${n.booking.reference}`;
  }
  if (n.supportTicket) return `/support/${n.supportTicket.reference}`;
  if (n.type === 'REWARDS') return '/rewards';
  return '/notifications';
}

export function pushPayload(n: {
  id: string;
  title: string;
  message: string;
  url: string;
}): string {
  return JSON.stringify({
    title: n.title.slice(0, 120),
    body: n.message.slice(0, 400),
    url: n.url,
    tag: `wayora-${n.id}`,
  });
}

export interface PushDispatchResult {
  claimed: number;
  sent: number;
  notConfigured: number;
  retried: number;
  failed: number;
  removedSubscriptions: number;
}

export class PushDispatcher {
  private readonly now: () => Date;
  private readonly outbox: DeliveryOutbox;

  constructor(
    private readonly options: {
      prisma: PrismaClient;
      sender: PushSender;
      logger: Logger;
      now?: () => Date;
      batchSize?: number;
    },
  ) {
    this.now = options.now ?? (() => new Date());
    this.outbox = new DeliveryOutbox(options.prisma, 'PUSH', this.now, options.batchSize);
  }

  async run(): Promise<PushDispatchResult> {
    const result: PushDispatchResult = {
      claimed: 0,
      sent: 0,
      notConfigured: 0,
      retried: 0,
      failed: 0,
      removedSubscriptions: 0,
    };
    const claimed = await this.outbox.claim();
    result.claimed = claimed.length;
    for (const row of claimed) await this.deliver(row, result);
    if (claimed.length > 0) this.options.logger.info(result, 'Push deliveries processed');
    return result;
  }

  private async deliver(row: Claimed, result: PushDispatchResult): Promise<void> {
    const { prisma, sender, logger } = this.options;
    if (!sender.configured) {
      if (await this.outbox.finish(row, { status: 'NOT_CONFIGURED', lastError: 'no_vapid_keys' })) {
        result.notConfigured += 1;
      }
      return;
    }
    const now = this.now();
    const notification = await prisma.notification.findUnique({
      where: { id: row.notification_id },
      select: {
        id: true,
        userId: true,
        type: true,
        title: true,
        message: true,
        paymentId: true,
        booking: { select: { reference: true } },
        supportTicket: { select: { reference: true } },
      },
    });
    if (!notification) {
      await this.outbox.finish(row, { status: 'FAILED', lastError: 'notification_missing' });
      result.failed += 1;
      return;
    }
    const devices = await prisma.pushSubscription.findMany({
      where: {
        userId: notification.userId,
        session: { revokedAt: null, expiresAt: { gt: now } },
      },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
    if (devices.length === 0) {
      if (await this.outbox.finish(row, { status: 'FAILED', lastError: 'no_active_devices' })) {
        result.failed += 1;
      }
      return;
    }
    const payload = pushPayload({
      id: notification.id,
      title: notification.title,
      message: notification.message,
      url: pushTarget(notification),
    });
    const options: PushMessageOptions = {
      ttl: 24 * 60 * 60,
      topic: notification.id.replace(/-/g, '').slice(0, 32),
      urgency: notification.type === 'TRAVEL_REMINDER' ? 'normal' : 'high',
    };
    let delivered = 0;
    let transient = 0;
    let lastCode = '';
    for (const device of devices) {
      try {
        await sender.send(
          { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
          payload,
          options,
        );
        delivered += 1;
        await prisma.pushSubscription.update({
          where: { id: device.id },
          data: { lastSuccessAt: now, failureCount: 0 },
        });
      } catch (error) {
        const failure =
          error instanceof PushDeliveryError
            ? error
            : new PushDeliveryError('transient', 'unexpected_error');
        lastCode = `${failure.kind}:${failure.code}`;
        if (failure.kind === 'gone') {
          // Unsubscribed or expired at the push service: forget it.
          const removed = await prisma.pushSubscription.deleteMany({ where: { id: device.id } });
          result.removedSubscriptions += removed.count;
        } else {
          if (failure.kind === 'transient') transient += 1;
          await prisma.pushSubscription.updateMany({
            where: { id: device.id },
            data: { failureCount: { increment: 1 } },
          });
        }
        // Never the endpoint or payload: the delivery id and a safe code only.
        logger.warn(
          { deliveryId: row.id, code: failure.code, kind: failure.kind },
          'Push delivery to a device failed',
        );
      }
    }
    if (delivered > 0) {
      if (await this.outbox.finish(row, { status: 'SENT' })) result.sent += 1;
      return;
    }
    const retry = transient > 0 && row.attempts < MAX_ATTEMPTS;
    const done = await this.outbox.finish(row, {
      status: retry ? 'PENDING' : 'FAILED',
      lastError: lastCode.slice(0, 255),
      ...(retry ? { nextAttemptAt: new Date(this.now().getTime() + backoffMs(row.attempts)) } : {}),
    });
    if (done && retry) result.retried += 1;
    if (done && !retry) result.failed += 1;
  }
}
