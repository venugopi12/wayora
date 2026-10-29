import type { Prisma, RefundReason, RefundStatus } from '@wayora/database';
import type { ProviderEventType } from './providers/types.js';

/*
 * Refunds (Phase 23, docs/payments.md#refunds): one row per refund of one
 * payment, tracked apart from the payment and the booking.
 *
 * - Amount and currency are always the payment's own (a trigger checks it);
 *   no refund amount is ever taken from a request.
 * - At most one refund in flight (or done) per payment: a partial unique
 *   index. Creating one twice changes nothing.
 * - REQUIRED: owed, but the payment's provider can't refund (the demo
 *   provider: no money was taken). Nothing is sent; nothing is claimed.
 * - REQUESTED → (provider) PENDING → SUCCEEDED | FAILED. A call without a
 *   definitive answer is UNKNOWN: Wayora asks the provider what happened
 *   (retrieve) before sending again, and sends again only with the same
 *   refund id, which providers must de-duplicate by (PaymentProvider.refund).
 * - Only a provider event marks a refund SUCCEEDED.
 */

type Tx = Prisma.TransactionClient;

/** Open refunds: not settled yet. */
export const OPEN_REFUND: RefundStatus[] = ['REQUESTED', 'PENDING', 'UNKNOWN'];

/**
 * Records refunds for a booking's successful payments (inside the
 * transaction that makes them owed). Returns the ids of those to send.
 */
export async function openRefunds(
  tx: Tx,
  now: Date,
  filter: { bookingId: string; paymentId?: string },
  reason: RefundReason,
  canRefund: (providerId: string) => boolean,
): Promise<string[]> {
  const paid = await tx.payment.findMany({
    where: {
      bookingId: filter.bookingId,
      ...(filter.paymentId ? { id: filter.paymentId } : {}),
      status: 'SUCCEEDED',
    },
  });
  if (paid.length === 0) return [];
  await tx.refund.createMany({
    data: paid.map((p) => {
      const capable = canRefund(p.provider);
      return {
        paymentId: p.id,
        bookingId: p.bookingId,
        userId: p.userId,
        provider: p.provider,
        mode: p.mode,
        status: capable ? ('REQUESTED' as const) : ('REQUIRED' as const),
        reason,
        amountMinor: p.amountMinor,
        currency: p.currency,
        nextAttemptAt: capable ? now : null,
        createdAt: now,
        updatedAt: now,
      };
    }),
    // One open refund per payment (partial unique index): a repeat is a no-op.
    skipDuplicates: true,
  });
  const toSend = await tx.refund.findMany({
    where: { paymentId: { in: paid.map((p) => p.id) }, status: 'REQUESTED' },
    select: { id: true },
  });
  return toSend.map((r) => r.id);
}

const REFUND_EVENT: Partial<Record<ProviderEventType, RefundStatus>> = {
  'refund.pending': 'PENDING',
  'refund.succeeded': 'SUCCEEDED',
  'refund.failed': 'FAILED',
};

/** Applies a provider's refund event to the payment's open refund (inside the event's transaction). */
export async function applyRefundEvent(
  tx: Tx,
  now: Date,
  paymentId: string,
  type: ProviderEventType,
  failureCode: string | undefined,
): Promise<void> {
  const target = REFUND_EVENT[type];
  if (!target) return;
  const final = target === 'SUCCEEDED' || target === 'FAILED';
  await tx.refund.updateMany({
    where: {
      paymentId,
      status: { in: target === 'PENDING' ? ['REQUESTED', 'UNKNOWN'] : OPEN_REFUND },
    },
    data: {
      status: target,
      updatedAt: now,
      ...(final ? { completedAt: now, nextAttemptAt: null, needsAttention: false } : {}),
      ...(target === 'FAILED'
        ? { failureCode: (failureCode ?? 'refund_failed').slice(0, 64) }
        : {}),
      // A pending refund is looked at again later (retrieve) until it settles.
      ...(target === 'PENDING' ? { nextAttemptAt: new Date(now.getTime() + 5 * 60_000) } : {}),
    },
  });
}
