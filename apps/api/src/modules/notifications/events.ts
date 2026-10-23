import type { PaymentStatus as DbPaymentStatus, Prisma } from '@wayora/database';
import { formatAmount, messages, notify } from './notify.js';

/*
 * Which notification each booking or payment change produces
 * (docs/notifications.md#events). Called inside the change's transaction,
 * only after the change was applied.
 */

type Tx = Prisma.TransactionClient;

/**
 * A payment's status change. Only these produce a notification:
 *   PENDING, SUCCEEDED, FAILED, REFUNDED.
 * CANCELLED doesn't: a payment is cancelled only by its owner (or with the
 * booking they cancel), who already sees the result. A success that confirms
 * the booking produces ONE notification (the payment's), not a second
 * "booking confirmed" one for the same transition.
 */
export async function notifyPaymentChange(
  tx: Tx,
  now: Date,
  paymentId: string,
  to: DbPaymentStatus,
  demo: boolean,
  options: { eventKey: string; closedBookingStatus?: string | null },
): Promise<void> {
  if (!['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'].includes(to)) return;
  const payment = await tx.payment.findUniqueOrThrow({
    where: { id: paymentId },
    select: {
      userId: true,
      bookingId: true,
      amountMinor: true,
      currency: true,
      booking: { select: { reference: true } },
    },
  });
  const reference = payment.booking.reference;
  const amount = formatAmount(payment.amountMinor, payment.currency);
  const text =
    to === 'PENDING'
      ? messages.paymentPending(reference, amount, demo)
      : to === 'SUCCEEDED'
        ? options.closedBookingStatus
          ? messages.paymentSucceededAfterClose(
              reference,
              amount,
              demo,
              options.closedBookingStatus,
            )
          : messages.paymentSucceeded(reference, amount, demo)
        : to === 'FAILED'
          ? messages.paymentFailed(reference, amount, demo)
          : messages.paymentRefunded(reference, amount);
  await notify(tx, now, {
    ...text,
    userId: payment.userId,
    isDemo: demo,
    bookingId: payment.bookingId,
    paymentId,
    dedupeKey: `payment:${paymentId}:${options.eventKey}`,
  });
}
