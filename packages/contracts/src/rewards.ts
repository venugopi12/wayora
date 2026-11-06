import { z } from 'zod';
import { bookingReferenceSchema } from './bookings.js';
import { travelCategorySlugSchema } from './catalog.js';
import { moneySchema } from './money.js';
import { isoDateSchema, offsetDateTimeSchema, paginationSchema } from './search/common.js';

/*
 * Loyalty points, tiers and travel credits (Phase 25, docs/rewards.md).
 *
 * Every number that decides a reward lives in a versioned rule set
 * (`loyaltyRulesSchema`), stored in the database and chosen by the server.
 * Clients only ever see results: the server calculates every point, discount
 * and payable amount. Money is integer minor units as strings (money.ts);
 * points are whole numbers; multipliers are basis points (10000 = ×1).
 */

const minorString = z.string().regex(/^(0|[1-9]\d{0,14})$/, 'Use whole minor units.');
const positiveMinor = z.string().regex(/^[1-9]\d{0,14}$/, 'Use whole minor units above zero.');
const bps = z.number().int().min(0).max(100_000);
const currencyMap = <T extends z.ZodType>(value: T) =>
  z.record(z.string().regex(/^[A-Z]{3}$/), value);

export const loyaltyTierRuleSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
  name: z.string().trim().min(1).max(40),
  /** Qualifying points needed in the qualification period. */
  minQualifyingPoints: z.number().int().min(0).max(10_000_000),
  /** Applied to earned points (10000 = ×1). */
  earnMultiplierBps: bps.min(10_000),
});
export type LoyaltyTierRule = z.infer<typeof loyaltyTierRuleSchema>;

export const loyaltyCampaignSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/),
  name: z.string().trim().min(1).max(80),
  /** Categories it applies to; empty = all. */
  categories: z.array(travelCategorySlugSchema).max(7),
  /** Bookings confirmed in [startsAt, endsAt) earn the bonus. */
  startsAt: offsetDateTimeSchema,
  endsAt: offsetDateTimeSchema,
  /** Extra earning on top of the base (5000 = +50%). */
  bonusBps: bps.min(1),
});
export type LoyaltyCampaign = z.infer<typeof loyaltyCampaignSchema>;

export const loyaltyRulesSchema = z
  .object({
    earn: z.object({
      /** Spend (minor units, per currency) that earns one base point. Missing currency: no earning. */
      spendMinorPerPoint: currencyMap(positiveMinor),
      /** Per category (10000 = ×1, 0 = no earning). */
      categoryMultiplierBps: z.record(travelCategorySlugSchema, bps),
      campaigns: z.array(loyaltyCampaignSchema).max(20),
      /** Points become available this many days after the trip ends. */
      availableAfterDays: z.number().int().min(0).max(60),
      /** Earned points expire this many months after they become available. */
      expiryMonths: z.number().int().min(1).max(120),
    }),
    redeem: z.object({
      /** Value of one point in minor units, per currency. Missing currency: no redemption. */
      pointValueMinor: currencyMap(positiveMinor),
      minPoints: z.number().int().min(1).max(1_000_000),
      maxPointsPerBooking: z.number().int().min(1).max(10_000_000),
      /** Points may pay at most this share of a booking's total (5000 = 50%). */
      maxPointsCoverageBps: bps.min(1).max(10_000),
      /** At least this much is always left to pay (payments of zero aren't supported). */
      minCashMinor: currencyMap(minorString),
      categories: z.array(travelCategorySlugSchema).min(1).max(7),
    }),
    tiers: z.array(loyaltyTierRuleSchema).min(1).max(8),
    /** Rolling window for qualifying points; also how long a reached tier is kept. */
    qualificationMonths: z.number().int().min(1).max(36),
  })
  .superRefine((rules, ctx) => {
    const tiers = rules.tiers;
    if (tiers[0]!.minQualifyingPoints !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['tiers', 0],
        message: 'The first tier must need 0 qualifying points.',
      });
    }
    for (let i = 1; i < tiers.length; i += 1) {
      if (tiers[i]!.minQualifyingPoints <= tiers[i - 1]!.minQualifyingPoints) {
        ctx.addIssue({
          code: 'custom',
          path: ['tiers', i],
          message: 'Tiers must need strictly more qualifying points than the one before.',
        });
      }
    }
    if (new Set(tiers.map((t) => t.id)).size !== tiers.length) {
      ctx.addIssue({ code: 'custom', path: ['tiers'], message: 'Tier ids must be unique.' });
    }
    if (rules.redeem.minPoints > rules.redeem.maxPointsPerBooking) {
      ctx.addIssue({
        code: 'custom',
        path: ['redeem', 'maxPointsPerBooking'],
        message: 'Must be at least the minimum redemption.',
      });
    }
    rules.earn.campaigns.forEach((c, i) => {
      if (Date.parse(c.endsAt) <= Date.parse(c.startsAt)) {
        ctx.addIssue({
          code: 'custom',
          path: ['earn', 'campaigns', i, 'endsAt'],
          message: 'A campaign must end after it starts.',
        });
      }
    });
  });
export type LoyaltyRules = z.infer<typeof loyaltyRulesSchema>;

/**
 * The rules shipped with the migration (version 1). Kept here so the
 * migration, tests and docs describe the same numbers (docs/rewards.md#rules).
 */
export const DEFAULT_LOYALTY_RULES: LoyaltyRules = {
  earn: {
    // ₹10 of eligible spend = 1 base point.
    spendMinorPerPoint: { INR: '1000' },
    categoryMultiplierBps: {
      flights: 10_000,
      hotels: 10_000,
      trains: 10_000,
      buses: 10_000,
      metro: 10_000,
      cabs: 10_000,
      holidays: 10_000,
    },
    campaigns: [],
    availableAfterDays: 1,
    expiryMonths: 24,
  },
  redeem: {
    // 1 point = ₹0.25.
    pointValueMinor: { INR: '25' },
    minPoints: 200,
    maxPointsPerBooking: 20_000,
    maxPointsCoverageBps: 5_000,
    minCashMinor: { INR: '100' },
    categories: ['flights', 'hotels', 'trains', 'buses', 'holidays'],
  },
  tiers: [
    { id: 'explorer', name: 'Explorer', minQualifyingPoints: 0, earnMultiplierBps: 10_000 },
    { id: 'silver', name: 'Silver', minQualifyingPoints: 2_000, earnMultiplierBps: 12_500 },
    { id: 'gold', name: 'Gold', minQualifyingPoints: 6_000, earnMultiplierBps: 15_000 },
    { id: 'platinum', name: 'Platinum', minQualifyingPoints: 15_000, earnMultiplierBps: 20_000 },
  ],
  qualificationMonths: 12,
};

// ─── Shared shapes ────────────────────────────────────────────────────────

/** `demo`: from demo bookings, spendable only on demo bookings. `live`: real payments only. */
export const rewardModeSchema = z.enum(['demo', 'live']);
export type RewardMode = z.infer<typeof rewardModeSchema>;

export const REWARD_TRANSACTION_TYPES = [
  'points_earned',
  'points_redeemed',
  'points_restored',
  'points_reversed',
  'points_expired',
  'points_adjusted',
  'credit_issued',
  'credit_redeemed',
  'credit_restored',
  'credit_expired',
  'credit_revoked',
] as const;
export const rewardTransactionTypeSchema = z.enum(REWARD_TRANSACTION_TYPES);
export type RewardTransactionType = z.infer<typeof rewardTransactionTypeSchema>;

export const rewardOriginSchema = z.enum(['automated', 'manual']);
export const travelCreditReasonSchema = z.enum([
  'promotion',
  'support_compensation',
  'booking_adjustment',
]);
export type TravelCreditReason = z.infer<typeof travelCreditReasonSchema>;
export const travelCreditStatusSchema = z.enum(['active', 'used', 'expired', 'revoked']);

export const rewardTransactionSchema = z.object({
  id: z.uuid(),
  mode: rewardModeSchema,
  type: rewardTransactionTypeSchema,
  origin: rewardOriginSchema,
  /** Signed; 0 for credit rows. */
  points: z.number().int(),
  balanceAfter: z.number().int().nullable(),
  /** Signed credit change; null for points rows. */
  amount: moneySchema.nullable(),
  description: z.string(),
  bookingReference: bookingReferenceSchema.nullable(),
  creditReference: z.string().nullable(),
  ruleVersion: z.number().int().nullable(),
  createdAt: offsetDateTimeSchema,
});
export type RewardTransaction = z.infer<typeof rewardTransactionSchema>;

export const travelCreditSchema = z.object({
  reference: z.string(),
  mode: rewardModeSchema,
  original: moneySchema,
  remaining: moneySchema,
  reason: travelCreditReasonSchema,
  note: z.string(),
  status: travelCreditStatusSchema,
  issuedAt: offsetDateTimeSchema,
  expiresAt: offsetDateTimeSchema.nullable(),
  bookingReference: bookingReferenceSchema.nullable(),
});
export type TravelCredit = z.infer<typeof travelCreditSchema>;

export const tierProgressSchema = z.object({
  id: z.string(),
  name: z.string(),
  earnMultiplierBps: z.number().int(),
  /** Qualifying points in the current window. */
  qualifyingPoints: z.number().int(),
  /** The tier is kept at least until then (null for the base tier). */
  keptUntil: offsetDateTimeSchema.nullable(),
  next: z
    .object({
      id: z.string(),
      name: z.string(),
      minQualifyingPoints: z.number().int(),
      pointsNeeded: z.number().int(),
    })
    .nullable(),
});
export type TierProgress = z.infer<typeof tierProgressSchema>;

export const rewardsAccountSchema = z.object({
  mode: rewardModeSchema,
  pointsBalance: z.number().int(),
  /** What the balance is worth at checkout, per supported currency (rules' point value). */
  balanceValue: z.array(moneySchema),
  tier: tierProgressSchema,
  /** Points on the way: confirmed, paid bookings whose trip hasn't ended (an estimate). */
  pending: z.array(
    z.object({
      bookingReference: bookingReferenceSchema,
      points: z.number().int(),
      availableOn: isoDateSchema,
    }),
  ),
  /** Points that expire within 90 days, soonest first. */
  expiring: z.array(z.object({ points: z.number().int(), expiresAt: offsetDateTimeSchema })),
  credits: z.array(travelCreditSchema),
  /** Active credit by currency. */
  creditBalance: z.array(moneySchema),
  /** Last 12 months (UTC), oldest first: points earned and redeemed. */
  monthly: z.array(
    z.object({
      month: z.string().regex(/^\d{4}-\d{2}$/),
      earned: z.number().int(),
      redeemed: z.number().int(),
    }),
  ),
});
export type RewardsAccount = z.infer<typeof rewardsAccountSchema>;

/** The rules as customers see them (from the active version). */
export const publicRulesSchema = z.object({
  version: z.number().int(),
  earn: z.object({
    spendPerPoint: z.array(moneySchema),
    categoryMultiplierBps: z.record(z.string(), z.number().int()),
    campaigns: z.array(
      z.object({
        name: z.string(),
        categories: z.array(travelCategorySlugSchema),
        startsAt: offsetDateTimeSchema,
        endsAt: offsetDateTimeSchema,
        bonusBps: z.number().int(),
      }),
    ),
    availableAfterDays: z.number().int(),
    expiryMonths: z.number().int(),
  }),
  redeem: z.object({
    pointValue: z.array(moneySchema),
    minPoints: z.number().int(),
    maxPointsPerBooking: z.number().int(),
    maxPointsCoverageBps: z.number().int(),
    categories: z.array(travelCategorySlugSchema),
  }),
  tiers: z.array(loyaltyTierRuleSchema),
  qualificationMonths: z.number().int(),
});
export type PublicRules = z.infer<typeof publicRulesSchema>;

/** GET /rewards */
export const rewardsSummarySchema = z.object({
  /** Always `demo`; `live` only when live rewards are switched on. */
  accounts: z.array(rewardsAccountSchema),
  rules: publicRulesSchema,
  liveEnabled: z.boolean(),
});
export type RewardsSummary = z.infer<typeof rewardsSummarySchema>;

export const rewardTransactionKindSchema = z.enum(['all', 'points', 'credits']);
export const rewardTransactionsQuerySchema = z
  .object({
    mode: rewardModeSchema.default('demo'),
    kind: rewardTransactionKindSchema.default('all'),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export type RewardTransactionsQuery = z.input<typeof rewardTransactionsQuerySchema>;

export const rewardTransactionListSchema = z.object({
  items: z.array(rewardTransactionSchema),
  pagination: paginationSchema,
});
export type RewardTransactionList = z.infer<typeof rewardTransactionListSchema>;

// ─── Checkout (a booking's rewards) ───────────────────────────────────────

export const bookingRewardsSchema = z.object({
  /** Whether rewards can be applied to this booking now. */
  available: z.boolean(),
  /** Why not, in Wayora's words (null when available). */
  reason: z.string().nullable(),
  mode: rewardModeSchema,
  /** The booking's total, as booked (never changed by rewards). */
  total: moneySchema.nullable(),
  /** The total after promotions (Phase 26): what the limits below are measured against. */
  afterPromotions: moneySchema.nullable().optional(),
  points: z.object({
    balance: z.number().int(),
    min: z.number().int(),
    /** The most points this booking can take now (0 when none). */
    max: z.number().int(),
    /** Value of one point in this booking's currency (null if the currency isn't supported). */
    value: moneySchema.nullable(),
  }),
  credit: z.object({
    /** Active, unexpired credit in this booking's currency and mode. */
    available: moneySchema.nullable(),
    /** The most credit this booking can take on top of the applied points. */
    max: moneySchema.nullable(),
  }),
  applied: z
    .object({
      status: z.enum(['applied', 'consumed']),
      points: z.number().int(),
      pointsAmount: moneySchema,
      creditAmount: moneySchema,
      total: moneySchema,
    })
    .nullable(),
  /** What is left to pay (total minus applied rewards). */
  payable: moneySchema.nullable(),
  ruleVersion: z.number().int(),
});
export type BookingRewards = z.infer<typeof bookingRewardsSchema>;

/** PUT /bookings/:reference/rewards — the server recalculates everything. */
export const applyBookingRewardsSchema = z
  .object({
    points: z.number().int().min(0).max(10_000_000),
    creditAmountMinor: minorString,
    /** The customer saw the values and confirmed. */
    confirm: z.literal(true, { error: 'Confirm the rewards to apply.' }),
  })
  .strict();
export type ApplyBookingRewards = z.infer<typeof applyBookingRewardsSchema>;

// ─── Admin ────────────────────────────────────────────────────────────────

export const adminRewardTransactionsQuerySchema = z
  .object({
    userId: z.uuid().optional(),
    type: rewardTransactionTypeSchema.optional(),
    origin: rewardOriginSchema.optional(),
    mode: rewardModeSchema.optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type AdminRewardTransactionsQuery = z.input<typeof adminRewardTransactionsQuerySchema>;

export const adminRewardTransactionSchema = rewardTransactionSchema.extend({
  userId: z.uuid(),
  reason: z.string().nullable(),
  actorType: z.enum(['user', 'system', 'admin', 'provider']),
});
export type AdminRewardTransaction = z.infer<typeof adminRewardTransactionSchema>;

export const adminRewardTransactionListSchema = z.object({
  items: z.array(adminRewardTransactionSchema),
  pagination: paginationSchema,
});
export type AdminRewardTransactionList = z.infer<typeof adminRewardTransactionListSchema>;

export const adminUserRewardsSchema = z.object({
  userId: z.uuid(),
  /** Display name only; no contact details. */
  name: z.string().nullable(),
  accounts: z.array(
    z.object({
      mode: rewardModeSchema,
      pointsBalance: z.number().int(),
      /** Sum of the ledger, shown next to the balance so a mismatch is visible. */
      ledgerSum: z.number().int(),
      tier: tierProgressSchema,
    }),
  ),
  credits: z.array(travelCreditSchema),
  recent: z.array(adminRewardTransactionSchema),
});
export type AdminUserRewards = z.infer<typeof adminUserRewardsSchema>;

const adminReason = z.string().trim().min(10, 'Give a reason of at least 10 characters.').max(500);

export const adminPointsAdjustmentSchema = z
  .object({
    mode: rewardModeSchema,
    /** Signed; never zero. */
    points: z
      .number()
      .int()
      .min(-1_000_000)
      .max(1_000_000)
      .refine((n) => n !== 0, 'Use a non-zero number of points.'),
    reason: adminReason,
    /** One adjustment per key (repeat submissions change nothing). */
    idempotencyKey: z.uuid(),
  })
  .strict();
export type AdminPointsAdjustment = z.infer<typeof adminPointsAdjustmentSchema>;

export const adminIssueCreditSchema = z
  .object({
    mode: rewardModeSchema,
    amount: moneySchema.refine((m) => /^[1-9]\d{0,12}$/.test(m.amountMinor), {
      message: 'Use an amount above zero.',
    }),
    reason: travelCreditReasonSchema,
    /** Shown to the customer. */
    note: z.string().trim().min(3).max(255),
    /** Why staff issued it (audit only). */
    justification: adminReason,
    expiresOn: isoDateSchema.optional(),
    bookingReference: bookingReferenceSchema.optional(),
    campaign: z.string().trim().min(1).max(80).optional(),
    idempotencyKey: z.uuid(),
  })
  .strict();
export type AdminIssueCredit = z.infer<typeof adminIssueCreditSchema>;

export const adminRevokeCreditSchema = z.object({ reason: adminReason }).strict();

export const adminRuleVersionSchema = z.object({
  version: z.number().int(),
  config: loyaltyRulesSchema,
  reason: z.string(),
  effectiveFrom: offsetDateTimeSchema,
  createdAt: offsetDateTimeSchema,
  /** Created by an admin (false for the version shipped with the migration). */
  manual: z.boolean(),
});
export type AdminRuleVersion = z.infer<typeof adminRuleVersionSchema>;

export const adminRulesSchema = z.object({
  active: adminRuleVersionSchema,
  versions: z.array(adminRuleVersionSchema),
});
export type AdminRules = z.infer<typeof adminRulesSchema>;

export const adminCreateRulesSchema = z
  .object({
    config: loyaltyRulesSchema,
    reason: adminReason,
  })
  .strict();
export type AdminCreateRules = z.infer<typeof adminCreateRulesSchema>;
