import {
  loyaltyRulesSchema,
  type LoyaltyRules,
  type LoyaltyTierRule,
  type PublicRules,
  type TravelCategorySlug,
} from '@wayora/contracts';

/*
 * Loyalty calculations (docs/rewards.md#rules). Pure functions of a rule
 * version and the facts; no database, no clock of their own, no floats.
 * Points and money are BigInt; multipliers are basis points (10000 = ×1),
 * and every division rounds down (towards zero for non-negative values).
 */

const BPS = 10_000n;

export interface RuleVersion {
  version: number;
  rules: LoyaltyRules;
  effectiveFrom: Date;
}

/** Parses a stored rule version (the column is validated on write; this guards against corruption). */
export function parseRules(version: number, config: unknown, effectiveFrom: Date): RuleVersion {
  return { version, rules: loyaltyRulesSchema.parse(config), effectiveFrom };
}

// ─── Earning ─────────────────────────────────────────────────────────────

export interface EarnInput {
  currency: string;
  /** What was actually paid in money (minor units): never points or credit. */
  paidMinor: bigint;
  category: TravelCategorySlug;
  /** The account's tier when the points are awarded. */
  tierId: string;
  /** When the booking was confirmed (decides which campaigns apply). */
  confirmedAt: Date;
}

export interface EarnResult {
  /** Points added to the balance. */
  points: bigint;
  /** Points that count towards tiers (base points × category; no tier or campaign bonus). */
  qualifyingPoints: bigint;
  /** The calculation, stored with the transaction so it stays explainable. */
  breakdown: {
    paidMinor: string;
    currency: string;
    spendMinorPerPoint: string | null;
    basePoints: string;
    categoryMultiplierBps: number;
    tierId: string;
    tierMultiplierBps: number;
    campaigns: { id: string; bonusBps: number }[];
    /** Why nothing was earned, if nothing was. */
    note: string | null;
  };
}

export function tierById(rules: LoyaltyRules, id: string): LoyaltyTierRule {
  return rules.tiers.find((t) => t.id === id) ?? rules.tiers[0]!;
}

/**
 * Points for one paid booking:
 *   base       = floor(paid / spendMinorPerPoint[currency])
 *   qualifying = floor(base × category / 10000)
 *   points     = floor(qualifying × tier × (10000 + Σ campaign bonus) / 10000²)
 */
export function calculateEarn(rules: LoyaltyRules, input: EarnInput): EarnResult {
  const spend = rules.earn.spendMinorPerPoint[input.currency];
  const categoryBps = rules.earn.categoryMultiplierBps[input.category] ?? 0;
  const tier = tierById(rules, input.tierId);
  const at = input.confirmedAt.getTime();
  const campaigns = rules.earn.campaigns.filter(
    (c) =>
      (c.categories.length === 0 || c.categories.includes(input.category)) &&
      Date.parse(c.startsAt) <= at &&
      at < Date.parse(c.endsAt),
  );
  const bonus = campaigns.reduce((sum, c) => sum + c.bonusBps, 0);
  const base = spend && input.paidMinor > 0n ? input.paidMinor / BigInt(spend) : 0n;
  const qualifying = (base * BigInt(categoryBps)) / BPS;
  const points = (qualifying * BigInt(tier.earnMultiplierBps) * (BPS + BigInt(bonus))) / BPS / BPS;
  const note = !spend
    ? `Bookings in ${input.currency} don't earn points.`
    : categoryBps === 0
      ? 'This category doesn’t earn points.'
      : points === 0n
        ? 'The amount paid was below the spend for one point.'
        : null;
  return {
    points,
    qualifyingPoints: qualifying,
    breakdown: {
      paidMinor: input.paidMinor.toString(),
      currency: input.currency,
      spendMinorPerPoint: spend ?? null,
      basePoints: base.toString(),
      categoryMultiplierBps: categoryBps,
      tierId: tier.id,
      tierMultiplierBps: tier.earnMultiplierBps,
      campaigns: campaigns.map((c) => ({ id: c.id, bonusBps: c.bonusBps })),
      note,
    },
  };
}

// ─── Dates ───────────────────────────────────────────────────────────────

/** Adds calendar months in UTC, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/** YYYY-MM-DD plus whole days. */
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── Tiers ───────────────────────────────────────────────────────────────

export interface TierState {
  tierId: string;
  qualifiedAt: Date | null;
}

export interface TierEvaluation extends TierState {
  change: 'upgrade' | 'downgrade' | null;
  /** The tier is kept at least until then (null for the first tier). */
  keptUntil: Date | null;
}

/**
 * The tier for `qualifyingPoints` earned in the rolling qualification
 * window (docs/rewards.md#tiers):
 * - reaching a higher tier upgrades at once;
 * - still qualifying for the current tier renews it (kept for another window);
 * - qualifying for less keeps the current tier until `qualificationMonths`
 *   after it was last reached or renewed, then drops to the tier qualified for.
 * Deterministic: same inputs, same answer.
 */
export function evaluateTier(
  rules: LoyaltyRules,
  current: TierState,
  qualifyingPoints: bigint,
  now: Date,
): TierEvaluation {
  const tiers = rules.tiers;
  let earned = 0;
  tiers.forEach((t, i) => {
    if (BigInt(t.minQualifyingPoints) <= qualifyingPoints) earned = i;
  });
  const found = tiers.findIndex((t) => t.id === current.tierId);
  const held = found < 0 ? 0 : found;
  const kept = (rank: number, at: Date | null) =>
    rank === 0 || !at ? null : addMonths(at, rules.qualificationMonths);

  if (earned > held) {
    return {
      tierId: tiers[earned]!.id,
      qualifiedAt: now,
      change: 'upgrade',
      keptUntil: kept(earned, now),
    };
  }
  if (earned === held) {
    const at = held === 0 ? null : now;
    return {
      tierId: tiers[held]!.id,
      qualifiedAt: at,
      change: found < 0 ? 'downgrade' : null,
      keptUntil: kept(held, at),
    };
  }
  const until = kept(held, current.qualifiedAt);
  if (until && now.getTime() < until.getTime()) {
    return {
      tierId: tiers[held]!.id,
      qualifiedAt: current.qualifiedAt,
      change: null,
      keptUntil: until,
    };
  }
  const at = earned === 0 ? null : now;
  return {
    tierId: tiers[earned]!.id,
    qualifiedAt: at,
    change: 'downgrade',
    keptUntil: kept(earned, at),
  };
}

// ─── Redemption ──────────────────────────────────────────────────────────

export interface RedemptionFacts {
  category: TravelCategorySlug;
  currency: string;
  totalMinor: bigint;
  pointsBalance: bigint;
  creditAvailableMinor: bigint;
}

export interface RedemptionLimits {
  /** Why rewards can't be used on this booking (null when they can). */
  reason: string | null;
  pointValueMinor: bigint | null;
  minPoints: bigint;
  /** Most points usable now (0 when below the minimum or not allowed). */
  maxPoints: bigint;
  minCashMinor: bigint;
  /** Most credit usable with `points` applied. */
  maxCreditFor: (points: bigint) => bigint;
}

const min = (...values: bigint[]) => values.reduce((a, b) => (b < a ? b : a));

/**
 * What a booking can take (docs/rewards.md#redemption):
 *   maxPoints = min(balance, maxPointsPerBooking,
 *                   floor(total × coverage / 10000 / value),
 *                   floor((total − minCash) / value)), or 0 if below minPoints
 *   maxCredit(points) = min(credit available, total − minCash − points × value)
 * so at least minCash is always left to pay.
 */
export function redemptionLimits(rules: LoyaltyRules, facts: RedemptionFacts): RedemptionLimits {
  const r = rules.redeem;
  const value = r.pointValueMinor[facts.currency];
  const minCash = BigInt(r.minCashMinor[facts.currency] ?? '0');
  const room = facts.totalMinor - minCash;
  const none = (reason: string): RedemptionLimits => ({
    reason,
    pointValueMinor: value ? BigInt(value) : null,
    minPoints: BigInt(r.minPoints),
    maxPoints: 0n,
    minCashMinor: minCash,
    maxCreditFor: () => 0n,
  });
  if (!r.categories.includes(facts.category)) {
    return none('Rewards can’t be used on this kind of booking.');
  }
  if (!value) return none(`Rewards can’t be used on bookings in ${facts.currency}.`);
  if (room <= 0n) return none('This booking’s total is too small to use rewards on.');
  const v = BigInt(value);
  let maxPoints = min(
    facts.pointsBalance,
    BigInt(r.maxPointsPerBooking),
    (facts.totalMinor * BigInt(r.maxPointsCoverageBps)) / BPS / v,
    room / v,
  );
  if (maxPoints < BigInt(r.minPoints)) maxPoints = 0n;
  return {
    reason: null,
    pointValueMinor: v,
    minPoints: BigInt(r.minPoints),
    maxPoints,
    minCashMinor: minCash,
    maxCreditFor: (points) => {
      const left = room - points * v;
      return left <= 0n ? 0n : min(facts.creditAvailableMinor, left);
    },
  };
}

// ─── Presentation ────────────────────────────────────────────────────────

export function publicRules({ version, rules }: RuleVersion, now: Date): PublicRules {
  const money = (map: Record<string, string>) =>
    Object.entries(map).map(([currency, amountMinor]) => ({ currency, amountMinor }));
  return {
    version,
    earn: {
      spendPerPoint: money(rules.earn.spendMinorPerPoint),
      categoryMultiplierBps: { ...rules.earn.categoryMultiplierBps },
      // Current and upcoming campaigns only.
      campaigns: rules.earn.campaigns
        .filter((c) => Date.parse(c.endsAt) > now.getTime())
        .map(({ name, categories, startsAt, endsAt, bonusBps }) => ({
          name,
          categories,
          startsAt,
          endsAt,
          bonusBps,
        })),
      availableAfterDays: rules.earn.availableAfterDays,
      expiryMonths: rules.earn.expiryMonths,
    },
    redeem: {
      pointValue: money(rules.redeem.pointValueMinor),
      minPoints: rules.redeem.minPoints,
      maxPointsPerBooking: rules.redeem.maxPointsPerBooking,
      maxPointsCoverageBps: rules.redeem.maxPointsCoverageBps,
      categories: rules.redeem.categories,
    },
    tiers: rules.tiers,
    qualificationMonths: rules.qualificationMonths,
  };
}
