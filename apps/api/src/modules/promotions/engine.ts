import type { PromotionRejection, TravelCategorySlug } from '@wayora/contracts';

/*
 * The promotion engine's pure rules (docs/promotions.md#calculation). No
 * database, clock or floating point: callers pass the facts and `now`.
 * Every amount is an integer of minor units (BigInt); percentages are basis
 * points; division rounds down, so a discount is never more than the rule says.
 */

/** A booking always keeps at least this much to pay (zero-amount payments aren't supported). */
export const MIN_PAYABLE_MINOR = 100n;

export interface PromotionRule {
  id: string;
  kind: 'COUPON' | 'AUTOMATIC';
  discountType: 'PERCENTAGE' | 'FIXED';
  percentBps: number | null;
  amountMinor: bigint | null;
  maxDiscountMinor: bigint | null;
  minAmountMinor: bigint;
  currency: string;
  /** Empty = every category. */
  categories: readonly TravelCategorySlug[];
  startsAt: Date;
  endsAt: Date;
  active: boolean;
  firstBookingOnly: boolean;
  /** A personal offer for this customer only. */
  userId: string | null;
  stackable: boolean;
  createdAt: Date;
}

/**
 * The discount on `eligibleMinor`:
 *   percentage: floor(eligible × bps / 10000), then at most maxDiscount
 *   fixed:      the amount
 * then at most eligible − MIN_PAYABLE_MINOR, so the total never reaches zero
 * or goes negative. 0 means "nothing to take off".
 */
export function discountFor(rule: PromotionRule, eligibleMinor: bigint): bigint {
  if (eligibleMinor <= MIN_PAYABLE_MINOR) return 0n;
  let d =
    rule.discountType === 'PERCENTAGE'
      ? (eligibleMinor * BigInt(rule.percentBps ?? 0)) / 10_000n
      : (rule.amountMinor ?? 0n);
  if (rule.maxDiscountMinor !== null && d > rule.maxDiscountMinor) d = rule.maxDiscountMinor;
  const cap = eligibleMinor - MIN_PAYABLE_MINOR;
  if (d > cap) d = cap;
  return d > 0n ? d : 0n;
}

export interface BookingFacts {
  now: Date;
  userId: string;
  currency: string;
  category: TravelCategorySlug;
  /** What the promotion would be calculated on. */
  eligibleMinor: bigint;
}

/**
 * The checks that need nothing but the promotion and the booking, in a fixed
 * order (the first failure is reported): status, dates, personal offer,
 * currency, category, minimum amount. Usage limits and first-booking checks
 * need the database (promotions.service.ts).
 */
export function staticRejection(
  rule: PromotionRule,
  facts: BookingFacts,
): PromotionRejection | null {
  // Someone else's personal offer: as if it didn't exist (never confirm it does).
  if (rule.userId !== null && rule.userId !== facts.userId) return 'COUPON_NOT_FOUND';
  if (!rule.active) return 'COUPON_INACTIVE';
  if (facts.now.getTime() < rule.startsAt.getTime()) return 'COUPON_NOT_STARTED';
  if (facts.now.getTime() >= rule.endsAt.getTime()) return 'COUPON_EXPIRED';
  if (rule.currency !== facts.currency) return 'CURRENCY_NOT_SUPPORTED';
  if (rule.categories.length > 0 && !rule.categories.includes(facts.category)) {
    return 'CATEGORY_NOT_ELIGIBLE';
  }
  if (facts.eligibleMinor < rule.minAmountMinor || discountFor(rule, facts.eligibleMinor) === 0n) {
    return 'MINIMUM_AMOUNT_NOT_MET';
  }
  return null;
}

/**
 * Automatic promotions in the order they are tried: the largest discount
 * first, then the one ending soonest, then the oldest, then by id, so the
 * same facts always pick the same promotion.
 */
export function rankAutomatic<T extends { rule: PromotionRule; discount: bigint }>(
  candidates: readonly T[],
): T[] {
  return [...candidates].sort((a, b) => {
    if (a.discount !== b.discount) return a.discount > b.discount ? -1 : 1;
    const end = a.rule.endsAt.getTime() - b.rule.endsAt.getTime();
    if (end !== 0) return end;
    const created = a.rule.createdAt.getTime() - b.rule.createdAt.getTime();
    if (created !== 0) return created;
    return a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0;
  });
}

/** Wayora's words for each rejection: safe to show, revealing nothing about other customers. */
export const REJECTION_MESSAGE: Record<PromotionRejection, string> = {
  COUPON_NOT_FOUND: 'We don’t recognise that code. Check it and try again.',
  COUPON_EXPIRED: 'This code has expired.',
  COUPON_NOT_STARTED: 'This code isn’t valid yet.',
  COUPON_INACTIVE: 'This code isn’t active.',
  MINIMUM_AMOUNT_NOT_MET: 'This booking doesn’t reach the minimum amount for this code.',
  CATEGORY_NOT_ELIGIBLE: 'This code can’t be used on this kind of booking.',
  USAGE_LIMIT_REACHED: 'This code has reached its usage limit.',
  USER_USAGE_LIMIT_REACHED: 'You’ve already used this code as many times as it allows.',
  USER_NOT_ELIGIBLE: 'Your account isn’t eligible for this code.',
  CURRENCY_NOT_SUPPORTED: 'This code can’t be used on bookings in this currency.',
  PROMOTION_NOT_STACKABLE:
    'This code can’t be combined with the offer already applied, and doesn’t take more off.',
};
