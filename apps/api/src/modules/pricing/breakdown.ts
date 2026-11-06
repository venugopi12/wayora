import type { Prisma } from '@wayora/database';

/*
 * The price of a booking, in one fixed order (docs/promotions.md#calculation):
 *
 *   1. original      the offer price as booked (bookings.total_amount_minor; never changed)
 *   2. promotions    automatic promotion, then coupon (open promotion_redemptions)
 *   3. points        loyalty points applied at checkout (Phase 25)
 *   4. travel credit applied at checkout (Phase 25)
 *   5. payable       what the payment must be for
 *
 * Promotions, rewards and payments all read these figures from here, so no
 * route computes a price on its own. Call inside a transaction that has
 * locked the booking (lockBooking) when the result decides a write.
 */

type Tx = Prisma.TransactionClient;

const OPEN = ['RESERVED', 'REDEEMED'] as const;

/** Step 2: the discount of the booking's live promotions. */
export async function promotionDiscountMinor(tx: Tx, bookingId: string): Promise<bigint> {
  const sum = await tx.promotionRedemption.aggregate({
    where: { bookingId, status: { in: [...OPEN] } },
    _sum: { discountMinor: true },
  });
  return sum._sum.discountMinor ?? 0n;
}

/** Steps 3–4: points and credit set against the booking (Phase 25 redemption). */
export async function rewardsAppliedMinor(tx: Tx, bookingId: string): Promise<bigint> {
  const open = await tx.rewardRedemption.findFirst({
    where: { bookingId, status: { in: ['APPLIED', 'CONSUMED'] } },
    select: { totalAmountMinor: true },
  });
  return open?.totalAmountMinor ?? 0n;
}

/** What points and credit are measured against: the total after promotions. */
export async function afterPromotionsMinor(
  tx: Tx,
  bookingId: string,
  totalMinor: bigint,
): Promise<bigint> {
  return totalMinor - (await promotionDiscountMinor(tx, bookingId));
}

/** Step 5: what a payment for an unpaid booking must be for. */
export async function payableMinor(tx: Tx, bookingId: string, totalMinor: bigint): Promise<bigint> {
  const [promotions, rewards] = await Promise.all([
    promotionDiscountMinor(tx, bookingId),
    tx.rewardRedemption.findFirst({
      where: { bookingId, status: 'APPLIED' },
      select: { totalAmountMinor: true },
    }),
  ]);
  return totalMinor - promotions - (rewards?.totalAmountMinor ?? 0n);
}
