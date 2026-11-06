import { z } from 'zod';
import { bookingReferenceSchema } from './bookings.js';
import { travelCategorySlugSchema } from './catalog.js';
import { moneySchema } from './money.js';
import { offsetDateTimeSchema, paginationSchema } from './search/common.js';

/*
 * Coupons and promotions (Phase 26, docs/promotions.md).
 *
 * The server owns every price: it finds promotions, checks eligibility,
 * calculates discounts (integer minor units, no floats), reserves usage and
 * confirms redemption only when a booking is paid and confirmed. Clients send
 * a coupon code and nothing else; they never send a discount or an amount.
 */

/** Coupon codes are compared upper-case without spaces: " summer 10 " → "SUMMER10". */
export function normalizeCouponCode(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/g, '').toUpperCase();
}

export const COUPON_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,23}$/;

export const couponCodeSchema = z
  .string()
  .max(40)
  .transform(normalizeCouponCode)
  .pipe(z.string().regex(COUPON_CODE_PATTERN, 'Use 3–24 letters, digits or hyphens.'));

/**
 * Why a coupon or promotion can't be used (stable codes; docs/promotions.md#eligibility).
 * They are also API error codes, so clients can branch on them.
 */
export const PROMOTION_REJECTIONS = [
  'COUPON_NOT_FOUND',
  'COUPON_EXPIRED',
  'COUPON_NOT_STARTED',
  'COUPON_INACTIVE',
  'MINIMUM_AMOUNT_NOT_MET',
  'CATEGORY_NOT_ELIGIBLE',
  'USAGE_LIMIT_REACHED',
  'USER_USAGE_LIMIT_REACHED',
  'USER_NOT_ELIGIBLE',
  'CURRENCY_NOT_SUPPORTED',
  'PROMOTION_NOT_STACKABLE',
] as const;
export const promotionRejectionSchema = z.enum(PROMOTION_REJECTIONS);
export type PromotionRejection = z.infer<typeof promotionRejectionSchema>;

export const promotionKindSchema = z.enum(['coupon', 'automatic']);
export const discountTypeSchema = z.enum(['percentage', 'fixed']);
export type DiscountType = z.infer<typeof discountTypeSchema>;

const minor = z.string().regex(/^[1-9]\d{0,12}$/, 'Use whole minor units above zero.');

// ─── Admin configuration ──────────────────────────────────────────────────

const promotionFields = z.object({
  kind: promotionKindSchema,
  /** Coupons only; normalized. */
  code: couponCodeSchema.optional(),
  name: z.string().trim().min(3).max(80),
  /** One line for listings, e.g. "10% off hotels, up to ₹1,000". */
  description: z.string().trim().min(3).max(255),
  /** Shown with the offer; plain text. */
  terms: z.string().trim().min(10).max(2000),
  discountType: discountTypeSchema,
  /** Percentage in basis points (1000 = 10%), for `percentage`. */
  percentBps: z.number().int().min(1).max(9_000).optional(),
  /** Minor units, for `fixed`. */
  amountMinor: minor.optional(),
  /** Cap for `percentage` (minor units). */
  maxDiscountMinor: minor.optional(),
  /** The eligible amount must be at least this (minor units, 0 = none). */
  minAmountMinor: z
    .string()
    .regex(/^(0|[1-9]\d{0,12})$/)
    .default('0'),
  /** All money fields are in this currency; bookings in another currency aren't eligible. */
  currency: z.string().regex(/^[A-Z]{3}$/),
  /** Empty = every category. */
  categories: z.array(travelCategorySlugSchema).max(7).default([]),
  startsAt: offsetDateTimeSchema,
  endsAt: offsetDateTimeSchema,
  /** Total confirmed-or-reserved uses allowed (null = no limit). */
  usageLimit: z.number().int().min(1).max(10_000_000).nullable().default(null),
  /** Uses per customer (null = no limit). */
  perUserLimit: z.number().int().min(1).max(1_000).nullable().default(1),
  /** Only customers without a confirmed booking yet. */
  firstBookingOnly: z.boolean().default(false),
  /** Only this customer (a personal offer). */
  userId: z.uuid().nullable().default(null),
  /** Coupons: may combine with an automatic promotion (applied after it). */
  stackable: z.boolean().default(false),
  /** Listed on the promotions page (personal offers never are). */
  listed: z.boolean().default(true),
  active: z.boolean().default(true),
});

function checkPromotion(p: z.output<typeof promotionFields>, ctx: z.RefinementCtx) {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  if (p.kind === 'coupon' && !p.code) issue('code', 'A coupon needs a code.');
  if (p.kind === 'automatic' && p.code) issue('code', 'Automatic promotions have no code.');
  if (p.kind === 'automatic' && p.stackable) {
    issue('stackable', 'Only coupons can be stackable (they apply after an automatic promotion).');
  }
  if (p.discountType === 'percentage') {
    if (p.percentBps === undefined) issue('percentBps', 'Give the percentage.');
    if (p.amountMinor !== undefined)
      issue('amountMinor', 'A percentage discount has no fixed amount.');
  } else {
    if (p.amountMinor === undefined) issue('amountMinor', 'Give the amount.');
    if (p.percentBps !== undefined) issue('percentBps', 'A fixed discount has no percentage.');
    if (p.maxDiscountMinor !== undefined) {
      issue('maxDiscountMinor', 'A fixed discount is its own maximum.');
    }
  }
  if (Date.parse(p.endsAt) <= Date.parse(p.startsAt)) issue('endsAt', 'Must be after the start.');
  if (Date.parse(p.endsAt) - Date.parse(p.startsAt) > 2 * 366 * 24 * 3600 * 1000) {
    issue('endsAt', 'A promotion can run for at most two years.');
  }
  if (p.userId && p.listed) issue('listed', 'Personal offers can’t be listed publicly.');
  if (p.usageLimit !== null && p.perUserLimit !== null && p.perUserLimit > p.usageLimit) {
    issue('perUserLimit', 'Can’t be more than the total limit.');
  }
}

export const adminPromotionInputSchema = promotionFields.strict().superRefine(checkPromotion);
export type AdminPromotionInput = z.input<typeof adminPromotionInputSchema>;

/** Editing: the kind and code can't change once created (usage history refers to them). */
export const adminPromotionUpdateSchema = promotionFields
  .omit({ kind: true, code: true })
  .extend({ reason: z.string().trim().min(10).max(500) })
  .strict();
export type AdminPromotionUpdate = z.input<typeof adminPromotionUpdateSchema>;

export const adminPromotionStatusSchema = z
  .object({ active: z.boolean(), reason: z.string().trim().min(10).max(500) })
  .strict();

// ─── Shapes returned ──────────────────────────────────────────────────────

const offerFields = {
  id: z.uuid(),
  kind: promotionKindSchema,
  /** Only for listed coupons and the customer's own personal coupons. */
  code: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  terms: z.string(),
  discountType: discountTypeSchema,
  percentBps: z.number().int().nullable(),
  amount: moneySchema.nullable(),
  maxDiscount: moneySchema.nullable(),
  minAmount: moneySchema.nullable(),
  categories: z.array(travelCategorySlugSchema),
  startsAt: offsetDateTimeSchema,
  endsAt: offsetDateTimeSchema,
  firstBookingOnly: z.boolean(),
  stackable: z.boolean(),
  /** A personal offer for the signed-in customer (still checked at checkout). */
  personal: z.boolean(),
};

/** GET /promotions: active offers (eligibility is only checked at checkout). */
export const promotionOfferSchema = z.object(offerFields);
export type PromotionOffer = z.infer<typeof promotionOfferSchema>;
export const promotionListSchema = z.object({ items: z.array(promotionOfferSchema) });

export const appliedPromotionSchema = z.object({
  promotionId: z.uuid(),
  kind: promotionKindSchema,
  code: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  discount: moneySchema,
  /** `reserved`: held for this checkout until it is paid (or released); `redeemed`: paid and confirmed. */
  status: z.enum(['reserved', 'redeemed']),
  reservedUntil: offsetDateTimeSchema.nullable(),
});
export type AppliedPromotion = z.infer<typeof appliedPromotionSchema>;

/**
 * The authoritative price breakdown of a booking (GET /bookings/:reference/pricing),
 * in this order: original → promotions → points → travel credit → payable.
 */
export const bookingPricingSchema = z.object({
  demo: z.boolean(),
  /** The offer price as booked (never changed by promotions). */
  original: moneySchema.nullable(),
  promotions: z.array(appliedPromotionSchema),
  promotionDiscount: moneySchema.nullable(),
  /** After promotions: what points and credit apply to. */
  afterPromotions: moneySchema.nullable(),
  points: z.object({ points: z.number().int(), amount: moneySchema }).nullable(),
  credit: moneySchema.nullable(),
  /** What the payment must be for. */
  payable: moneySchema.nullable(),
  /** Whether a coupon can be applied or removed now, and why not. */
  canChangePromotions: z.boolean(),
  reason: z.string().nullable(),
  /** A change the customer should know about (e.g. a coupon that stopped being valid). */
  notice: z.object({ code: z.string(), message: z.string(), at: offsetDateTimeSchema }).nullable(),
});
export type BookingPricing = z.infer<typeof bookingPricingSchema>;

export const applyCouponSchema = z.object({ code: z.string().trim().min(1).max(40) }).strict();
export type ApplyCoupon = z.infer<typeof applyCouponSchema>;

// ─── Admin views ──────────────────────────────────────────────────────────

export const adminPromotionSchema = z.object({
  ...offerFields,
  currency: z.string(),
  usageLimit: z.number().int().nullable(),
  perUserLimit: z.number().int().nullable(),
  /** Personal offer: the customer's id (no other details). */
  userId: z.uuid().nullable(),
  listed: z.boolean(),
  active: z.boolean(),
  /** Increments with every change (redemptions record the version they used). */
  version: z.number().int(),
  createdAt: offsetDateTimeSchema,
  updatedAt: offsetDateTimeSchema,
  usage: z.object({
    reserved: z.number().int(),
    redeemed: z.number().int(),
    released: z.number().int(),
    reversed: z.number().int(),
    /** Discount given on redeemed (paid and confirmed) bookings. */
    redeemedDiscount: moneySchema,
    /** Original price of those bookings. */
    redeemedBookingValue: moneySchema,
  }),
  /** Live: running now and active. */
  state: z.enum(['scheduled', 'running', 'ended', 'inactive']),
});
export type AdminPromotion = z.infer<typeof adminPromotionSchema>;

export const adminPromotionListQuerySchema = z
  .object({
    state: z.enum(['scheduled', 'running', 'ended', 'inactive']).optional(),
    kind: promotionKindSchema.optional(),
    q: z.string().trim().max(80).optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type AdminPromotionListQuery = z.input<typeof adminPromotionListQuerySchema>;

export const adminPromotionListSchema = z.object({
  items: z.array(adminPromotionSchema),
  pagination: paginationSchema,
});
export type AdminPromotionList = z.infer<typeof adminPromotionListSchema>;

export const promotionRedemptionStatusSchema = z.enum([
  'reserved',
  'redeemed',
  'released',
  'reversed',
]);

export const adminPromotionUsageSchema = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      status: promotionRedemptionStatusSchema,
      /** The booking (no customer details). */
      bookingReference: bookingReferenceSchema,
      discount: moneySchema,
      eligibleAmount: moneySchema,
      promotionVersion: z.number().int(),
      createdAt: offsetDateTimeSchema,
      redeemedAt: offsetDateTimeSchema.nullable(),
      closedAt: offsetDateTimeSchema.nullable(),
      closeReason: z.string().nullable(),
    }),
  ),
  pagination: paginationSchema,
});
export type AdminPromotionUsage = z.infer<typeof adminPromotionUsageSchema>;
export const adminPromotionUsageQuerySchema = z
  .object({
    status: promotionRedemptionStatusSchema.optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
