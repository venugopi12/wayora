import type { NotificationType as DbNotificationType, Prisma } from '@wayora/database';

/*
 * Creating notifications (docs/notifications.md#events).
 *
 * `notify` runs INSIDE the transaction that makes the state change it
 * reports, so both commit together or neither does: a notification can't
 * exist for a change that was rolled back, and a committed change can't lose
 * its notification. Callers invoke it only after their conditional update
 * actually changed a row (a transition that didn't happen notifies nobody).
 *
 * One event, one notification: `dedupeKey` is unique, and the insert uses
 * ON CONFLICT DO NOTHING, so a retried or replayed event adds nothing (and
 * doesn't abort the surrounding transaction).
 *
 * The optional email and browser push are queued in the same transaction as
 * outbox rows (notification_deliveries, one per channel), which the worker
 * processes later. Whether they are queued depends on the user's preferences
 * (and, for push, on a signed-in device having push on); the in-app
 * notification is always kept.
 */

type Tx = Prisma.TransactionClient;

export interface NotifyInput {
  userId: string;
  type: DbNotificationType;
  title: string;
  message: string;
  isDemo: boolean;
  bookingId?: string | null;
  paymentId?: string | null;
  /** Planner notifications (Phase 19): the plan or invitation they're about. */
  plannedTripId?: string | null;
  tripInvitationId?: string | null;
  /** Support notifications (Phase 27): the ticket they're about. */
  supportTicketId?: string | null;
  dedupeKey: string;
}

/**
 * Which email preference covers each emailed type. Planner notifications
 * (Phase 19) are in-app only (docs/planner.md#notifications), so they have none.
 */
const CATEGORY: Partial<
  Record<DbNotificationType, 'emailBookings' | 'emailPayments' | 'emailReminders'>
> = {
  BOOKING_CREATED: 'emailBookings',
  BOOKING_CONFIRMED: 'emailBookings',
  BOOKING_CANCELLED: 'emailBookings',
  BOOKING_EXPIRED: 'emailBookings',
  BOOKING_FAILED: 'emailBookings',
  PAYMENT_PENDING: 'emailPayments',
  PAYMENT_SUCCEEDED: 'emailPayments',
  PAYMENT_FAILED: 'emailPayments',
  PAYMENT_REFUNDED: 'emailPayments',
  TRAVEL_REMINDER: 'emailReminders',
  // A trip change is about the booking (Phase 17).
  TRIP_DISRUPTION: 'emailBookings',
};

/** Events worth an email; "processing" updates stay in-app only. */
const EMAILED = new Set<DbNotificationType>([
  'BOOKING_CREATED',
  'BOOKING_CONFIRMED',
  'BOOKING_CANCELLED',
  'BOOKING_EXPIRED',
  'BOOKING_FAILED',
  'PAYMENT_SUCCEEDED',
  'PAYMENT_FAILED',
  'PAYMENT_REFUNDED',
  'TRAVEL_REMINDER',
  'TRIP_DISRUPTION',
]);

/**
 * Which push preference covers each pushed type (Phase 30, docs/pwa.md#push).
 * "Processing" updates, plan activity and staff queue alerts stay in-app.
 */
const PUSH_CATEGORY: Partial<
  Record<
    DbNotificationType,
    'pushBookings' | 'pushPayments' | 'pushReminders' | 'pushSupport' | 'pushRewards'
  >
> = {
  BOOKING_CREATED: 'pushBookings',
  BOOKING_CONFIRMED: 'pushBookings',
  BOOKING_CANCELLED: 'pushBookings',
  BOOKING_EXPIRED: 'pushBookings',
  BOOKING_FAILED: 'pushBookings',
  TRIP_DISRUPTION: 'pushBookings',
  PAYMENT_SUCCEEDED: 'pushPayments',
  PAYMENT_FAILED: 'pushPayments',
  PAYMENT_REFUNDED: 'pushPayments',
  TRAVEL_REMINDER: 'pushReminders',
  SUPPORT_TICKET: 'pushSupport',
  REWARDS: 'pushRewards',
};

/** Creates the notification (once per dedupe key) and queues its email. Returns whether it was new. */
export async function notify(tx: Tx, now: Date, input: NotifyInput): Promise<boolean> {
  const created = await tx.notification.createManyAndReturn({
    data: [
      {
        userId: input.userId,
        type: input.type,
        title: input.title.slice(0, 120),
        message: input.message.slice(0, 500),
        isDemo: input.isDemo,
        bookingId: input.bookingId ?? null,
        paymentId: input.paymentId ?? null,
        plannedTripId: input.plannedTripId ?? null,
        tripInvitationId: input.tripInvitationId ?? null,
        supportTicketId: input.supportTicketId ?? null,
        dedupeKey: input.dedupeKey,
        createdAt: now,
      },
    ],
    skipDuplicates: true,
    select: { id: true },
  });
  const notification = created[0];
  if (!notification) return false;
  const preference = CATEGORY[input.type];
  const pushPreference = PUSH_CATEGORY[input.type];
  if (!(EMAILED.has(input.type) && preference) && !pushPreference) return true;
  // No row: the defaults (on).
  const preferences = await tx.notificationPreference.findUnique({
    where: { userId: input.userId },
  });
  if (EMAILED.has(input.type) && preference && preferences?.[preference] !== false) {
    await tx.notificationDelivery.create({
      data: { notificationId: notification.id, channel: 'EMAIL', nextAttemptAt: now },
    });
  }
  // Push only when some device of theirs has it on, in a session that's still signed in.
  if (pushPreference && preferences?.[pushPreference] !== false) {
    const devices = await tx.pushSubscription.count({
      where: {
        userId: input.userId,
        session: { revokedAt: null, expiresAt: { gt: now } },
      },
    });
    if (devices > 0) {
      await tx.notificationDelivery.create({
        data: { notificationId: notification.id, channel: 'PUSH', nextAttemptAt: now },
      });
    }
  }
  return true;
}

// ─── Wording ─────────────────────────────────────────────────────────────

/** "₹23,400" (exact minor units, no float arithmetic on the amount). */
export function formatAmount(amountMinor: bigint, currency: string): string {
  const whole = amountMinor / 100n;
  const fraction = amountMinor % 100n;
  const format = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: fraction === 0n ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return fraction === 0n
    ? format.format(Number(whole))
    : format.format(Number(`${whole}.${fraction.toString().padStart(2, '0')}`));
}

const timeFormat = new Intl.DateTimeFormat('en-IN', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
});

const DEMO_BOOKING = 'Demo booking: no supplier was contacted and no ticket was issued.';

export const messages = {
  bookingAwaitingPayment: (reference: string, dueAt: Date) => ({
    type: 'BOOKING_CREATED' as const,
    title: 'Demo booking saved: payment needed',
    message: `Booking ${reference} is saved. Complete its demo payment by ${timeFormat.format(dueAt)} (India time) to confirm it. ${DEMO_BOOKING}`,
  }),
  bookingConfirmed: (reference: string) => ({
    type: 'BOOKING_CONFIRMED' as const,
    title: 'Demo booking confirmed',
    message: `Booking ${reference} has a demo confirmation. ${DEMO_BOOKING} Nothing was charged.`,
  }),
  bookingCancelled: (reference: string, paid: boolean) => ({
    type: 'BOOKING_CANCELLED' as const,
    title: 'Demo booking cancelled',
    message: paid
      ? `Booking ${reference} is cancelled. Its demo payment would be owed back, but the demo provider can’t refund; no real money was charged.`
      : `Booking ${reference} is cancelled. No supplier was contacted, and nothing was charged.`,
  }),
  bookingExpired: (reference: string) => ({
    type: 'BOOKING_EXPIRED' as const,
    title: 'Demo booking expired',
    message: `Booking ${reference} expired because its payment wasn’t completed in time. Nothing was charged.`,
  }),
  // Supplier bookings (Phase 23): real reservations, so no demo wording. The
  // supplier's own text is never used; only its name and reference.
  supplierBookingRequested: (reference: string, supplier: string) => ({
    type: 'BOOKING_CREATED' as const,
    title: 'Booking requested',
    message: `Booking ${reference} was sent to ${supplier}. It is confirmed only when ${supplier} confirms it; we’ll tell you when it does.`,
  }),
  supplierBookingConfirmed: (reference: string, supplier: string, supplierReference: string) => ({
    type: 'BOOKING_CONFIRMED' as const,
    title: 'Booking confirmed',
    message: `${supplier} confirmed booking ${reference}. Its reference is ${supplierReference}.`,
  }),
  supplierBookingFailed: (reference: string, supplier: string) => ({
    type: 'BOOKING_FAILED' as const,
    title: 'Booking not confirmed',
    message: `${supplier} didn’t confirm booking ${reference}, so nothing was reserved. Wayora took no payment.`,
  }),
  supplierBookingCancelled: (reference: string, supplier: string) => ({
    type: 'BOOKING_CANCELLED' as const,
    title: 'Booking cancelled',
    message: `${supplier} confirmed the cancellation of booking ${reference}. Any refund of what you paid ${supplier} follows ${supplier}’s own terms.`,
  }),
  paymentPending: (reference: string, amount: string, demo: boolean) => ({
    type: 'PAYMENT_PENDING' as const,
    title: demo ? 'Demo payment processing' : 'Payment processing',
    message: demo
      ? `The demo payment of ${amount} for booking ${reference} is being processed (simulated; no real money moves).`
      : `The payment of ${amount} for booking ${reference} is being processed.`,
  }),
  paymentSucceeded: (reference: string, amount: string, demo: boolean) => ({
    type: 'PAYMENT_SUCCEEDED' as const,
    title: demo ? 'Demo payment succeeded' : 'Payment received',
    message: demo
      ? `Demo payment of ${amount} for booking ${reference} succeeded. No real money was charged. The booking has a demo confirmation; no supplier was contacted.`
      : `Payment of ${amount} for booking ${reference} succeeded.`,
  }),
  paymentSucceededAfterClose: (
    reference: string,
    amount: string,
    demo: boolean,
    bookingStatus: string,
  ) => ({
    type: 'PAYMENT_SUCCEEDED' as const,
    title: demo
      ? 'Demo payment completed after the booking closed'
      : 'Payment completed after the booking closed',
    message: demo
      ? `The demo payment of ${amount} for booking ${reference} succeeded after the booking was ${bookingStatus}, so the booking stays ${bookingStatus}. A refund would be owed, but the demo provider can’t refund; no real money was charged.`
      : `The payment of ${amount} for booking ${reference} succeeded after the booking was ${bookingStatus}. A refund is required.`,
  }),
  paymentFailed: (reference: string, amount: string, demo: boolean) => ({
    type: 'PAYMENT_FAILED' as const,
    title: demo ? 'Demo payment declined' : 'Payment didn’t go through',
    message: demo
      ? `The demo payment of ${amount} for booking ${reference} didn’t go through (simulated). Nothing was charged. You can try again while the booking can still be paid.`
      : `The payment of ${amount} for booking ${reference} didn’t go through. Nothing was charged.`,
  }),
  paymentRefunded: (reference: string, amount: string) => ({
    type: 'PAYMENT_REFUNDED' as const,
    title: 'Refund confirmed',
    message: `The payment provider confirmed the refund of ${amount} for booking ${reference}.`,
  }),
};
