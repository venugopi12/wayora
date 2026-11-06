import { describe, expect, it } from 'vitest';
import {
  adminPromotionInputSchema,
  couponCodeSchema,
  normalizeCouponCode,
  type AdminPromotionInput,
} from '@wayora/contracts';
import {
  MIN_PAYABLE_MINOR,
  REJECTION_MESSAGE,
  discountFor,
  rankAutomatic,
  staticRejection,
  type PromotionRule,
} from '../src/modules/promotions/engine.js';

/*
 * The promotion engine's pure rules (Phase 26, docs/promotions.md#calculation):
 * deterministic inputs, integer arithmetic only.
 */

const NOW = new Date('2026-11-10T10:00:00Z');
const rule = (over: Partial<PromotionRule> = {}): PromotionRule => ({
  id: '01890000-0000-7000-8000-000000000001',
  kind: 'COUPON',
  discountType: 'PERCENTAGE',
  percentBps: 1_000,
  amountMinor: null,
  maxDiscountMinor: null,
  minAmountMinor: 0n,
  currency: 'INR',
  categories: [],
  startsAt: new Date('2026-11-01T00:00:00Z'),
  endsAt: new Date('2026-12-01T00:00:00Z'),
  active: true,
  firstBookingOnly: false,
  userId: null,
  stackable: false,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  ...over,
});
const facts = (over: Partial<Parameters<typeof staticRejection>[1]> = {}) => ({
  now: NOW,
  userId: 'u1',
  currency: 'INR',
  category: 'hotels' as const,
  eligibleMinor: 1_234_567n, // ₹12,345.67
  ...over,
});

describe('discount calculation', () => {
  it('percentage: floor of the eligible amount × rate, then the maximum', () => {
    expect(discountFor(rule(), 1_234_567n)).toBe(123_456n); // ₹1,234.56 (rounded down)
    expect(discountFor(rule({ maxDiscountMinor: 100_000n }), 1_234_567n)).toBe(100_000n);
    expect(discountFor(rule({ percentBps: 1 }), 9_999n)).toBe(0n); // 0.01% of ₹99.99 rounds to 0
    expect(discountFor(rule({ percentBps: 333 }), 100_001n)).toBe(3_330n);
  });

  it('fixed: the amount, never more than the total less the minimum to pay', () => {
    const fixed = rule({ discountType: 'FIXED', percentBps: null, amountMinor: 50_000n });
    expect(discountFor(fixed, 1_234_567n)).toBe(50_000n);
    expect(discountFor(fixed, 30_000n)).toBe(30_000n - MIN_PAYABLE_MINOR);
    expect(discountFor(fixed, MIN_PAYABLE_MINOR)).toBe(0n);
    expect(discountFor(fixed, 50n)).toBe(0n);
    // A 90% coupon on a tiny total still leaves the minimum.
    expect(discountFor(rule({ percentBps: 9_000 }), 150n)).toBe(50n);
  });
});

describe('eligibility (static checks, in order)', () => {
  it('reports the first failing rule', () => {
    expect(staticRejection(rule(), facts())).toBeNull();
    expect(staticRejection(rule({ userId: 'someone-else' }), facts())).toBe('COUPON_NOT_FOUND');
    expect(staticRejection(rule({ userId: 'u1' }), facts())).toBeNull();
    expect(staticRejection(rule({ active: false, currency: 'USD' }), facts())).toBe(
      'COUPON_INACTIVE',
    );
    expect(staticRejection(rule({ startsAt: new Date('2026-11-11T00:00:00Z') }), facts())).toBe(
      'COUPON_NOT_STARTED',
    );
    // The end is exclusive.
    expect(staticRejection(rule({ endsAt: NOW }), facts())).toBe('COUPON_EXPIRED');
    expect(staticRejection(rule({ currency: 'USD' }), facts())).toBe('CURRENCY_NOT_SUPPORTED');
    expect(staticRejection(rule({ categories: ['flights'] }), facts())).toBe(
      'CATEGORY_NOT_ELIGIBLE',
    );
    expect(staticRejection(rule({ categories: ['flights', 'hotels'] }), facts())).toBeNull();
    expect(staticRejection(rule({ minAmountMinor: 2_000_000n }), facts())).toBe(
      'MINIMUM_AMOUNT_NOT_MET',
    );
    expect(staticRejection(rule(), facts({ eligibleMinor: 100n }))).toBe('MINIMUM_AMOUNT_NOT_MET');
  });

  it('never words a rejection in a way that reveals another customer', () => {
    for (const message of Object.values(REJECTION_MESSAGE)) {
      expect(message).not.toMatch(/someone|another customer|other user|already booked/i);
    }
    // A personal offer for someone else reads exactly like an unknown code.
    expect(REJECTION_MESSAGE[staticRejection(rule({ userId: 'x' }), facts())!]).toBe(
      REJECTION_MESSAGE.COUPON_NOT_FOUND,
    );
  });
});

describe('automatic promotion selection', () => {
  const c = (id: string, discount: bigint, endsAt: string, createdAt = '2026-10-01T00:00:00Z') => ({
    rule: rule({ id, kind: 'AUTOMATIC', endsAt: new Date(endsAt), createdAt: new Date(createdAt) }),
    discount,
  });
  it('picks the largest discount, then the one ending soonest, then the oldest, then by id', () => {
    const list = [
      c('d', 30_000n, '2026-12-01T00:00:00Z'),
      c('b', 50_000n, '2026-12-20T00:00:00Z'),
      c('a', 50_000n, '2026-12-10T00:00:00Z', '2026-10-05T00:00:00Z'),
      c('c', 50_000n, '2026-12-10T00:00:00Z', '2026-10-02T00:00:00Z'),
      c('e', 50_000n, '2026-12-10T00:00:00Z', '2026-10-02T00:00:00Z'),
    ];
    const order = rankAutomatic(list).map((x) => x.rule.id);
    expect(order).toEqual(['c', 'e', 'a', 'b', 'd']);
    expect(rankAutomatic([...list].reverse()).map((x) => x.rule.id)).toEqual(order);
  });
});

describe('codes and configuration', () => {
  it('normalizes codes the same way everywhere', () => {
    expect(normalizeCouponCode('  summer 10 ')).toBe('SUMMER10');
    expect(normalizeCouponCode('ｓａｖｅ-10')).toBe('SAVE-10'); // full-width letters
    expect(couponCodeSchema.parse(' welcome-500 ')).toBe('WELCOME-500');
    expect(couponCodeSchema.safeParse('a!').success).toBe(false);
    expect(couponCodeSchema.safeParse('-ABC').success).toBe(false);
  });

  const base: AdminPromotionInput = {
    kind: 'coupon',
    code: 'SAVE10',
    name: 'Ten off',
    description: '10% off hotels',
    terms: 'Valid on demo hotel bookings.',
    discountType: 'percentage',
    percentBps: 1000,
    currency: 'INR',
    startsAt: '2026-11-01T00:00:00Z',
    endsAt: '2026-12-01T00:00:00Z',
  };
  const issues = (over: Partial<AdminPromotionInput>) =>
    adminPromotionInputSchema
      .safeParse({ ...base, ...over })
      .error?.issues.map((i) => i.path.join('.')) ?? [];

  it('validates promotion configuration on the server', () => {
    expect(adminPromotionInputSchema.parse(base)).toMatchObject({ perUserLimit: 1, listed: true });
    expect(issues({ code: undefined })).toContain('code');
    expect(issues({ kind: 'automatic' })).toContain('code');
    expect(issues({ kind: 'automatic', code: undefined, stackable: true })).toContain('stackable');
    expect(issues({ discountType: 'fixed' })).toEqual(
      expect.arrayContaining(['amountMinor', 'percentBps']),
    );
    expect(issues({ percentBps: 9_500 })).toContain('percentBps');
    expect(issues({ endsAt: '2026-10-01T00:00:00Z' })).toContain('endsAt');
    expect(issues({ userId: '01890000-0000-7000-8000-000000000009' })).toContain('listed');
    expect(issues({ usageLimit: 1, perUserLimit: 2 })).toContain('perUserLimit');
    expect(issues({ amountMinor: '12.5' } as never)).toContain('amountMinor');
    expect(adminPromotionInputSchema.safeParse({ ...base, discountMinor: '1' }).success).toBe(
      false,
    );
  });
});
