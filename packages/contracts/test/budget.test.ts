import { describe, expect, it } from 'vitest';
import {
  computeBalances,
  createExpenseSchema,
  minorToInput,
  parseMoneyInput,
  parsePercentInput,
  putBudgetSchema,
  splitByBasisPoints,
  splitEqual,
  suggestSettlements,
  type LedgerExpense,
  type PartMinor,
} from '../src/index.js';

/*
 * Exact money arithmetic for budgets and group splits (docs/planner.md#budget).
 * Everything is integer minor units (BigInt): nothing is lost or invented by
 * rounding, and the results are deterministic.
 */

const A = '01890000-0000-7000-a000-00000000000a';
const B = '01890000-0000-7000-a000-00000000000b';
const C = '01890000-0000-7000-a000-00000000000c';
const D = '01890000-0000-7000-a000-00000000000d';

const sum = (m: Map<string, bigint>) => [...m.values()].reduce((s, v) => s + v, 0n);
const part = (personId: string, paid: bigint, share: bigint): PartMinor => ({
  personId,
  paidMinor: paid,
  shareMinor: share,
});

describe('money input', () => {
  it('parses what people type into exact minor units, without floats', () => {
    expect(parseMoneyInput('1000', 'INR')).toBe('100000');
    expect(parseMoneyInput('1,499.5', 'INR')).toBe('149950');
    expect(parseMoneyInput('₹ 0.07', 'INR')).toBe('7');
    expect(parseMoneyInput('0.1', 'USD')).toBe('10');
    expect(parseMoneyInput('19.99', 'EUR')).toBe('1999');
    // 0.1 + 0.2 style traps can't happen: it's string arithmetic.
    expect(parseMoneyInput('0.30', 'USD')).toBe('30');
    expect(parseMoneyInput('9999999999.99', 'INR')).toBe('999999999999');
  });

  it('refuses zero, negatives, too many decimals and nonsense', () => {
    for (const bad of ['0', '0.00', '-5', '1.234', 'abc', '', '1.2.3', '1e5', '10000000000.01']) {
      expect(parseMoneyInput(bad, 'INR'), bad).toBeNull();
    }
  });

  it('formats minor units back for editing', () => {
    expect(minorToInput('149950', 'INR')).toBe('1499.50');
    expect(minorToInput('7', 'USD')).toBe('0.07');
    expect(minorToInput('-250', 'GBP')).toBe('-2.50');
  });

  it('parses percentages into basis points', () => {
    expect(parsePercentInput('33.33')).toBe(3333);
    expect(parsePercentInput('50')).toBe(5000);
    expect(parsePercentInput('12.5%')).toBe(1250);
    expect(parsePercentInput('0')).toBeNull();
    expect(parsePercentInput('100.01')).toBeNull();
    expect(parsePercentInput('1.234')).toBeNull();
  });
});

describe('equal split', () => {
  it('₹1,000 between three people adds up to exactly ₹1,000', () => {
    const shares = splitEqual(100_000n, [C, A, B]);
    expect(sum(shares)).toBe(100_000n);
    // The leftover paisa goes to the first person in id order, every time.
    expect([...shares.entries()]).toEqual([
      [A, 33_334n],
      [B, 33_333n],
      [C, 33_333n],
    ]);
    expect(splitEqual(100_000n, [B, C, A])).toEqual(shares);
  });

  it('spreads any remainder one minor unit at a time, never more', () => {
    for (const amount of [1n, 2n, 7n, 99n, 100n, 101n, 1_000_003n]) {
      for (const people of [[A], [A, B], [A, B, C], [A, B, C, D]]) {
        const shares = splitEqual(amount, people);
        const values = [...shares.values()];
        expect(sum(shares)).toBe(amount);
        const min = values.reduce((m, v) => (v < m ? v : m));
        const max = values.reduce((m, v) => (v > m ? v : m));
        expect(max - min <= 1n).toBe(true);
      }
    }
  });

  it('gives a one-paisa expense to one person and zero to the rest', () => {
    expect([...splitEqual(1n, [B, A]).entries()]).toEqual([
      [A, 1n],
      [B, 0n],
    ]);
  });
});

describe('percentage split', () => {
  it('uses the largest remainders for leftover minor units, and adds up exactly', () => {
    const shares = splitByBasisPoints(100_000n, [
      { personId: A, basisPoints: 3333 },
      { personId: B, basisPoints: 3333 },
      { personId: C, basisPoints: 3334 },
    ]);
    expect(sum(shares)).toBe(100_000n);
    expect([...shares.entries()]).toEqual([
      [A, 33_330n],
      [B, 33_330n],
      [C, 33_340n],
    ]);
  });

  it('distributes a remainder by fractional size, ties by id', () => {
    // ₹0.10 split 1/3, 1/3, 1/3 (3333, 3333, 3334 bp): 3.333, 3.333, 3.334 → 3, 3, 4? exact:
    const shares = splitByBasisPoints(10n, [
      { personId: C, basisPoints: 3334 },
      { personId: B, basisPoints: 3333 },
      { personId: A, basisPoints: 3333 },
    ]);
    expect(sum(shares)).toBe(10n);
    // floors 3, 3, 3; one leftover → largest remainder: C (0.334).
    expect(shares.get(C)).toBe(4n);
    expect(shares.get(A)).toBe(3n);
    expect(shares.get(B)).toBe(3n);
    // Equal remainders: id order decides.
    const tie = splitByBasisPoints(1n, [
      { personId: B, basisPoints: 5000 },
      { personId: A, basisPoints: 5000 },
    ]);
    expect(tie.get(A)).toBe(1n);
    expect(tie.get(B)).toBe(0n);
  });

  it('refuses percentages that don’t add up to 100%', () => {
    expect(() =>
      splitByBasisPoints(100n, [
        { personId: A, basisPoints: 5000 },
        { personId: B, basisPoints: 4999 },
      ]),
    ).toThrow();
  });

  it('is exact for large amounts', () => {
    const amount = 999_999_999_999n;
    const shares = splitByBasisPoints(amount, [
      { personId: A, basisPoints: 1 },
      { personId: B, basisPoints: 9_999 },
    ]);
    expect(sum(shares)).toBe(amount);
    // A's exact share is 99,999,999.9999: the one leftover unit is A's (largest remainder).
    expect(shares.get(A)).toBe(100_000_000n);
    expect(shares.get(B)).toBe(999_899_999_999n);
  });
});

describe('balances', () => {
  it('matches the documented example: A paid ₹1,500 and owes ₹500; B paid ₹500 and owes ₹1,000', () => {
    const expenses: LedgerExpense[] = [
      // A paid ₹1,500 for something B used ₹1,000 of and A ₹500 of.
      { currency: 'INR', parts: [part(A, 150_000n, 50_000n), part(B, 0n, 100_000n)] },
      // B paid ₹500 for something only B used.
      { currency: 'INR', parts: [part(B, 50_000n, 0n)] },
    ];
    const [inr] = [...computeBalances(expenses, []).values()];
    const a = inr!.find((r) => r.personId === A)!;
    const b = inr!.find((r) => r.personId === B)!;
    expect(a).toMatchObject({ paidMinor: 150_000n, shareMinor: 50_000n, netMinor: 100_000n });
    expect(b).toMatchObject({ paidMinor: 50_000n, shareMinor: 100_000n, netMinor: -50_000n });
  });

  it('handles different participant sets, multiple payers, and nets that sum to zero', () => {
    const expenses: LedgerExpense[] = [
      // Dinner ₹900: A and B paid ₹450 each, shared by A, B, C.
      {
        currency: 'INR',
        parts: [part(A, 45_000n, 30_000n), part(B, 45_000n, 30_000n), part(C, 0n, 30_000n)],
      },
      // Taxi ₹301: C paid, shared by B and C only (equal split, remainder to B).
      {
        currency: 'INR',
        parts: [
          part(C, 30_100n, 0n),
          ...[...splitEqual(30_100n, [B, C])].map(([id, s]) => part(id, 0n, s)),
        ].reduce<PartMinor[]>((acc, p) => {
          const found = acc.find((x) => x.personId === p.personId);
          if (found) {
            found.paidMinor += p.paidMinor;
            found.shareMinor += p.shareMinor;
          } else acc.push({ ...p });
          return acc;
        }, []),
      },
    ];
    const inr = computeBalances(expenses, []).get('INR')!;
    expect(inr.reduce((s, r) => s + r.netMinor, 0n)).toBe(0n);
    expect(inr.find((r) => r.personId === A)!.netMinor).toBe(15_000n);
    expect(inr.find((r) => r.personId === B)!.netMinor).toBe(15_000n - 15_050n);
    expect(inr.find((r) => r.personId === C)!.netMinor).toBe(30_100n - 30_000n - 15_050n);
  });

  it('keeps currencies apart — never adds INR to USD', () => {
    const balances = computeBalances(
      [
        { currency: 'USD', parts: [part(A, 1_000n, 500n), part(B, 0n, 500n)] },
        { currency: 'INR', parts: [part(B, 10_000n, 5_000n), part(A, 0n, 5_000n)] },
      ],
      [],
    );
    expect([...balances.keys()]).toEqual(['INR', 'USD']);
    expect(balances.get('USD')!.find((r) => r.personId === A)!.netMinor).toBe(500n);
    expect(balances.get('INR')!.find((r) => r.personId === A)!.netMinor).toBe(-5_000n);
  });

  it('counts recorded settlements: paying someone back reduces both balances', () => {
    const expenses: LedgerExpense[] = [
      { currency: 'INR', parts: [part(A, 100_000n, 50_000n), part(B, 0n, 50_000n)] },
    ];
    const settled = computeBalances(expenses, [
      { currency: 'INR', fromId: B, toId: A, amountMinor: 20_000n },
    ]).get('INR')!;
    expect(settled.find((r) => r.personId === A)!.netMinor).toBe(30_000n);
    expect(settled.find((r) => r.personId === B)!.netMinor).toBe(-30_000n);
  });

  it('is empty with no expenses', () => {
    expect(computeBalances([], []).size).toBe(0);
  });
});

describe('settlement suggestions', () => {
  it('reconciles exactly with the balances, in at most n − 1 transfers', () => {
    const balances = [
      { personId: A, netMinor: 100_000n },
      { personId: B, netMinor: -30_001n },
      { personId: C, netMinor: -69_999n },
      { personId: D, netMinor: 0n },
    ];
    const transfers = suggestSettlements(balances);
    expect(transfers).toEqual([
      { fromId: C, toId: A, amountMinor: 69_999n },
      { fromId: B, toId: A, amountMinor: 30_001n },
    ]);
    // Applying them brings everyone to zero.
    const after = new Map(balances.map((b) => [b.personId, b.netMinor]));
    for (const t of transfers) {
      after.set(t.fromId, after.get(t.fromId)! + t.amountMinor);
      after.set(t.toId, after.get(t.toId)! - t.amountMinor);
    }
    expect([...after.values()].every((v) => v === 0n)).toBe(true);
    expect(transfers.length).toBeLessThanOrEqual(balances.length - 1);
  });

  it('is deterministic and handles several creditors', () => {
    const balances = [
      { personId: D, netMinor: -500n },
      { personId: A, netMinor: 300n },
      { personId: C, netMinor: -100n },
      { personId: B, netMinor: 300n },
    ];
    const once = suggestSettlements(balances);
    expect(suggestSettlements([...balances].reverse())).toEqual(once);
    expect(once).toEqual([
      { fromId: D, toId: A, amountMinor: 300n },
      { fromId: D, toId: B, amountMinor: 200n },
      { fromId: C, toId: B, amountMinor: 100n },
    ]);
  });

  it('suggests nothing when everyone is even', () => {
    expect(suggestSettlements([{ personId: A, netMinor: 0n }])).toEqual([]);
    expect(suggestSettlements([])).toEqual([]);
  });
});

describe('expense and budget input', () => {
  const base = {
    description: 'Dinner',
    category: 'food',
    amountMinor: '90000',
    currency: 'INR',
    spentOn: '2026-11-12',
  };

  it('requires payers and a split for paid expenses, and neither for planned ones', () => {
    expect(
      createExpenseSchema.safeParse({
        ...base,
        status: 'paid',
        paidBy: [{ personId: A, amountMinor: '90000' }],
        split: { method: 'equal', participants: [A, B] },
      }).success,
    ).toBe(true);
    expect(createExpenseSchema.safeParse({ ...base, status: 'paid' }).success).toBe(false);
    expect(createExpenseSchema.safeParse({ ...base, status: 'planned' }).success).toBe(true);
    expect(
      createExpenseSchema.safeParse({
        ...base,
        status: 'planned',
        paidBy: [{ personId: A, amountMinor: '90000' }],
      }).success,
    ).toBe(false);
  });

  it('refuses floats, zero, unknown currencies and server-managed fields', () => {
    for (const bad of [
      { amountMinor: '900.50' },
      { amountMinor: 900 },
      { amountMinor: '0' },
      { amountMinor: '-100' },
      { currency: 'JPY' },
      { currency: 'inr' },
      { spentOn: '2026-02-30' },
      { createdById: A },
      { tripId: A },
    ]) {
      expect(
        createExpenseSchema.safeParse({ ...base, status: 'planned', ...bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it('budgets: one amount per category, positive integers only', () => {
    expect(
      putBudgetSchema.safeParse({
        currency: 'INR',
        totalMinor: '5000000',
        categories: [{ category: 'food', amountMinor: '1000000' }],
      }).success,
    ).toBe(true);
    expect(
      putBudgetSchema.safeParse({
        currency: 'INR',
        totalMinor: '5000000',
        categories: [
          { category: 'food', amountMinor: '1' },
          { category: 'food', amountMinor: '2' },
        ],
      }).success,
    ).toBe(false);
    expect(putBudgetSchema.safeParse({ currency: 'INR', totalMinor: '0' }).success).toBe(false);
  });
});
