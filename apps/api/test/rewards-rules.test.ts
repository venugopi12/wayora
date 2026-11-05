import { describe, expect, it } from 'vitest';
import { DEFAULT_LOYALTY_RULES, loyaltyRulesSchema, type LoyaltyRules } from '@wayora/contracts';
import {
  addDays,
  addMonths,
  calculateEarn,
  evaluateTier,
  publicRules,
  redemptionLimits,
} from '../src/modules/rewards/rules.js';

/*
 * Loyalty calculations (Phase 25, docs/rewards.md#rules): pure functions,
 * deterministic inputs, integer arithmetic only.
 */

const rules: LoyaltyRules = structuredClone(DEFAULT_LOYALTY_RULES);
const at = new Date('2026-11-10T10:00:00Z');
const earn = (over: Partial<Parameters<typeof calculateEarn>[1]> = {}, r = rules) =>
  calculateEarn(r, {
    currency: 'INR',
    paidMinor: 1_234_599n, // ₹12,345.99
    category: 'hotels',
    tierId: 'explorer',
    confirmedAt: at,
    ...over,
  });

describe('earning', () => {
  it('earns one base point per ₹10 actually paid, rounding down', () => {
    const r = earn();
    expect(r.points).toBe(1234n);
    expect(r.qualifyingPoints).toBe(1234n);
    expect(r.breakdown).toMatchObject({
      paidMinor: '1234599',
      basePoints: '1234',
      spendMinorPerPoint: '1000',
      tierMultiplierBps: 10_000,
      note: null,
    });
    expect(earn({ paidMinor: 999n }).points).toBe(0n);
    expect(earn({ paidMinor: 999n }).breakdown.note).toMatch(/below the spend/);
    expect(earn({ paidMinor: 0n }).points).toBe(0n);
  });

  it('applies the tier multiplier to points but not to qualifying points', () => {
    const gold = earn({ tierId: 'gold' });
    expect(gold.points).toBe(1851n); // floor(1234 × 1.5)
    expect(gold.qualifyingPoints).toBe(1234n);
    expect(earn({ tierId: 'platinum' }).points).toBe(2468n);
    // An unknown tier (removed from the rules) earns at the first tier's rate.
    expect(earn({ tierId: 'retired' }).points).toBe(1234n);
  });

  it('applies category multipliers, and none for currencies without a rate', () => {
    const r = structuredClone(rules);
    r.earn.categoryMultiplierBps.metro = 0;
    r.earn.categoryMultiplierBps.holidays = 20_000;
    expect(earn({ category: 'metro' }, r).points).toBe(0n);
    expect(earn({ category: 'metro' }, r).breakdown.note).toMatch(/category/);
    expect(earn({ category: 'holidays' }, r)).toMatchObject({
      points: 2468n,
      qualifyingPoints: 2468n,
    });
    expect(earn({ currency: 'USD' }).points).toBe(0n);
    expect(earn({ currency: 'USD' }).breakdown.note).toMatch(/USD/);
  });

  it('adds campaign bonuses only for bookings confirmed inside the campaign and its categories', () => {
    const r = structuredClone(rules);
    r.earn.campaigns = [
      {
        id: 'monsoon',
        name: 'Monsoon stays',
        categories: ['hotels'],
        startsAt: '2026-11-01T00:00:00+05:30',
        endsAt: '2026-12-01T00:00:00+05:30',
        bonusBps: 5_000,
      },
    ];
    expect(earn({}, r).points).toBe(1851n); // +50%
    expect(earn({}, r).breakdown.campaigns).toEqual([{ id: 'monsoon', bonusBps: 5_000 }]);
    expect(earn({ category: 'flights' }, r).points).toBe(1234n);
    expect(earn({ confirmedAt: new Date('2026-12-01T00:00:00+05:30') }, r).points).toBe(1234n);
    // Bonus and tier multiply: floor(1234 × 1.5 × 1.5).
    expect(earn({ tierId: 'gold' }, r).points).toBe(2776n);
  });
});

describe('tiers', () => {
  const t0 = new Date('2026-01-15T00:00:00Z');
  const state = (tierId: string, qualifiedAt: Date | null) => ({ tierId, qualifiedAt });

  it('upgrades as soon as the qualifying points are reached', () => {
    expect(evaluateTier(rules, state('explorer', null), 1_999n, t0)).toMatchObject({
      tierId: 'explorer',
      change: null,
      keptUntil: null,
    });
    const silver = evaluateTier(rules, state('explorer', null), 2_000n, t0);
    expect(silver).toMatchObject({ tierId: 'silver', change: 'upgrade', qualifiedAt: t0 });
    expect(silver.keptUntil).toEqual(new Date('2027-01-15T00:00:00Z'));
    expect(evaluateTier(rules, state('explorer', null), 15_000n, t0).tierId).toBe('platinum');
  });

  it('keeps a reached tier for the qualification period, then drops to what is qualified for', () => {
    const gold = state('gold', t0);
    const later = new Date('2026-12-01T00:00:00Z');
    expect(evaluateTier(rules, gold, 100n, later)).toMatchObject({ tierId: 'gold', change: null });
    const expired = new Date('2027-01-15T00:00:00Z');
    expect(evaluateTier(rules, gold, 2_500n, expired)).toMatchObject({
      tierId: 'silver',
      change: 'downgrade',
      qualifiedAt: expired,
    });
    // Several steps at once when the points no longer qualify for anything above.
    expect(evaluateTier(rules, gold, 0n, expired)).toMatchObject({
      tierId: 'explorer',
      change: 'downgrade',
      qualifiedAt: null,
    });
  });

  it('renews the tier while it is still qualified for', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    expect(evaluateTier(rules, state('silver', t0), 2_000n, now)).toMatchObject({
      tierId: 'silver',
      change: null,
      qualifiedAt: now,
    });
  });

  it('is deterministic', () => {
    const a = evaluateTier(rules, state('gold', t0), 3_000n, new Date('2027-02-01T00:00:00Z'));
    const b = evaluateTier(rules, state('gold', t0), 3_000n, new Date('2027-02-01T00:00:00Z'));
    expect(a).toEqual(b);
  });
});

describe('redemption limits', () => {
  const facts = {
    category: 'hotels' as const,
    currency: 'INR',
    totalMinor: 1_000_000n, // ₹10,000
    pointsBalance: 50_000n,
    creditAvailableMinor: 300_000n,
  };

  it('caps points by balance, per-booking maximum, 50% coverage and the minimum left to pay', () => {
    const l = redemptionLimits(rules, facts);
    expect(l.reason).toBeNull();
    expect(l.pointValueMinor).toBe(25n);
    // 50% of ₹10,000 = ₹5,000 = 20,000 points (also the per-booking maximum).
    expect(l.maxPoints).toBe(20_000n);
    expect(redemptionLimits(rules, { ...facts, pointsBalance: 1_234n }).maxPoints).toBe(1_234n);
    expect(redemptionLimits(rules, { ...facts, totalMinor: 200_000n }).maxPoints).toBe(4_000n);
  });

  it('offers nothing below the minimum redemption', () => {
    expect(redemptionLimits(rules, { ...facts, pointsBalance: 199n }).maxPoints).toBe(0n);
    // ₹80 total: 50% = ₹40 = 160 points, below the 200 minimum.
    expect(redemptionLimits(rules, { ...facts, totalMinor: 8_000n }).maxPoints).toBe(0n);
    expect(redemptionLimits(rules, { ...facts, totalMinor: 30_000n }).maxPoints).toBe(600n);
  });

  it('always leaves the minimum to pay, whatever mix of points and credit', () => {
    const l = redemptionLimits(rules, facts);
    expect(l.maxCreditFor(0n)).toBe(300_000n);
    expect(l.maxCreditFor(20_000n)).toBe(300_000n); // ₹5,000 points + ₹3,000 credit < ₹9,999
    const small = redemptionLimits(rules, {
      ...facts,
      totalMinor: 100_000n,
      creditAvailableMinor: 1_000_000n,
    });
    expect(small.maxCreditFor(0n)).toBe(99_900n); // ₹1 left to pay
    expect(small.maxCreditFor(2_000n)).toBe(49_900n);
    expect(small.maxCreditFor(10_000n)).toBe(0n);
  });

  it('refuses categories and currencies the rules exclude', () => {
    expect(redemptionLimits(rules, { ...facts, category: 'cabs' }).reason).toMatch(
      /kind of booking/,
    );
    expect(redemptionLimits(rules, { ...facts, currency: 'USD' }).reason).toMatch(/USD/);
    expect(redemptionLimits(rules, { ...facts, totalMinor: 100n }).reason).toMatch(/too small/);
    expect(redemptionLimits(rules, { ...facts, currency: 'USD' }).maxPoints).toBe(0n);
  });
});

describe('rules', () => {
  it('validates the shipped rules and rejects inconsistent ones', () => {
    expect(loyaltyRulesSchema.parse(DEFAULT_LOYALTY_RULES)).toEqual(DEFAULT_LOYALTY_RULES);
    const bad = structuredClone(DEFAULT_LOYALTY_RULES);
    bad.tiers[2]!.minQualifyingPoints = 100;
    bad.redeem.minPoints = 50_000;
    bad.tiers[0]!.minQualifyingPoints = 5;
    const issues = loyaltyRulesSchema.safeParse(bad).error!.issues.map((i) => i.message);
    expect(issues).toEqual(
      expect.arrayContaining([
        'The first tier must need 0 qualifying points.',
        'Tiers must need strictly more qualifying points than the one before.',
        'Must be at least the minimum redemption.',
      ]),
    );
    // No floating-point money: amounts are integer strings.
    const float = structuredClone(DEFAULT_LOYALTY_RULES) as unknown as {
      redeem: { pointValueMinor: Record<string, string> };
    };
    float.redeem.pointValueMinor.INR = '0.25';
    expect(loyaltyRulesSchema.safeParse(float).success).toBe(false);
  });

  it('adds calendar months and days in UTC', () => {
    expect(addMonths(new Date('2026-01-31T12:00:00Z'), 1)).toEqual(
      new Date('2026-02-28T12:00:00Z'),
    );
    expect(addMonths(new Date('2026-11-05T00:00:00Z'), 24)).toEqual(
      new Date('2028-11-05T00:00:00Z'),
    );
    expect(addMonths(new Date('2026-03-31T00:00:00Z'), -1)).toEqual(
      new Date('2026-02-28T00:00:00Z'),
    );
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('shows customers only current and upcoming campaigns', () => {
    const r = structuredClone(rules);
    r.earn.campaigns = [
      {
        id: 'past',
        name: 'Past',
        categories: [],
        startsAt: '2026-01-01T00:00:00Z',
        endsAt: '2026-02-01T00:00:00Z',
        bonusBps: 1000,
      },
      {
        id: 'next',
        name: 'Next',
        categories: [],
        startsAt: '2027-01-01T00:00:00Z',
        endsAt: '2027-02-01T00:00:00Z',
        bonusBps: 1000,
      },
    ];
    const view = publicRules({ version: 3, rules: r, effectiveFrom: at }, at);
    expect(view.earn.campaigns.map((c) => c.name)).toEqual(['Next']);
    expect(view.redeem.pointValue).toEqual([{ currency: 'INR', amountMinor: '25' }]);
    expect(view.version).toBe(3);
  });
});
