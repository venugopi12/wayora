import type { BookingStatus as DbBookingStatus, Prisma } from '@wayora/database';
import { messages, notify } from '../notifications/notify.js';

/*
 * The booking lifecycle (docs/bookings.md#statuses, docs/payments.md#booking-and-payment),
 * shared by the booking and payment services so there is one set of rules.
 *
 *   PENDING → CONFIRMED  (system: the simulated demo confirmation; for payment
 *                         mode DEMO only after its demo payment succeeded)
 *   PENDING → EXPIRED    (system: payment mode DEMO, not paid in time)
 *   PENDING → FAILED     (system; reserved)
 *   PENDING | CONFIRMED → CANCELLED (the account holder, before travel)
 * CANCELLED, EXPIRED and FAILED are final. HELD (a supplier hold) is reserved
 * and never used.
 *
 * Demo bookings: CONFIRMED is a demo confirmation; no supplier reserved anything.
 * Supplier bookings (Phase 23, reservations.service.ts): the booking follows
 * its supplier reservation (a database trigger enforces it):
 *   PENDING → CONFIRMED  only when the supplier confirmed the reservation
 *   PENDING → FAILED     only when the reservation definitively failed
 *   CONFIRMED → CANCELLED only when the supplier confirmed the cancellation
 * While the reservation's outcome is unknown, the booking stays PENDING.
 */
export const TRANSITIONS: Record<DbBookingStatus, readonly DbBookingStatus[]> = {
  PENDING: ['CONFIRMED', 'FAILED', 'CANCELLED', 'EXPIRED'],
  HELD: [],
  CONFIRMED: ['CANCELLED'],
  CANCELLED: [],
  FAILED: [],
  EXPIRED: [],
};

export const DEMO_CONFIRMATION_NOTE =
  'Demo confirmation (simulated): Wayora did not contact a supplier, issue a ticket or take payment.';
export const DEMO_PAID_CONFIRMATION_NOTE =
  'Demo confirmation (simulated) after a demo payment: no supplier was contacted, no ticket was issued, and no real money was charged.';
export const AWAITING_PAYMENT_NOTE =
  'Demo booking requested. It is confirmed once its demo payment succeeds.';
export const EXPIRED_NOTE = 'Expired: no payment was completed in time. Nothing was charged.';
export const DEMO_CANCELLATION_NOTE =
  'Cancelled by you. Demo booking: no supplier was contacted, and nothing is refunded because nothing was paid.';
export const DEMO_PAID_CANCELLATION_NOTE =
  'Cancelled by you. Demo booking: no supplier was contacted. Its demo payment would be owed back, but the demo provider can’t refund, and no real money was charged.';

type Tx = Prisma.TransactionClient;

/** Changes a status if the lifecycle allows it AND it is still `from` (no lost updates). */
export async function transitionBooking(
  tx: Tx,
  now: Date,
  bookingId: string,
  from: DbBookingStatus,
  to: DbBookingStatus,
  event: { actorType: 'USER' | 'SYSTEM' | 'PROVIDER' | 'ADMIN'; note: string },
): Promise<boolean> {
  if (!TRANSITIONS[from].includes(to)) return false;
  const changed = await tx.booking.updateMany({
    where: { id: bookingId, status: from },
    data: {
      status: to,
      ...(to === 'CONFIRMED' ? { confirmedAt: now } : {}),
      ...(to === 'CANCELLED' ? { cancelledAt: now } : {}),
    },
  });
  if (changed.count !== 1) return false;
  await tx.bookingStatusEvent.create({
    data: { bookingId, fromStatus: from, toStatus: to, ...event, createdAt: now },
  });
  return true;
}

/**
 * Locks one booking row for the rest of the transaction (SELECT … FOR UPDATE),
 * so payment creation, expiry and payment outcomes for that booking happen one
 * at a time. Returns false if it doesn't exist.
 */
export async function lockBooking(tx: Tx, bookingId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "bookings" WHERE "id" = ${bookingId}::uuid FOR UPDATE`;
  return rows.length === 1;
}

/**
 * Expires one booking if it is still waiting for a payment past its due time
 * and no attempt is in progress (an in-progress attempt is allowed to finish;
 * the booking expires at the next check after it fails or is cancelled).
 */
export async function expireIfOverdue(tx: Tx, now: Date, bookingId: string): Promise<boolean> {
  if (!(await lockBooking(tx, bookingId))) return false;
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    select: { status: true, paymentMode: true, paymentDueAt: true },
  });
  if (
    !booking ||
    booking.status !== 'PENDING' ||
    booking.paymentMode !== 'DEMO' ||
    !booking.paymentDueAt ||
    booking.paymentDueAt.getTime() > now.getTime()
  ) {
    return false;
  }
  const active = await tx.payment.count({
    where: { bookingId, status: { in: ['CREATED', 'PENDING', 'SUCCEEDED'] } },
  });
  if (active > 0) return false;
  const expired = await transitionBooking(tx, now, bookingId, 'PENDING', 'EXPIRED', {
    actorType: 'SYSTEM',
    note: EXPIRED_NOTE,
  });
  if (expired) {
    const { reference, userId } = await tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: { reference: true, userId: true },
    });
    await notify(tx, now, {
      ...messages.bookingExpired(reference),
      userId,
      isDemo: true,
      bookingId,
      dedupeKey: `booking:${bookingId}:EXPIRED`,
    });
  }
  return expired;
}
