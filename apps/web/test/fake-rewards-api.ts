import { vi } from 'vitest';
import {
  DEFAULT_LOYALTY_RULES,
  bookingRewardsSchema,
  rewardTransactionListSchema,
  rewardsSummarySchema,
  type Booking,
  type BookingRewards,
  type RewardTransaction,
  type RewardsSummary,
  type TravelCredit,
} from '@wayora/contracts';

/*
 * A stand-in for the rewards API (Phase 25), installed over another fake's
 * `fetch` (the booking fake), so a booking's amount due changes when rewards
 * are applied, as the server would. Responses are validated against the
 * shared contract. The server's own rules are tested in apps/api.
 */

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (data: unknown) => json(200, { data, meta: { requestId: 'req-rewards' } });
const fail = (status: number, code: string, message: string) =>
  json(status, { error: { code, message, requestId: 'req-rewards' } });

const VALUE = 25n;
const MIN = 200;

export interface FakeRewardsOptions {
  balance?: number;
  /** Active INR credit, minor units. */
  credit?: string;
  credits?: TravelCredit[];
  history?: RewardTransaction[];
  /** The booking store of the booking fake, if checkout is tested. */
  bookings?: Booking[];
  tier?: Partial<RewardsSummary['accounts'][number]['tier']>;
}

export function installFakeRewardsApi(options: FakeRewardsOptions = {}) {
  const next = globalThis.fetch;
  let balance = options.balance ?? 0;
  let credit = BigInt(options.credit ?? '0');
  const applied = new Map<string, { points: number; creditMinor: bigint }>();
  const puts: Record<string, unknown>[] = [];
  const requests: string[] = [];
  const failures: { path: RegExp; status: number; code: string; message: string }[] = [];
  const history = options.history ?? [];
  const originalTotals = new Map<string, bigint>();

  const summary = (): RewardsSummary =>
    rewardsSummarySchema.parse({
      liveEnabled: false,
      rules: {
        version: 1,
        earn: {
          spendPerPoint: [{ amountMinor: '1000', currency: 'INR' }],
          categoryMultiplierBps: DEFAULT_LOYALTY_RULES.earn.categoryMultiplierBps,
          campaigns: [],
          availableAfterDays: 1,
          expiryMonths: 24,
        },
        redeem: {
          pointValue: [{ amountMinor: '25', currency: 'INR' }],
          minPoints: MIN,
          maxPointsPerBooking: 20_000,
          maxPointsCoverageBps: 5_000,
          categories: DEFAULT_LOYALTY_RULES.redeem.categories,
        },
        tiers: DEFAULT_LOYALTY_RULES.tiers,
        qualificationMonths: 12,
      },
      accounts: [
        {
          mode: 'demo',
          pointsBalance: balance,
          balanceValue: [{ amountMinor: (BigInt(balance) * VALUE).toString(), currency: 'INR' }],
          tier: {
            id: 'explorer',
            name: 'Explorer',
            earnMultiplierBps: 10_000,
            qualifyingPoints: 500,
            keptUntil: null,
            next: { id: 'silver', name: 'Silver', minQualifyingPoints: 2_000, pointsNeeded: 1_500 },
            ...options.tier,
          },
          pending: [],
          expiring: [],
          credits: options.credits ?? [],
          creditBalance: credit > 0n ? [{ amountMinor: credit.toString(), currency: 'INR' }] : [],
          monthly: Array.from({ length: 12 }, (_, i) => ({
            month: `2026-${String(i + 1).padStart(2, '0')}`,
            earned: i === 9 ? 500 : 0,
            redeemed: 0,
          })),
        },
      ],
    });

  const bookingOf = (reference: string) => options.bookings?.find((b) => b.reference === reference);

  const quote = (reference: string): BookingRewards => {
    const b = bookingOf(reference)!;
    const totalMinor = originalTotals.get(reference) ?? BigInt(b.payment.amount!.amountMinor);
    originalTotals.set(reference, totalMinor);
    const a = applied.get(reference);
    const heldPoints = a?.points ?? 0;
    const heldCredit = a?.creditMinor ?? 0n;
    const usable = BigInt(balance + heldPoints);
    const caps = [
      usable,
      20_000n,
      (totalMinor * 5_000n) / 10_000n / VALUE,
      (totalMinor - 100n) / VALUE,
    ];
    let max = caps.reduce((x, y) => (y < x ? y : x));
    if (max < BigInt(MIN)) max = 0n;
    const available = b.payment.canPay;
    const appliedTotal = a ? BigInt(a.points) * VALUE + a.creditMinor : 0n;
    const room = totalMinor - 100n;
    return bookingRewardsSchema.parse({
      available,
      reason: available ? null : 'Rewards can only be used before a booking is paid.',
      mode: 'demo',
      total: { amountMinor: totalMinor.toString(), currency: 'INR' },
      points: {
        balance: Number(usable),
        min: MIN,
        max: available ? Number(max) : 0,
        value: { amountMinor: '25', currency: 'INR' },
      },
      credit: {
        available: { amountMinor: (credit + heldCredit).toString(), currency: 'INR' },
        max: {
          amountMinor: (available
            ? credit + heldCredit < room
              ? credit + heldCredit
              : room
            : 0n
          ).toString(),
          currency: 'INR',
        },
      },
      applied: a
        ? {
            status: 'applied',
            points: a.points,
            pointsAmount: { amountMinor: (BigInt(a.points) * VALUE).toString(), currency: 'INR' },
            creditAmount: { amountMinor: a.creditMinor.toString(), currency: 'INR' },
            total: { amountMinor: appliedTotal.toString(), currency: 'INR' },
          }
        : null,
      payable: { amountMinor: (totalMinor - appliedTotal).toString(), currency: 'INR' },
      ruleVersion: 1,
    });
  };

  /** Updates the booking fake's record as the server would (amount due, rewards). */
  const syncBooking = (reference: string) => {
    const b = bookingOf(reference);
    if (!b) return;
    const q = quote(reference);
    Object.assign(b, {
      payment: {
        ...b.payment,
        amount: q.payable,
        rewards: q.applied ? { points: q.applied.points, amount: q.applied.total } : null,
      },
    });
  };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace('/api/v1', '');
    const forBooking = /^\/bookings\/([^/]+)\/rewards$/.exec(path);
    if (path.startsWith('/rewards') || forBooking) {
      requests.push(`${method} ${path}${url.search}`);
      const failure = failures.find((f) => f.path.test(path));
      if (failure) {
        failures.splice(failures.indexOf(failure), 1);
        return fail(failure.status, failure.code, failure.message);
      }
    }
    if (path === '/rewards' && method === 'GET') return ok(summary());
    if (path === '/rewards/transactions' && method === 'GET') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
      const kind = url.searchParams.get('kind') ?? 'all';
      const items = history.filter((t) =>
        kind === 'points'
          ? t.type.startsWith('points_')
          : kind === 'credits'
            ? t.type.startsWith('credit_')
            : true,
      );
      return ok(
        rewardTransactionListSchema.parse({
          items: items.slice((page - 1) * pageSize, page * pageSize),
          pagination: {
            page,
            pageSize,
            totalResults: items.length,
            totalPages: Math.ceil(items.length / pageSize),
          },
        }),
      );
    }
    if (forBooking) {
      const reference = decodeURIComponent(forBooking[1]!);
      if (!bookingOf(reference)) return fail(404, 'NOT_FOUND', "We couldn't find that booking.");
      if (method === 'GET') return ok(quote(reference));
      const previous = applied.get(reference);
      if (previous) {
        balance += previous.points;
        credit += previous.creditMinor;
        applied.delete(reference);
      }
      if (method === 'DELETE') {
        syncBooking(reference);
        return ok(quote(reference));
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        points: number;
        creditAmountMinor: string;
        confirm?: boolean;
      };
      puts.push(body);
      const q = quote(reference);
      const creditMinor = BigInt(body.creditAmountMinor);
      if (body.points > 0 && body.points < MIN) {
        if (previous) applied.set(reference, previous);
        return fail(400, 'BAD_REQUEST', `Use at least ${MIN} points, or none.`);
      }
      if (body.points > q.points.max) {
        return fail(
          400,
          'BAD_REQUEST',
          `You can use at most ${q.points.max} points on this booking.`,
        );
      }
      balance -= body.points;
      credit -= creditMinor;
      if (body.points > 0 || creditMinor > 0n)
        applied.set(reference, { points: body.points, creditMinor });
      syncBooking(reference);
      return ok(quote(reference));
    }
    return next(input, init);
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    puts,
    requests,
    get balance() {
      return balance;
    },
    /** Answer the next request whose path matches with an error. */
    failNext(path: RegExp, status = 503, code = 'SERVICE_UNAVAILABLE', message = 'Try again.') {
      failures.push({ path, status, code, message });
    },
  };
}
