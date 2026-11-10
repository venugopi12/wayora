import {
  FUNNEL_STAGES,
  catalogDestination,
  findPlace,
  type AnalyticsMode,
  type AnalyticsNote,
  type AnalyticsPeriod,
  type AnalyticsQuery,
  type AnalyticsRate,
  type AnalyticsReport,
  type AnalyticsReports,
  type ComparedMoney,
  type Coverage,
  type CustomersReport,
  type FunnelReport,
  type FunnelStage,
  type MarketingReport,
  type OverviewReport,
  type ProvidersReport,
  type ReportMeta,
  type RevenueLine,
  type RevenueReport,
  type SearchReport,
  type SearchServiceType,
  type Series,
  type SupportReport,
  type Trend,
} from '@wayora/contracts';
import type { PrismaClient } from '@wayora/database';
import { SERVICE_TYPE } from '../../utils/categories.js';
import {
  CACHE_VERSION,
  MemoryAnalyticsCache,
  TTL_CLOSED_PERIOD_SECONDS,
  TTL_OPEN_PERIOD_SECONDS,
  type AnalyticsCache,
} from './cache.js';
import {
  bucketIndex,
  bucketLabel,
  bucketStarts,
  resolveRange,
  type ResolvedRange,
} from './range.js';

/*
 * Analytics reports (docs/analytics.md). Read-only aggregates over the
 * authoritative tables (users, bookings, payments, refunds, redemptions,
 * reservations, tickets, reviews) and the recorded events (analytics_events,
 * search_events, content_daily_counts). Nothing here runs on a booking or
 * payment request: reports are computed when staff open them, bounded to a
 * period of at most a year, and cached briefly.
 *
 * Rules every report follows:
 * - demo and real figures are separate fields, never summed;
 * - money stays in minor units (BigInt) and per currency;
 * - a figure that wasn't recorded is null (with a note), never 0;
 * - nothing is back-filled: event-based figures start when tracking did.
 */

/** What the viewer's role may see in a report. Part of the cache key. */
export interface AnalyticsScope {
  financial: boolean;
  support: boolean;
  reviews: boolean;
}

export interface ProviderInfo {
  id: string;
  name: string;
  kind: 'live' | 'demo';
}

export interface AnalyticsServiceOptions {
  prisma: PrismaClient;
  timezone: string;
  cache?: AnalyticsCache;
  /** Registered search providers (live or demo), for labelling provider figures. */
  providers?: () => readonly ProviderInfo[];
  now?: () => Date;
}

/** Route pairs and travel months are listed only when searched at least this often. */
export const MIN_GROUP_SIZE = 5;

const SUCCEEDED_PAYMENT = ['SUCCEEDED', 'REFUND_PENDING', 'REFUNDED'];
const PENDING_REFUND = ['REQUIRED', 'REQUESTED', 'PENDING', 'UNKNOWN'];
const TRACKING_MARKER = 'analytics.tracking_started';
const ACTIVE_TYPES = ['user.active', 'user.login', 'user.registered'];

type Window = { start: Date; end: Date };
const win = (p: AnalyticsPeriod): Window => ({ start: new Date(p.start), end: new Date(p.end) });
const MODES: AnalyticsMode[] = ['real', 'demo'];
const modeOf = (demo: boolean): AnalyticsMode => (demo ? 'demo' : 'real');

export const ratio = (n: number, d: number) => (d > 0 ? n / d : null);
export function rate(n: number, d: number, previous: number | null = null): AnalyticsRate {
  return { numerator: n, denominator: d, value: ratio(n, d), previous };
}

/** Exact average in minor units, rounded half up. */
export function averageMinor(total: bigint, count: number): bigint {
  if (count <= 0) return 0n;
  const c = BigInt(count);
  return (total * 2n + c) / (2n * c);
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Per-currency amounts → compared money lines (every currency seen in either period). */
function comparedMoney(
  current: Map<string, bigint>,
  previous: Map<string, bigint> | null,
): ComparedMoney[] {
  const currencies = [...new Set([...current.keys(), ...(previous?.keys() ?? [])])].sort();
  return currencies.map((c) => ({
    currency: c,
    amountMinor: (current.get(c) ?? 0n).toString(),
    previousMinor: previous ? (previous.get(c) ?? 0n).toString() : null,
  }));
}

const moneyOf = (currency: string, current: bigint, previous: bigint | null): ComparedMoney => ({
  currency,
  amountMinor: current.toString(),
  previousMinor: previous === null ? null : previous.toString(),
});

const big = (v: string | null | undefined) => (v ? BigInt(v) : 0n);

export class AnalyticsService {
  private readonly prisma: PrismaClient;
  private readonly cache: AnalyticsCache;
  private readonly now: () => Date;
  readonly timezone: string;

  constructor(private readonly options: AnalyticsServiceOptions) {
    this.prisma = options.prisma;
    this.timezone = options.timezone;
    this.cache = options.cache ?? new MemoryAnalyticsCache();
    this.now = options.now ?? (() => new Date());
  }

  resolve(query: AnalyticsQuery): ResolvedRange {
    return resolveRange(query, this.timezone, this.now());
  }

  /** A report for a query, from the cache when a fresh copy exists. */
  async report<R extends AnalyticsReport>(
    report: R,
    query: AnalyticsQuery,
    scope: AnalyticsScope,
  ): Promise<AnalyticsReports[R]> {
    const range = this.resolve(query);
    const scopeKey = `${+scope.financial}${+scope.support}${+scope.reviews}`;
    const key = `analytics:${CACHE_VERSION}:${report}:${scopeKey}:${range.key}`;
    const hit = await this.cache.get(key);
    if (hit) return JSON.parse(hit) as AnalyticsReports[R];
    const result = await this.compute(report, range, scope);
    await this.cache.set(
      key,
      JSON.stringify(result),
      range.period.partial ? TTL_OPEN_PERIOD_SECONDS : TTL_CLOSED_PERIOD_SECONDS,
    );
    return result;
  }

  compute<R extends AnalyticsReport>(
    report: R,
    range: ResolvedRange,
    scope: AnalyticsScope,
  ): Promise<AnalyticsReports[R]> {
    const run: { [K in AnalyticsReport]: () => Promise<AnalyticsReports[K]> } = {
      overview: () => this.overview(range, scope),
      revenue: () => this.revenue(range),
      funnel: () => this.funnel(range),
      search: () => this.search(range),
      customers: () => this.customers(range),
      providers: () => this.providers(range),
      marketing: () => this.marketing(range),
      support: () => this.support(range, scope),
    };
    return run[report]() as Promise<AnalyticsReports[R]>;
  }

  // ─── Shared pieces ────────────────────────────────────────────────────

  private meta(range: ResolvedRange): ReportMeta {
    return {
      timezone: range.timezone,
      period: range.period,
      previous: range.previous,
      granularity: range.granularity,
      generatedAt: this.now().toISOString(),
    };
  }

  /** When event tracking began (or, after a retention purge, since when events are complete). */
  async eventsSince(): Promise<Date | null> {
    const row = await this.prisma.analyticsEvent.findUnique({
      where: { dedupeKey: TRACKING_MARKER },
      select: { occurredAt: true },
    });
    return row?.occurredAt ?? null;
  }

  async searchesSince(): Promise<Date | null> {
    const row = await this.prisma.searchEvent.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    return row?.createdAt ?? null;
  }

  private coverage(since: Date | null, p: AnalyticsPeriod): Coverage {
    return {
      since: since?.toISOString() ?? null,
      complete: since !== null && since.getTime() <= Date.parse(p.start),
    };
  }

  /** Empty buckets for both periods. */
  private buckets(range: ResolvedRange) {
    const cur = bucketStarts(range.period.from, range.period.to, range.granularity);
    const prev = bucketStarts(range.previous.from, range.previous.to, range.granularity);
    return { cur, prev };
  }

  /**
   * A series from per-day counts: each local day is added to its bucket.
   * Buckets that end before `since` (data not recorded yet) are null.
   */
  private series(
    key: string,
    label: string,
    starts: readonly string[],
    to: string,
    perDay: { day: string; n: number }[],
    since: Date | null,
  ): Series {
    const points: (number | null)[] = starts.map(() => 0);
    for (const { day, n } of perDay) {
      const i = bucketIndex(starts, day);
      if (i >= 0 && day <= to) points[i] = (points[i] ?? 0) + n;
    }
    const sinceDay = since ? this.dayOf(since) : null;
    return {
      key,
      label,
      points: points.map((v, i) => {
        const bucketEnd = i + 1 < starts.length ? starts[i + 1]! : '9999-12-31';
        // Not recorded at all yet when this bucket ended.
        if (sinceDay === null || sinceDay >= bucketEnd) return null;
        return v;
      }),
    };
  }

  /** A moment for notes: "10 Nov 2026, 18:41 (Asia/Kolkata)". */
  private when(at: Date): string {
    const text = new Intl.DateTimeFormat('en-GB', {
      timeZone: this.timezone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(at);
    return `${text} (${this.timezone})`;
  }

  private dayOf(at: Date): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  }

  private trend(
    range: ResolvedRange,
    defs: {
      key: string;
      label: string;
      cur: { day: string; n: number }[];
      prev: { day: string; n: number }[];
      since: Date | null;
    }[],
  ): Trend {
    const { cur, prev } = this.buckets(range);
    return {
      buckets: cur.map((start) => ({ start, label: bucketLabel(start, range.granularity) })),
      series: defs.map((d) => this.series(d.key, d.label, cur, range.period.to, d.cur, d.since)),
      previous: defs.map((d) =>
        this.series(d.key, d.label, prev, range.previous.to, d.prev, d.since),
      ),
    };
  }

  /** Rows per local day for a timestamp column (`sql` selects `ts`). */
  private async perDay(
    table: string,
    column: string,
    where: string,
    w: Window,
    count = 'count(*)',
  ): Promise<{ day: string; n: number }[]> {
    // Table, column and filter are fixed strings in this file (never input).
    const rows = await this.prisma.$queryRawUnsafe<{ day: string; n: number }[]>(
      `SELECT to_char((${column} AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day, ${count}::int AS n
         FROM ${table}
        WHERE ${column} >= $2 AND ${column} < $3 ${where ? `AND ${where}` : ''}
        GROUP BY 1 ORDER BY 1`,
      this.timezone,
      w.start,
      w.end,
    );
    return rows;
  }

  private async count(table: string, column: string, where: string, w: Window): Promise<number> {
    const [row] = await this.prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM ${table}
        WHERE ${column} >= $1 AND ${column} < $2 ${where ? `AND ${where}` : ''}`,
      w.start,
      w.end,
    );
    return row?.n ?? 0;
  }

  /** Customers counted as active: a sign-in, a registration or a day of use. */
  private async activeUsers(w: Window): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(DISTINCT user_id)::int AS n FROM analytics_events
       WHERE type = ANY(${ACTIVE_TYPES}) AND occurred_at >= ${w.start} AND occurred_at < ${w.end}
         AND user_id IS NOT NULL`;
    return row?.n ?? 0;
  }

  private async activePerBucket(
    w: Window,
    starts: readonly string[],
  ): Promise<{ day: string; n: number }[]> {
    // Distinct customers per bucket: (day, user) pairs, folded into buckets here.
    const rows = await this.prisma.$queryRaw<{ day: string; user_id: string }[]>`
      SELECT DISTINCT to_char((occurred_at AT TIME ZONE ${this.timezone})::date, 'YYYY-MM-DD') AS day, user_id::text
        FROM analytics_events
       WHERE type = ANY(${ACTIVE_TYPES}) AND occurred_at >= ${w.start} AND occurred_at < ${w.end}
         AND user_id IS NOT NULL`;
    const sets = starts.map(() => new Set<string>());
    for (const r of rows) {
      const i = bucketIndex(starts, r.day);
      if (i >= 0) sets[i]!.add(r.user_id);
    }
    // Reported against the bucket's first day, so `series` puts it back in the same bucket.
    return sets.map((s, i) => ({ day: starts[i]!, n: s.size }));
  }

  /** Searches: distinct sessions plus failed requests (which have no session). */
  private async searchCounts(w: Window): Promise<{ searches: number; requests: number }> {
    const [row] = await this.prisma.$queryRaw<{ searches: number; requests: number }[]>`
      SELECT (count(DISTINCT search_id) + count(*) FILTER (WHERE search_id IS NULL))::int AS searches,
             count(*)::int AS requests
        FROM search_events WHERE created_at >= ${w.start} AND created_at < ${w.end}`;
    return row ?? { searches: 0, requests: 0 };
  }

  private async searchesPerDay(w: Window) {
    return this.prisma.$queryRaw<{ day: string; n: number }[]>`
      SELECT day, count(*)::int AS n FROM (
        SELECT to_char((min(created_at) AT TIME ZONE ${this.timezone})::date, 'YYYY-MM-DD') AS day
          FROM search_events
         WHERE created_at >= ${w.start} AND created_at < ${w.end}
         GROUP BY coalesce(search_id, id)
      ) s GROUP BY day ORDER BY day`;
  }

  /** Distinct searches in the window and how many led to a booking (any kind). */
  private async conversion(w: Window): Promise<{ searches: number; converted: number }> {
    const [row] = await this.prisma.$queryRaw<{ searches: number; converted: number }[]>`
      SELECT count(DISTINCT se.search_id)::int AS searches,
             count(DISTINCT se.search_id) FILTER (
               WHERE EXISTS (SELECT 1 FROM bookings b WHERE b.search_id = se.search_id)
             )::int AS converted
        FROM search_events se
       WHERE se.created_at >= ${w.start} AND se.created_at < ${w.end} AND se.search_id IS NOT NULL`;
    return row ?? { searches: 0, converted: 0 };
  }

  // ─── Overview ─────────────────────────────────────────────────────────

  async overview(range: ResolvedRange, scope: AnalyticsScope): Promise<OverviewReport> {
    const cw = win(range.period);
    const pw = win(range.previous);
    const { cur: curBuckets } = this.buckets(range);
    const prevBuckets = bucketStarts(range.previous.from, range.previous.to, range.granularity);
    const [
      eventsSince,
      searchesSince,
      usersTotal,
      newCur,
      newPrev,
      activeCur,
      activePrev,
      searchCur,
      searchPrev,
      convCur,
      convPrev,
      bookingsCur,
      bookingsPrev,
      cancelled,
      supplierCur,
      supplierPrev,
      payCur,
      payPrev,
    ] = await Promise.all([
      this.eventsSince(),
      this.searchesSince(),
      this.prisma.user.count({ where: { role: 'USER', createdAt: { lt: cw.end } } }),
      this.count('users', 'created_at', `role = 'USER'`, cw),
      this.count('users', 'created_at', `role = 'USER'`, pw),
      this.activeUsers(cw),
      this.activeUsers(pw),
      this.searchCounts(cw),
      this.searchCounts(pw),
      this.conversion(cw),
      this.conversion(pw),
      this.bookingsBy(cw),
      this.bookingsBy(pw),
      this.prisma.$queryRaw<{ demo: boolean; n: number }[]>`
        SELECT is_demo AS demo, count(*)::int AS n FROM bookings
         WHERE cancelled_at >= ${cw.start} AND cancelled_at < ${cw.end} GROUP BY 1`,
      this.count('supplier_reservations', 'confirmed_at', '', cw),
      this.count('supplier_reservations', 'confirmed_at', '', pw),
      this.paymentOutcomes(cw),
      this.paymentOutcomes(pw),
    ]);
    const activeCoverage = this.coverage(eventsSince, range.period);
    const searchCoverage = this.coverage(searchesSince, range.period);
    const prevActiveCovered = this.coverage(eventsSince, range.previous).complete;
    const prevSearchCovered = this.coverage(searchesSince, range.previous).complete;

    const [searchDays, searchDaysPrev, bookingDays, bookingDaysPrev, userDays, userDaysPrev] =
      await Promise.all([
        this.searchesPerDay(cw),
        this.searchesPerDay(pw),
        this.bookingsPerDay(cw),
        this.bookingsPerDay(pw),
        this.perDay('users', 'created_at', `role = 'USER'`, cw),
        this.perDay('users', 'created_at', `role = 'USER'`, pw),
      ]);
    const [activeDays, activeDaysPrev] = await Promise.all([
      this.activePerBucket(cw, curBuckets),
      this.activePerBucket(pw, prevBuckets),
    ]);
    const firstBooking = new Date(0); // bookings and users are complete records
    const trend = this.trend(range, [
      {
        key: 'searches',
        label: 'Searches',
        cur: searchDays,
        prev: searchDaysPrev,
        since: searchesSince,
      },
      {
        key: 'bookings_real',
        label: 'Real bookings',
        cur: bookingDays.filter((d) => !d.demo),
        prev: bookingDaysPrev.filter((d) => !d.demo),
        since: firstBooking,
      },
      {
        key: 'bookings_demo',
        label: 'Demo bookings',
        cur: bookingDays.filter((d) => d.demo),
        prev: bookingDaysPrev.filter((d) => d.demo),
        since: firstBooking,
      },
      {
        key: 'new_users',
        label: 'New customers',
        cur: userDays,
        prev: userDaysPrev,
        since: firstBooking,
      },
      {
        key: 'active_users',
        label: 'Active customers',
        cur: activeDays,
        prev: activeDaysPrev,
        since: eventsSince,
      },
    ]);

    const notes: AnalyticsNote[] = [];
    if (!activeCoverage.complete) {
      notes.push({
        metric: 'Active customers',
        reason: eventsSince
          ? `Activity is recorded from ${this.when(eventsSince)}; earlier activity was never stored, so this period is only partly covered.`
          : 'Activity tracking has not started yet.',
      });
    }
    if (!searchCoverage.complete) {
      notes.push({
        metric: 'Searches',
        reason: searchesSince
          ? `Searches are recorded from ${this.when(searchesSince)}; earlier searches were never stored.`
          : 'No searches have been recorded yet.',
      });
    }
    let money: OverviewReport['money'] = null;
    if (scope.financial) {
      money = await this.overviewMoney(cw, pw);
      if (!money.find((m) => m.mode === 'real')?.collected.length) {
        notes.push({
          metric: 'Real revenue',
          reason:
            'No real (live) payment has succeeded in this period. Demo payments are simulated: they are shown separately and are never money.',
        });
      }
    } else {
      notes.push({
        metric: 'Money figures',
        reason: 'Booking value, payments and refunds are visible to administrators only.',
      });
    }

    const split = (rows: { demo: boolean; n: number }[], demo: boolean) =>
      rows.find((r) => r.demo === demo)?.n ?? 0;
    return {
      ...this.meta(range),
      users: {
        total: usersTotal,
        new: { value: newCur, previous: newPrev },
        active: { value: activeCur, previous: prevActiveCovered ? activePrev : null },
        activeCoverage,
      },
      searches: {
        total: {
          value: searchCur.searches,
          previous: prevSearchCovered ? searchPrev.searches : null,
        },
        requests: searchCur.requests,
        coverage: searchCoverage,
      },
      conversion: rate(
        convCur.converted,
        convCur.searches,
        prevSearchCovered ? ratio(convPrev.converted, convPrev.searches) : null,
      ),
      bookings: {
        created: {
          real: { value: split(bookingsCur, false), previous: split(bookingsPrev, false) },
          demo: { value: split(bookingsCur, true), previous: split(bookingsPrev, true) },
        },
        cancelled: { real: split(cancelled, false), demo: split(cancelled, true) },
        supplierConfirmed: { value: supplierCur, previous: supplierPrev },
      },
      payments: {
        successRate: {
          real: rate(payCur.real.ok, payCur.real.done, ratio(payPrev.real.ok, payPrev.real.done)),
          demo: rate(payCur.demo.ok, payCur.demo.done, ratio(payPrev.demo.ok, payPrev.demo.done)),
        },
      },
      money,
      trend,
      notes,
    };
  }

  private bookingsBy(w: Window) {
    return this.prisma.$queryRaw<{ demo: boolean; n: number }[]>`
      SELECT is_demo AS demo, count(*)::int AS n FROM bookings
       WHERE created_at >= ${w.start} AND created_at < ${w.end} GROUP BY 1`;
  }

  private bookingsPerDay(w: Window) {
    return this.prisma.$queryRaw<{ day: string; demo: boolean; n: number }[]>`
      SELECT to_char((created_at AT TIME ZONE ${this.timezone})::date, 'YYYY-MM-DD') AS day,
             is_demo AS demo, count(*)::int AS n
        FROM bookings WHERE created_at >= ${w.start} AND created_at < ${w.end}
       GROUP BY 1, 2 ORDER BY 1`;
  }

  /** Payment attempts created in the window that have finished, by mode. */
  private async paymentOutcomes(w: Window) {
    const rows = await this.prisma.$queryRaw<{ demo: boolean; ok: number; done: number }[]>`
      SELECT mode = 'DEMO' AS demo,
             count(*) FILTER (WHERE status::text = ANY(${SUCCEEDED_PAYMENT}))::int AS ok,
             count(*) FILTER (WHERE status::text = ANY(${[...SUCCEEDED_PAYMENT, 'FAILED', 'CANCELLED']}))::int AS done
        FROM payments WHERE created_at >= ${w.start} AND created_at < ${w.end} GROUP BY 1`;
    const of = (demo: boolean) => rows.find((r) => r.demo === demo) ?? { ok: 0, done: 0 };
    return { real: of(false), demo: of(true) };
  }

  /** Per mode and currency sums for overview money. */
  private async overviewMoney(
    cw: Window,
    pw: Window,
  ): Promise<NonNullable<OverviewReport['money']>> {
    const [cur, prev] = await Promise.all([this.moneyTotals(cw), this.moneyTotals(pw)]);
    return MODES.map((mode) => {
      const c = cur.get(mode)!;
      const p = prev.get(mode)!;
      const avgOf = (t: MoneyTotals) =>
        new Map([...t.gbv].map(([cur, v]) => [cur, averageMinor(v, t.priced.get(cur) ?? 0)]));
      return {
        mode,
        grossBookingValue: comparedMoney(c.gbv, p.gbv),
        collected: comparedMoney(c.collected, p.collected),
        refunded: comparedMoney(c.refunded, p.refunded),
        averageBookingValue: comparedMoney(avgOf(c), avgOf(p)),
      };
    });
  }

  private async moneyTotals(w: Window): Promise<Map<AnalyticsMode, MoneyTotals>> {
    const [gbv, collected, refunded] = await Promise.all([
      this.prisma.$queryRaw<{ demo: boolean; currency: string; total: string; n: number }[]>`
        SELECT is_demo AS demo, currency, sum(total_amount_minor)::text AS total, count(*)::int AS n
          FROM bookings
         WHERE confirmed_at >= ${w.start} AND confirmed_at < ${w.end} AND total_amount_minor IS NOT NULL
         GROUP BY 1, 2`,
      this.prisma.$queryRaw<{ demo: boolean; currency: string; total: string }[]>`
        SELECT mode = 'DEMO' AS demo, currency, sum(amount_minor)::text AS total
          FROM payments
         WHERE completed_at >= ${w.start} AND completed_at < ${w.end}
           AND status::text = ANY(${SUCCEEDED_PAYMENT})
         GROUP BY 1, 2`,
      this.prisma.$queryRaw<{ demo: boolean; currency: string; total: string }[]>`
        SELECT mode = 'DEMO' AS demo, currency, sum(amount_minor)::text AS total
          FROM refunds
         WHERE completed_at >= ${w.start} AND completed_at < ${w.end} AND status = 'SUCCEEDED'
         GROUP BY 1, 2`,
    ]);
    const out = new Map<AnalyticsMode, MoneyTotals>();
    for (const mode of MODES)
      out.set(mode, {
        gbv: new Map(),
        priced: new Map(),
        collected: new Map(),
        refunded: new Map(),
      });
    for (const r of gbv) {
      const t = out.get(modeOf(r.demo))!;
      t.gbv.set(r.currency, big(r.total));
      t.priced.set(r.currency, r.n);
    }
    for (const r of collected) out.get(modeOf(r.demo))!.collected.set(r.currency, big(r.total));
    for (const r of refunded) out.get(modeOf(r.demo))!.refunded.set(r.currency, big(r.total));
    return out;
  }

  // ─── Revenue ──────────────────────────────────────────────────────────

  async revenue(range: ResolvedRange): Promise<RevenueReport> {
    const cw = win(range.period);
    const pw = win(range.previous);
    const [cur, prev, pending, collectedDays, refundedDays, collectedPrev, refundedPrev] =
      await Promise.all([
        this.revenueFigures(cw),
        this.revenueFigures(pw),
        this.prisma.$queryRaw<{ demo: boolean; currency: string; total: string; n: number }[]>`
          SELECT mode = 'DEMO' AS demo, currency, sum(amount_minor)::text AS total, count(*)::int AS n
            FROM refunds
           WHERE created_at >= ${cw.start} AND created_at < ${cw.end}
             AND status::text = ANY(${PENDING_REFUND})
           GROUP BY 1, 2`,
        this.moneyPerDay(
          'payments',
          `status::text IN ('SUCCEEDED','REFUND_PENDING','REFUNDED')`,
          cw,
        ),
        this.moneyPerDay('refunds', `status = 'SUCCEEDED'`, cw),
        this.moneyPerDay(
          'payments',
          `status::text IN ('SUCCEEDED','REFUND_PENDING','REFUNDED')`,
          pw,
        ),
        this.moneyPerDay('refunds', `status = 'SUCCEEDED'`, pw),
      ]);

    const modes = MODES.map((mode) => {
      const c = cur.get(mode)!;
      const p = prev.get(mode)!;
      const currencies = [...new Set([...c.keys(), ...p.keys()])].sort();
      const lines: RevenueLine[] = currencies.map((currency) => {
        const a = c.get(currency) ?? emptyFigures();
        const b = p.get(currency) ?? emptyFigures();
        const pend = pending.find((r) => modeOf(r.demo) === mode && r.currency === currency);
        const m = (k: keyof Omit<RevenueFigures, 'confirmed' | 'unpriced'>) =>
          moneyOf(currency, a[k], b[k]);
        return {
          currency,
          grossBookingValue: m('gbv'),
          confirmedBookings: { value: a.confirmed, previous: b.confirmed },
          unpricedBookings: a.unpriced,
          promotionDiscount: m('promotion'),
          couponDiscount: m('coupon'),
          pointsRedeemed: m('points'),
          travelCreditUsed: m('credit'),
          paymentsSucceeded: m('paid'),
          refundsCompleted: m('refunded'),
          refundsPending: { amountMinor: big(pend?.total).toString(), count: pend?.n ?? 0 },
          netCollected: moneyOf(currency, a.paid - a.refunded, b.paid - b.refunded),
          averageBookingValue: moneyOf(
            currency,
            averageMinor(a.gbv, a.confirmed),
            averageMinor(b.gbv, b.confirmed),
          ),
        };
      });
      return { mode, lines };
    });

    const trends: RevenueReport['trends'] = [];
    for (const mode of MODES) {
      const currencies = new Set(
        [...collectedDays, ...refundedDays, ...collectedPrev, ...refundedPrev]
          .filter((r) => modeOf(r.demo) === mode)
          .map((r) => r.currency),
      );
      for (const currency of [...currencies].sort()) {
        const pick = (rows: MoneyDay[]) =>
          rows
            .filter((r) => modeOf(r.demo) === mode && r.currency === currency)
            .map((r) => ({ day: r.day, n: Number(BigInt(r.total)) }));
        trends.push({
          mode,
          currency,
          trend: this.trend(range, [
            {
              key: 'collected',
              label: 'Payments succeeded',
              cur: pick(collectedDays),
              prev: pick(collectedPrev),
              since: new Date(0),
            },
            {
              key: 'refunded',
              label: 'Refunds completed',
              cur: pick(refundedDays),
              prev: pick(refundedPrev),
              since: new Date(0),
            },
          ]),
        });
      }
    }

    const notes: AnalyticsNote[] = [
      {
        metric: 'Booking value is not revenue',
        reason:
          'Gross booking value is the price of bookings confirmed in the period before discounts. It is not money received and not profit.',
      },
      {
        metric: 'Provider cost and commission',
        reason:
          'Not available: no supplier cost or commission is recorded, so margin and profit can’t be calculated.',
      },
      {
        metric: 'Loyalty and travel credit',
        reason:
          'Points and travel credit used are discounts on the price, shown at their value at redemption. They are not counted as an expense or as cash; travel credit is never a cash refund.',
      },
      {
        metric: 'Pending refunds',
        reason:
          'Refunds created in the period that haven’t succeeded yet. They are not deducted from net collected until they complete.',
      },
    ];
    const real = modes.find((m) => m.mode === 'real')!;
    if (!real.lines.some((l) => l.paymentsSucceeded.amountMinor !== '0')) {
      notes.unshift({
        metric: 'Real revenue',
        reason:
          'No real (live) payment succeeded in this period. Demo figures are simulated: no money moved.',
      });
    }
    return { ...this.meta(range), modes, trends, notes };
  }

  private moneyPerDay(table: 'payments' | 'refunds', where: string, w: Window) {
    return this.prisma.$queryRawUnsafe<MoneyDay[]>(
      `SELECT to_char((completed_at AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day,
              mode = 'DEMO' AS demo, currency, sum(amount_minor)::text AS total
         FROM ${table}
        WHERE completed_at >= $2 AND completed_at < $3 AND ${where}
        GROUP BY 1, 2, 3 ORDER BY 1`,
      this.timezone,
      w.start,
      w.end,
    );
  }

  /** Every revenue figure for a window, by mode and currency. */
  private async revenueFigures(
    w: Window,
  ): Promise<Map<AnalyticsMode, Map<string, RevenueFigures>>> {
    const [booked, promos, rewards, paid, refunded] = await Promise.all([
      this.prisma.$queryRaw<
        {
          demo: boolean;
          currency: string;
          total: string | null;
          priced: number;
          unpriced: number;
        }[]
      >`
        SELECT is_demo AS demo, currency, sum(total_amount_minor)::text AS total,
               count(total_amount_minor)::int AS priced,
               count(*) FILTER (WHERE total_amount_minor IS NULL)::int AS unpriced
          FROM bookings WHERE confirmed_at >= ${w.start} AND confirmed_at < ${w.end}
         GROUP BY 1, 2`,
      // Discounts of the bookings confirmed in the window (same basis as booking value).
      this.prisma.$queryRaw<{ demo: boolean; currency: string; kind: string; total: string }[]>`
        SELECT b.is_demo AS demo, pr.currency, pr.kind::text AS kind, sum(pr.discount_minor)::text AS total
          FROM promotion_redemptions pr JOIN bookings b ON b.id = pr.booking_id
         WHERE pr.status = 'REDEEMED' AND b.confirmed_at >= ${w.start} AND b.confirmed_at < ${w.end}
         GROUP BY 1, 2, 3`,
      this.prisma.$queryRaw<{ demo: boolean; currency: string; points: string; credit: string }[]>`
        SELECT rr.mode = 'DEMO' AS demo, rr.currency,
               sum(rr.points_amount_minor)::text AS points, sum(rr.credit_amount_minor)::text AS credit
          FROM reward_redemptions rr JOIN bookings b ON b.id = rr.booking_id
         WHERE rr.status = 'CONSUMED' AND b.confirmed_at >= ${w.start} AND b.confirmed_at < ${w.end}
         GROUP BY 1, 2`,
      this.prisma.$queryRaw<{ demo: boolean; currency: string; total: string }[]>`
        SELECT mode = 'DEMO' AS demo, currency, sum(amount_minor)::text AS total FROM payments
         WHERE completed_at >= ${w.start} AND completed_at < ${w.end}
           AND status::text = ANY(${SUCCEEDED_PAYMENT})
         GROUP BY 1, 2`,
      this.prisma.$queryRaw<{ demo: boolean; currency: string; total: string }[]>`
        SELECT mode = 'DEMO' AS demo, currency, sum(amount_minor)::text AS total FROM refunds
         WHERE completed_at >= ${w.start} AND completed_at < ${w.end} AND status = 'SUCCEEDED'
         GROUP BY 1, 2`,
    ]);
    const out = new Map<AnalyticsMode, Map<string, RevenueFigures>>(
      MODES.map((m) => [m, new Map()]),
    );
    const at = (demo: boolean, currency: string) => {
      const m = out.get(modeOf(demo))!;
      let f = m.get(currency);
      if (!f) m.set(currency, (f = emptyFigures()));
      return f;
    };
    for (const r of booked) {
      const f = at(r.demo, r.currency);
      f.gbv += big(r.total);
      f.confirmed += r.priced;
      f.unpriced += r.unpriced;
    }
    for (const r of promos) {
      const f = at(r.demo, r.currency);
      if (r.kind === 'COUPON') f.coupon += big(r.total);
      else f.promotion += big(r.total);
    }
    for (const r of rewards) {
      const f = at(r.demo, r.currency);
      f.points += big(r.points);
      f.credit += big(r.credit);
    }
    for (const r of paid) at(r.demo, r.currency).paid += big(r.total);
    for (const r of refunded) at(r.demo, r.currency).refunded += big(r.total);
    return out;
  }

  // ─── Funnel ───────────────────────────────────────────────────────────

  /**
   * Searches first seen in the window, with how far each got. One row per
   * combination of category, day and flags, with how many searches had it.
   */
  async funnelRows(w: Window): Promise<FunnelRow[]> {
    const rows = await this.prisma.$queryRaw<(Omit<FunnelRow, 'n'> & { n: number })[]>`
      WITH ids AS (
        SELECT DISTINCT search_id FROM search_events
         WHERE created_at >= ${w.start} AND created_at < ${w.end} AND search_id IS NOT NULL
      ), s AS (
        SELECT se.search_id, min(se.created_at) AS first_at, min(se.category::text) AS category,
               bool_or(se.outcome IN ('SUCCESS', 'PARTIAL')) AS results
          FROM search_events se JOIN ids USING (search_id)
         GROUP BY se.search_id
        HAVING min(se.created_at) >= ${w.start}
      ), f AS (
        SELECT s.category, to_char((s.first_at AT TIME ZONE ${this.timezone})::date, 'YYYY-MM-DD') AS day,
               s.results,
               coalesce(ev.viewed, false) AS viewed, coalesce(ev.selected, false) AS selected,
               coalesce(ev.initiated, false) AS initiated,
               coalesce(bk.real_booked, false) AS real_booked, coalesce(bk.demo_booked, false) AS demo_booked,
               coalesce(bk.real_paid, false) AS real_paid, coalesce(bk.demo_paid, false) AS demo_paid,
               coalesce(bk.supplier, false) AS supplier
          FROM s
          LEFT JOIN LATERAL (
            SELECT bool_or(e.type = 'offer.viewed') AS viewed,
                   bool_or(e.type = 'offer.selected') AS selected,
                   bool_or(e.type = 'booking.initiated') AS initiated
              FROM analytics_events e
             WHERE e.search_id = s.search_id
               AND e.type IN ('offer.viewed', 'offer.selected', 'booking.initiated')
          ) ev ON true
          LEFT JOIN LATERAL (
            SELECT bool_or(NOT b.is_demo) AS real_booked, bool_or(b.is_demo) AS demo_booked,
                   bool_or(NOT b.is_demo AND p.paid) AS real_paid,
                   bool_or(b.is_demo AND p.paid) AS demo_paid,
                   bool_or(r.confirmed_at IS NOT NULL) AS supplier
              FROM bookings b
              LEFT JOIN LATERAL (
                SELECT true AS paid FROM payments pm
                 WHERE pm.booking_id = b.id AND pm.status::text IN ('SUCCEEDED', 'REFUND_PENDING', 'REFUNDED')
                 LIMIT 1
              ) p ON true
              LEFT JOIN supplier_reservations r ON r.booking_id = b.id
             WHERE b.search_id = s.search_id
          ) bk ON true
      )
      SELECT category, day, results, viewed, selected, initiated, real_booked, demo_booked,
             real_paid, demo_paid, supplier, count(*)::int AS n
        FROM f GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11`;
    const failed = await this.prisma.$queryRaw<{ category: string; day: string; n: number }[]>`
      SELECT category::text AS category,
             to_char((created_at AT TIME ZONE ${this.timezone})::date, 'YYYY-MM-DD') AS day,
             count(*)::int AS n
        FROM search_events
       WHERE created_at >= ${w.start} AND created_at < ${w.end} AND search_id IS NULL
       GROUP BY 1, 2`;
    return [
      ...rows,
      ...failed.map((f) => ({
        category: f.category,
        day: f.day,
        results: false,
        viewed: false,
        selected: false,
        initiated: false,
        real_booked: false,
        demo_booked: false,
        real_paid: false,
        demo_paid: false,
        supplier: false,
        n: f.n,
      })),
    ];
  }

  async funnel(range: ResolvedRange): Promise<FunnelReport> {
    const cw = win(range.period);
    const pw = win(range.previous);
    const [rows, prevRows, eventsSince, searchesSince] = await Promise.all([
      this.funnelRows(cw),
      this.funnelRows(pw),
      this.eventsSince(),
      this.searchesSince(),
    ]);
    const stages = funnelStages(rows);
    const categories = [...new Set(rows.map((r) => r.category))].sort();
    const byCategory = categories.map((c) => ({
      category: SERVICE_TYPE[c as keyof typeof SERVICE_TYPE] as SearchServiceType,
      counts: funnelStages(rows.filter((r) => r.category === c)).map((s) => s.count),
    }));
    const daily = (rs: FunnelRow[], pick: (r: FunnelRow) => boolean) => {
      const m = new Map<string, number>();
      for (const r of rs) if (pick(r)) m.set(r.day, (m.get(r.day) ?? 0) + r.n);
      return [...m].map(([day, n]) => ({ day, n }));
    };
    const reached = (r: FunnelRow) => stageReached(r);
    const trend = this.trend(range, [
      {
        key: 'searches',
        label: 'Searches',
        cur: daily(rows, () => true),
        prev: daily(prevRows, () => true),
        since: searchesSince,
      },
      {
        key: 'with_results',
        label: 'With results',
        cur: daily(rows, (r) => reached(r) >= 1),
        prev: daily(prevRows, (r) => reached(r) >= 1),
        since: searchesSince,
      },
      {
        key: 'booked',
        label: 'Booking created',
        cur: daily(rows, (r) => r.real_booked || r.demo_booked),
        prev: daily(prevRows, (r) => r.real_booked || r.demo_booked),
        since: searchesSince,
      },
    ]);
    const eventsCoverage = this.coverage(eventsSince, range.period);
    const notes: AnalyticsNote[] = [
      {
        metric: 'How searches are followed',
        reason:
          'Each search started in the period is followed to its furthest stage, up to now. A later stage implies the earlier ones (a booking means an offer was viewed and chosen); "recorded at this stage" counts only what was recorded there directly.',
      },
      {
        metric: 'Payment and supplier stages',
        reason:
          'Measured against bookings created. Demo bookings are paid with simulated payments and never reach a supplier; real supplier bookings are paid to the supplier, not through Wayora.',
      },
    ];
    if (!eventsCoverage.complete) {
      notes.push({
        metric: 'Offer and booking-submission stages',
        reason: eventsSince
          ? `Recorded from ${this.when(eventsSince)}. Before that these stages are only implied by later ones, so they read low.`
          : 'Not recorded yet: these stages are only implied by later ones.',
      });
    }
    if (range.period.partial) {
      notes.push({
        metric: 'Recent searches',
        reason: 'Searches from the last few days can still turn into bookings.',
      });
    }
    return {
      ...this.meta(range),
      coverage: {
        searches: this.coverage(searchesSince, range.period),
        events: eventsCoverage,
      },
      stages,
      byCategory,
      trend,
      notes,
    };
  }

  // ─── Search and discovery ─────────────────────────────────────────────

  async search(range: ResolvedRange): Promise<SearchReport> {
    const cw = win(range.period);
    const pw = win(range.previous);
    const [
      byCategory,
      answered,
      answeredPrev,
      funnelRows,
      routes,
      months,
      filters,
      sorts,
      views,
      eventsSince,
      searchesSince,
      days,
      daysPrev,
      emptyDays,
      emptyDaysPrev,
    ] = await Promise.all([
      this.prisma.$queryRaw<
        { category: string; searches: number; requests: number; empty: number; failed: number }[]
      >`
        SELECT category::text AS category,
               (count(DISTINCT search_id) + count(*) FILTER (WHERE search_id IS NULL))::int AS searches,
               count(*)::int AS requests,
               count(*) FILTER (WHERE outcome = 'EMPTY')::int AS empty,
               count(*) FILTER (WHERE outcome = 'FAILED')::int AS failed
          FROM search_events WHERE created_at >= ${cw.start} AND created_at < ${cw.end}
         GROUP BY 1 ORDER BY 1`,
      this.answered(cw),
      this.answered(pw),
      this.funnelRows(cw),
      this.prisma.$queryRaw<
        { category: string; origin: string | null; destination: string; n: number }[]
      >`
        SELECT category::text AS category, origin_place AS origin, destination_place AS destination,
               count(DISTINCT coalesce(search_id, id))::int AS n
          FROM search_events
         WHERE created_at >= ${cw.start} AND created_at < ${cw.end} AND destination_place IS NOT NULL
         GROUP BY 1, 2, 3
        HAVING count(DISTINCT coalesce(search_id, id)) >= ${MIN_GROUP_SIZE}
         ORDER BY n DESC, 1, 2, 3 LIMIT 20`,
      this.prisma.$queryRaw<{ month: string; n: number }[]>`
        SELECT to_char(travel_month, 'YYYY-MM') AS month, count(DISTINCT coalesce(search_id, id))::int AS n
          FROM search_events
         WHERE created_at >= ${cw.start} AND created_at < ${cw.end} AND travel_month IS NOT NULL
         GROUP BY 1 HAVING count(DISTINCT coalesce(search_id, id)) >= ${MIN_GROUP_SIZE}
         ORDER BY 1 LIMIT 24`,
      this.prisma.$queryRaw<{ filter: string; n: number }[]>`
        SELECT f AS filter, count(*)::int AS n
          FROM search_events, unnest(filter_keys) AS f
         WHERE created_at >= ${cw.start} AND created_at < ${cw.end}
         GROUP BY 1 ORDER BY n DESC, 1 LIMIT 30`,
      this.prisma.$queryRaw<{ sort: string; n: number }[]>`
        SELECT sort, count(*)::int AS n FROM search_events
         WHERE created_at >= ${cw.start} AND created_at < ${cw.end} AND sort IS NOT NULL
         GROUP BY 1 ORDER BY n DESC, 1 LIMIT 30`,
      // Daily totals are kept per UTC day (Phase 29).
      this.prisma.$queryRaw<{ key: string; n: number }[]>`
        SELECT key, sum(count)::int AS n FROM content_daily_counts
         WHERE event = 'destination_view' AND day >= ${range.period.from}::date AND day <= ${range.period.to}::date
         GROUP BY 1 ORDER BY n DESC, 1 LIMIT 10`,
      this.eventsSince(),
      this.searchesSince(),
      this.searchesPerDay(cw),
      this.searchesPerDay(pw),
      this.perDay('search_events', 'created_at', `outcome = 'EMPTY'`, cw),
      this.perDay('search_events', 'created_at', `outcome = 'EMPTY'`, pw),
    ]);

    let withResults = 0;
    let viewed = 0;
    let wentFurther = 0;
    for (const r of funnelRows) {
      const stage = stageReached(r);
      if (stage < 1) continue;
      withResults += r.n;
      if (stage >= 2) viewed += r.n;
      if (stage >= 2 || r.real_booked || r.demo_booked) wentFurther += r.n;
    }
    const name = (id: string | null) => (id ? (findPlace(id)?.name ?? id) : null);
    const notes: AnalyticsNote[] = [
      {
        metric: 'Privacy',
        reason: `Searches are counted without who searched: no account, IP, exact dates or travellers. Routes and travel months appear only when searched at least ${MIN_GROUP_SIZE} times; filters and sorts are field names, never values.`,
      },
      {
        metric: 'Destination page views',
        reason:
          'Daily totals by UTC day (Phase 29), so they can differ slightly at the period’s edges.',
      },
    ];
    const detailsCoverage = this.coverage(eventsSince, range.period);
    if (!detailsCoverage.complete) {
      notes.push({
        metric: 'Routes, travel months, filters and sorts',
        reason: eventsSince
          ? `Recorded from ${this.when(eventsSince)}; earlier searches have none of these details.`
          : 'Not recorded yet.',
      });
    }
    return {
      ...this.meta(range),
      coverage: {
        searches: this.coverage(searchesSince, range.period),
        details: detailsCoverage,
        offers: detailsCoverage,
      },
      byCategory: byCategory.map((r) => ({
        category: SERVICE_TYPE[r.category as keyof typeof SERVICE_TYPE],
        searches: r.searches,
        requests: r.requests,
        noResults: r.empty,
        failed: r.failed,
      })),
      noResultsRate: rate(
        answered.empty,
        answered.total,
        ratio(answeredPrev.empty, answeredPrev.total),
      ),
      searchToOffer: rate(viewed, withResults),
      abandonment: rate(withResults - wentFurther, withResults),
      minimumCount: MIN_GROUP_SIZE,
      routes: routes.map((r) => ({
        category: SERVICE_TYPE[r.category as keyof typeof SERVICE_TYPE],
        origin: r.origin,
        originName: name(r.origin),
        destination: r.destination,
        destinationName: name(r.destination) ?? r.destination,
        searches: r.n,
      })),
      travelMonths: months.map((m) => ({ month: m.month, searches: m.n })),
      filters: filters.map((f) => ({ filter: f.filter, requests: f.n })),
      sorts: sorts.map((s) => ({ sort: s.sort, requests: s.n })),
      destinationViews: views.map((v) => ({
        slug: v.key,
        name: catalogDestination(v.key)?.name ?? v.key,
        views: v.n,
      })),
      trend: this.trend(range, [
        { key: 'searches', label: 'Searches', cur: days, prev: daysPrev, since: searchesSince },
        {
          key: 'no_results',
          label: 'Requests with no results',
          cur: emptyDays,
          prev: emptyDaysPrev,
          since: searchesSince,
        },
      ]),
      notes,
    };
  }

  private async answered(w: Window) {
    const [row] = await this.prisma.$queryRaw<{ total: number; empty: number }[]>`
      SELECT count(*) FILTER (WHERE outcome <> 'FAILED')::int AS total,
             count(*) FILTER (WHERE outcome = 'EMPTY')::int AS empty
        FROM search_events WHERE created_at >= ${w.start} AND created_at < ${w.end}`;
    return row ?? { total: 0, empty: 0 };
  }

  // ─── Customers ────────────────────────────────────────────────────────

  async customers(range: ResolvedRange): Promise<CustomersReport> {
    const cw = win(range.period);
    const pw = win(range.previous);
    const { cur: curBuckets, prev: prevBuckets } = this.buckets(range);
    const [
      eventsSince,
      regCur,
      regPrev,
      activeCur,
      activePrev,
      returningCur,
      returningPrev,
      bookersCur,
      bookersPrev,
      retained,
      tiers,
      rewards,
      regDays,
      regDaysPrev,
      activeDays,
      activeDaysPrev,
    ] = await Promise.all([
      this.eventsSince(),
      this.count('users', 'created_at', `role = 'USER'`, cw),
      this.count('users', 'created_at', `role = 'USER'`, pw),
      this.activeUsers(cw),
      this.activeUsers(pw),
      this.returning(cw),
      this.returning(pw),
      this.bookers(cw),
      this.bookers(pw),
      this.prisma.$queryRaw<{ base: number; kept: number }[]>`
        WITH before AS (
          SELECT DISTINCT user_id FROM analytics_events
           WHERE type = ANY(${ACTIVE_TYPES}) AND occurred_at >= ${pw.start} AND occurred_at < ${pw.end}
             AND user_id IS NOT NULL
        )
        SELECT count(*)::int AS base,
               count(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM analytics_events e
                  WHERE e.user_id = before.user_id AND e.type = ANY(${ACTIVE_TYPES})
                    AND e.occurred_at >= ${cw.start} AND e.occurred_at < ${cw.end}))::int AS kept
          FROM before`,
      this.prisma.$queryRaw<{ demo: boolean; tier: string; n: number }[]>`
        SELECT la.mode = 'DEMO' AS demo, la.tier, count(*)::int AS n
          FROM loyalty_accounts la JOIN users u ON u.id = la.user_id AND u.role = 'USER'
         GROUP BY 1, 2 ORDER BY 1, 2`,
      this.prisma.$queryRaw<{ demo: boolean; earners: number; redeemers: number }[]>`
        SELECT rt.mode = 'DEMO' AS demo,
               count(DISTINCT rt.user_id) FILTER (WHERE rt.type = 'POINTS_EARNED')::int AS earners,
               count(DISTINCT rt.user_id) FILTER (WHERE rt.type IN ('POINTS_REDEEMED', 'CREDIT_REDEEMED'))::int AS redeemers
          FROM reward_transactions rt
         WHERE rt.created_at >= ${cw.start} AND rt.created_at < ${cw.end}
         GROUP BY 1`,
      this.perDay('users', 'created_at', `role = 'USER'`, cw),
      this.perDay('users', 'created_at', `role = 'USER'`, pw),
      this.activePerBucket(cw, curBuckets),
      this.activePerBucket(pw, prevBuckets),
    ]);
    const accounts = await this.prisma.$queryRaw<{ demo: boolean; n: number }[]>`
      SELECT la.mode = 'DEMO' AS demo, count(*)::int AS n
        FROM loyalty_accounts la JOIN users u ON u.id = la.user_id AND u.role = 'USER' GROUP BY 1`;
    const activeCoverage = this.coverage(eventsSince, range.period);
    const prevCovered = this.coverage(eventsSince, range.previous).complete;
    const r = retained[0] ?? { base: 0, kept: 0 };
    const notes: AnalyticsNote[] = [
      {
        metric: 'Who counts',
        reason:
          'Customer accounts only (staff excluded). Active: signed in, registered, or used Wayora while signed in on a day (automatic background requests don’t count).',
      },
      {
        metric: 'Customer lifetime value',
        reason: 'Not calculated: there isn’t enough real booking history to estimate it honestly.',
      },
      {
        metric: 'Loyalty tiers',
        reason: 'Current tiers (now), not as they were during the period.',
      },
    ];
    if (!activeCoverage.complete) {
      notes.push({
        metric: 'Active, returning and retention',
        reason: eventsSince
          ? `Activity is recorded from ${this.when(eventsSince)}; periods before that are not covered.`
          : 'Activity tracking has not started yet.',
      });
    }
    return {
      ...this.meta(range),
      activeCoverage,
      registrations: { value: regCur, previous: regPrev },
      active: { value: activeCur, previous: prevCovered ? activePrev : null },
      returning: { value: returningCur, previous: prevCovered ? returningPrev : null },
      booking: MODES.map((mode) => {
        const c = bookersCur.get(mode)!;
        const p = bookersPrev.get(mode)!;
        return {
          mode,
          customers: { value: c.customers, previous: p.customers },
          repeat: rate(c.repeat, c.customers, ratio(p.repeat, p.customers)),
          frequency: c.customers > 0 ? c.bookings / c.customers : null,
        };
      }),
      retention: prevCovered ? rate(r.kept, r.base) : null,
      tiers: tiers.map((t) => ({ mode: modeOf(t.demo), tier: t.tier, accounts: t.n })),
      rewards: MODES.map((mode) => {
        const row = rewards.find((x) => modeOf(x.demo) === mode);
        return {
          mode,
          earners: row?.earners ?? 0,
          redeemers: row?.redeemers ?? 0,
          accounts: accounts.find((a) => modeOf(a.demo) === mode)?.n ?? 0,
        };
      }),
      trend: this.trend(range, [
        {
          key: 'registrations',
          label: 'New customers',
          cur: regDays,
          prev: regDaysPrev,
          since: new Date(0),
        },
        {
          key: 'active',
          label: 'Active customers',
          cur: activeDays,
          prev: activeDaysPrev,
          since: eventsSince,
        },
      ]),
      notes,
    };
  }

  private async returning(w: Window): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(DISTINCT e.user_id)::int AS n
        FROM analytics_events e JOIN users u ON u.id = e.user_id
       WHERE e.type = ANY(${ACTIVE_TYPES}) AND e.occurred_at >= ${w.start} AND e.occurred_at < ${w.end}
         AND u.created_at < ${w.start} AND u.role = 'USER'`;
    return row?.n ?? 0;
  }

  /** Customers with confirmed bookings in the window, by mode, with repeat counts. */
  private async bookers(w: Window) {
    const rows = await this.prisma.$queryRaw<
      { demo: boolean; customers: number; bookings: number; repeat: number }[]
    >`
      WITH b AS (
        SELECT bk.user_id, bk.is_demo, count(*)::int AS n
          FROM bookings bk JOIN users u ON u.id = bk.user_id AND u.role = 'USER'
         WHERE bk.confirmed_at >= ${w.start} AND bk.confirmed_at < ${w.end}
         GROUP BY 1, 2
      )
      SELECT b.is_demo AS demo, count(*)::int AS customers, sum(b.n)::int AS bookings,
             count(*) FILTER (WHERE (
               SELECT count(*) FROM bookings x
                WHERE x.user_id = b.user_id AND x.is_demo = b.is_demo
                  AND x.confirmed_at IS NOT NULL AND x.confirmed_at < ${w.end}
             ) >= 2)::int AS repeat
        FROM b GROUP BY 1`;
    return new Map(
      MODES.map((mode) => {
        const r = rows.find((x) => modeOf(x.demo) === mode);
        return [
          mode,
          { customers: r?.customers ?? 0, bookings: r?.bookings ?? 0, repeat: r?.repeat ?? 0 },
        ];
      }),
    );
  }

  // ─── Providers ────────────────────────────────────────────────────────

  async providers(range: ResolvedRange): Promise<ProvidersReport> {
    const cw = win(range.period);
    const pw = win(range.previous);
    const [calls, callsPrev, times, reservations, errors, searchesSince] = await Promise.all([
      this.prisma.$queryRaw<{ id: string; status: string; n: number }[]>`
        SELECT p->>'id' AS id, p->>'status' AS status, count(*)::int AS n
          FROM search_events se, jsonb_array_elements(se.providers) p
         WHERE se.created_at >= ${cw.start} AND se.created_at < ${cw.end}
         GROUP BY 1, 2`,
      this.prisma.$queryRaw<{ id: string; n: number }[]>`
        SELECT p->>'id' AS id, count(*)::int AS n
          FROM search_events se, jsonb_array_elements(se.providers) p
         WHERE se.created_at >= ${pw.start} AND se.created_at < ${pw.end}
         GROUP BY 1`,
      this.prisma.$queryRaw<{ id: string; avg: number | null; p95: number | null }[]>`
        SELECT p->>'id' AS id, avg((p->>'durationMs')::int)::float8 AS avg,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY (p->>'durationMs')::int)::float8 AS p95
          FROM search_events se, jsonb_array_elements(se.providers) p
         WHERE se.created_at >= ${cw.start} AND se.created_at < ${cw.end}
         GROUP BY 1`,
      this.prisma.$queryRaw<{ provider: string; status: string; confirmed: boolean; n: number }[]>`
        SELECT provider, status::text AS status, confirmed_at IS NOT NULL AS confirmed, count(*)::int AS n
          FROM supplier_reservations
         WHERE created_at >= ${cw.start} AND created_at < ${cw.end}
         GROUP BY 1, 2, 3`,
      this.prisma.$queryRaw<{ provider: string; category: string; n: number }[]>`
        SELECT provider, error_category::text AS category, count(*)::int AS n
          FROM supplier_reservations
         WHERE created_at >= ${cw.start} AND created_at < ${cw.end} AND error_category IS NOT NULL
         GROUP BY 1, 2`,
      this.searchesSince(),
    ]);
    const registered = new Map((this.options.providers?.() ?? []).map((p) => [p.id, p]));
    const info = (id: string) => {
      const p = registered.get(id);
      return { name: p?.name ?? id, kind: p?.kind ?? ('unknown' as const) };
    };
    const ids = [...new Set(calls.map((c) => c.id))].sort();
    const search = ids.map((id) => {
      const byOutcome: Record<string, number> = {};
      for (const c of calls.filter((x) => x.id === id)) byOutcome[c.status] = c.n;
      const total = Object.values(byOutcome).reduce((a, b) => a + b, 0);
      const answeredN = (byOutcome.success ?? 0) + (byOutcome.empty ?? 0);
      const t = times.find((x) => x.id === id);
      const prevCalls = callsPrev.find((x) => x.id === id)?.n ?? 0;
      return {
        id,
        ...info(id),
        calls: { value: total, previous: prevCalls },
        byOutcome,
        answerRate: rate(answeredN, total),
        timeoutRate: rate(byOutcome.timeout ?? 0, total),
        averageMs: t?.avg === null || t?.avg === undefined ? null : Math.round(t.avg),
        p95Ms: t?.p95 === null || t?.p95 === undefined ? null : Math.round(t.p95),
      };
    });
    const providers = [...new Set(reservations.map((r) => r.provider))].sort();
    const reservationRows = providers.map((provider) => {
      const rs = reservations.filter((r) => r.provider === provider);
      const byStatus: Record<string, number> = {};
      for (const r of rs)
        byStatus[r.status.toLowerCase()] = (byStatus[r.status.toLowerCase()] ?? 0) + r.n;
      const confirmed = rs.filter((r) => r.confirmed).reduce((a, r) => a + r.n, 0);
      const failedN = byStatus.failed ?? 0;
      const errorCategories: Record<string, number> = {};
      for (const e of errors.filter((x) => x.provider === provider))
        errorCategories[e.category.toLowerCase()] = e.n;
      return {
        provider,
        kind: info(provider).kind,
        started: rs.reduce((a, r) => a + r.n, 0),
        byStatus,
        successRate: rate(confirmed, confirmed + failedN),
        errorCategories,
      };
    });
    const notes: AnalyticsNote[] = [
      {
        metric: 'Demo and live providers',
        reason:
          'Demo providers return generated sample results; their speed and answer rate say nothing about a real supplier. Compare live providers with live providers only.',
      },
      {
        metric: 'Answer rate',
        reason:
          'The share of calls that answered (with or without results). It is not uptime: a provider that wasn’t called has no figure.',
      },
      {
        metric: 'Reservations',
        reason:
          'Supplier reservations started in the period, by their state now. Demo bookings reserve nothing. Request ids in the booking’s reservation history correlate each attempt with the logs.',
      },
    ];
    if (search.length === 0)
      notes.push({ metric: 'Search providers', reason: 'No provider calls in this period.' });
    return {
      ...this.meta(range),
      coverage: this.coverage(searchesSince, range.period),
      search,
      reservations: reservationRows,
      notes,
    };
  }

  // ─── Marketing ────────────────────────────────────────────────────────

  async marketing(range: ResolvedRange): Promise<MarketingReport> {
    const cw = win(range.period);
    const pw = win(range.previous);
    const now = this.now();
    const [activity, discounts, promoted, promotedPrev, coupons, loyalty, live] = await Promise.all(
      [
        this.prisma.$queryRaw<{ id: string; status: string; demo: boolean; n: number }[]>`
        SELECT pr.promotion_id::text AS id, pr.status::text AS status, b.is_demo AS demo, count(*)::int AS n
          FROM promotion_redemptions pr JOIN bookings b ON b.id = pr.booking_id
         WHERE pr.created_at >= ${cw.start} AND pr.created_at < ${cw.end}
         GROUP BY 1, 2, 3`,
        this.prisma.$queryRaw<{ id: string; demo: boolean; currency: string; total: string }[]>`
        SELECT pr.promotion_id::text AS id, b.is_demo AS demo, pr.currency, sum(pr.discount_minor)::text AS total
          FROM promotion_redemptions pr JOIN bookings b ON b.id = pr.booking_id
         WHERE pr.status = 'REDEEMED' AND pr.redeemed_at >= ${cw.start} AND pr.redeemed_at < ${cw.end}
         GROUP BY 1, 2, 3`,
        this.promotedBookings(cw),
        this.promotedBookings(pw),
        this.prisma.$queryRaw<{ applied: number; redeemed: number }[]>`
        SELECT count(*)::int AS applied, count(*) FILTER (WHERE status = 'REDEEMED')::int AS redeemed
          FROM promotion_redemptions
         WHERE kind = 'COUPON' AND created_at >= ${cw.start} AND created_at < ${cw.end}`,
        this.prisma.$queryRaw<
          { demo: boolean; type: string; currency: string | null; points: string; amount: string }[]
        >`
        SELECT mode = 'DEMO' AS demo, type::text AS type, currency,
               sum(abs(points))::text AS points, sum(abs(amount_minor))::text AS amount
          FROM reward_transactions
         WHERE created_at >= ${cw.start} AND created_at < ${cw.end}
           AND type IN ('POINTS_EARNED', 'POINTS_REDEEMED', 'POINTS_RESTORED', 'POINTS_EXPIRED',
                        'CREDIT_ISSUED', 'CREDIT_REDEEMED', 'CREDIT_RESTORED', 'CREDIT_EXPIRED')
         GROUP BY 1, 2, 3`,
        this.prisma.promotion.findMany({
          where: { active: true, startsAt: { lte: now }, endsAt: { gt: now } },
          select: { id: true },
        }),
      ],
    );
    const liveIds = new Set(live.map((p) => p.id));
    const ids = [
      ...new Set([...activity.map((a) => a.id), ...discounts.map((d) => d.id), ...liveIds]),
    ];
    const promos = await this.prisma.promotion.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, kind: true, code: true },
      orderBy: { createdAt: 'asc' },
    });
    const sumOf = (rows: typeof activity, f: (r: (typeof activity)[number]) => boolean) =>
      rows.filter(f).reduce((a, r) => a + r.n, 0);
    const amounts = (id: string, demo: boolean) =>
      discounts
        .filter((d) => d.id === id && d.demo === demo)
        .map((d) => ({ currency: d.currency, amountMinor: big(d.total).toString() }))
        .sort((a, b) => a.currency.localeCompare(b.currency));
    const promotions = promos
      .map((p) => {
        const mine = activity.filter((a) => a.id === p.id);
        return {
          id: p.id,
          name: p.name,
          kind: p.kind === 'COUPON' ? ('coupon' as const) : ('automatic' as const),
          code: p.code,
          live: liveIds.has(p.id),
          applied: sumOf(mine, () => true),
          redeemed: {
            real: sumOf(mine, (a) => a.status === 'REDEEMED' && !a.demo),
            demo: sumOf(mine, (a) => a.status === 'REDEEMED' && a.demo),
          },
          released: sumOf(mine, (a) => a.status === 'RELEASED' || a.status === 'REVERSED'),
          discount: { real: amounts(p.id, false), demo: amounts(p.id, true) },
        };
      })
      .sort((a, b) => b.applied - a.applied || a.name.localeCompare(b.name));

    const loyaltyRows = MODES.map((mode) => {
      const rows = loyalty.filter((l) => modeOf(l.demo) === mode);
      const pts = (type: string) =>
        rows.filter((r) => r.type === type).reduce((a, r) => a + big(r.points), 0n);
      const money = (type: string, minus?: string) => {
        const m = new Map<string, bigint>();
        for (const r of rows.filter((x) => x.currency && (x.type === type || x.type === minus))) {
          const sign = r.type === type ? 1n : -1n;
          m.set(r.currency!, (m.get(r.currency!) ?? 0n) + sign * big(r.amount));
        }
        return [...m]
          .filter(([, v]) => v !== 0n)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([currency, v]) => ({ currency, amountMinor: v.toString() }));
      };
      return {
        mode,
        pointsEarned: pts('POINTS_EARNED').toString(),
        // Net of points given back when a booking that used them was released.
        pointsRedeemed: (pts('POINTS_REDEEMED') - pts('POINTS_RESTORED')).toString(),
        pointsExpired: pts('POINTS_EXPIRED').toString(),
        creditIssued: money('CREDIT_ISSUED'),
        creditUsed: money('CREDIT_REDEEMED', 'CREDIT_RESTORED'),
        creditExpired: money('CREDIT_EXPIRED'),
      };
    });
    const c = coupons[0] ?? { applied: 0, redeemed: 0 };
    const notes: AnalyticsNote[] = [
      {
        metric: 'Attribution',
        reason:
          'A booking with several promotions counts once in promoted bookings; each promotion’s own row counts its own uses, so rows can add up to more.',
      },
      {
        metric: 'Applied, redeemed, released',
        reason:
          'Applied: attached to a booking in the period. Redeemed: the booking was paid with it. Released: given back (booking expired or cancelled before payment). Only redeemed discounts are counted.',
      },
      {
        metric: 'Incremental revenue',
        reason:
          'Not claimed: these figures show use of promotions, not whether the bookings would have happened anyway.',
      },
      {
        metric: 'Issued is not used',
        reason:
          'Travel credit issued is a promise, not money spent; points earned are not points redeemed. Neither is counted as an expense.',
      },
      {
        metric: 'Promotions listed',
        reason:
          'Promotions live now, plus any other promotion used in the period (marked “not live”). Expired and inactive promotions without use in the period are left out.',
      },
    ];
    return {
      ...this.meta(range),
      promotedBookings: {
        real: { value: promoted.real, previous: promotedPrev.real },
        demo: { value: promoted.demo, previous: promotedPrev.demo },
      },
      promotions,
      couponConversion: rate(c.redeemed, c.applied),
      loyalty: loyaltyRows,
      notes,
    };
  }

  private async promotedBookings(w: Window) {
    const rows = await this.prisma.$queryRaw<{ demo: boolean; n: number }[]>`
      SELECT b.is_demo AS demo, count(DISTINCT b.id)::int AS n
        FROM promotion_redemptions pr JOIN bookings b ON b.id = pr.booking_id
       WHERE pr.status = 'REDEEMED' AND pr.redeemed_at >= ${w.start} AND pr.redeemed_at < ${w.end}
       GROUP BY 1`;
    return {
      real: rows.find((r) => !r.demo)?.n ?? 0,
      demo: rows.find((r) => r.demo)?.n ?? 0,
    };
  }

  // ─── Support and reviews ──────────────────────────────────────────────

  async support(range: ResolvedRange, scope: AnalyticsScope): Promise<SupportReport> {
    const cw = win(range.period);
    const pw = win(range.previous);
    const tickets = scope.support ? await this.tickets(cw, pw) : null;
    const reviews = scope.reviews ? await this.reviewFigures(cw, pw) : null;
    const [ticketDays, ticketDaysPrev, reviewDays, reviewDaysPrev] = await Promise.all([
      scope.support ? this.perDay('support_tickets', 'created_at', '', cw) : [],
      scope.support ? this.perDay('support_tickets', 'created_at', '', pw) : [],
      scope.reviews ? this.perDay('reviews', 'created_at', '', cw) : [],
      scope.reviews ? this.perDay('reviews', 'created_at', '', pw) : [],
    ]);
    const defs = [];
    if (scope.support)
      defs.push({
        key: 'tickets',
        label: 'Tickets opened',
        cur: ticketDays,
        prev: ticketDaysPrev,
        since: new Date(0),
      });
    if (scope.reviews)
      defs.push({
        key: 'reviews',
        label: 'Reviews submitted',
        cur: reviewDays,
        prev: reviewDaysPrev,
        since: new Date(0),
      });
    const notes: AnalyticsNote[] = [
      {
        metric: 'Response times',
        reason:
          'First response is the first public reply by staff; automatic confirmations and internal notes don’t count. Times are calendar time, not business hours.',
      },
      {
        metric: 'Ratings',
        reason:
          'Average of reviews published in the period that are still published. Pending, rejected, flagged and removed reviews are never included.',
      },
    ];
    return { ...this.meta(range), tickets, reviews, trend: this.trend(range, defs), notes };
  }

  private async tickets(cw: Window, pw: Window): Promise<NonNullable<SupportReport['tickets']>> {
    const [
      created,
      createdPrev,
      resolved,
      resolvedPrev,
      escalated,
      openNow,
      first,
      resolution,
      cats,
      load,
    ] = await Promise.all([
      this.count('support_tickets', 'created_at', '', cw),
      this.count('support_tickets', 'created_at', '', pw),
      this.count('support_tickets', 'resolved_at', '', cw),
      this.count('support_tickets', 'resolved_at', '', pw),
      this.count('support_tickets', 'escalated_at', '', cw),
      this.prisma.supportTicket.count({ where: { status: { notIn: ['RESOLVED', 'CLOSED'] } } }),
      this.prisma.$queryRaw<{ minutes: number }[]>`
          SELECT extract(epoch FROM (first_response_at - created_at)) / 60 AS minutes
            FROM support_tickets
           WHERE created_at >= ${cw.start} AND created_at < ${cw.end} AND first_response_at IS NOT NULL
           ORDER BY 1`,
      this.prisma.$queryRaw<{ minutes: number }[]>`
          SELECT extract(epoch FROM (resolved_at - created_at)) / 60 AS minutes
            FROM support_tickets
           WHERE resolved_at >= ${cw.start} AND resolved_at < ${cw.end}
           ORDER BY 1`,
      this.prisma.$queryRaw<{ category: string; n: number }[]>`
          SELECT category::text AS category, count(*)::int AS n FROM support_tickets
           WHERE created_at >= ${cw.start} AND created_at < ${cw.end}
           GROUP BY 1 ORDER BY n DESC, 1`,
      this.prisma.$queryRaw<{ name: string | null; n: number }[]>`
          SELECT u.display_name AS name, count(*)::int AS n
            FROM support_tickets t JOIN users u ON u.id = t.assignee_id
           WHERE t.status NOT IN ('RESOLVED', 'CLOSED')
           GROUP BY u.id, u.display_name ORDER BY n DESC, 1 LIMIT 20`,
    ]);
    const minutes = (rows: { minutes: number }[]) => rows.map((r) => Number(r.minutes));
    const summary = (xs: number[]) => ({
      count: xs.length,
      averageMinutes: xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null,
      medianMinutes: (() => {
        const m = median(xs);
        return m === null ? null : Math.round(m);
      })(),
    });
    return {
      created: { value: created, previous: createdPrev },
      resolved: { value: resolved, previous: resolvedPrev },
      escalated,
      openNow,
      firstResponse: summary(minutes(first)),
      resolution: summary(minutes(resolution)),
      byCategory: cats.map((c) => ({ category: c.category.toLowerCase(), created: c.n })),
      workload: load.map((l) => ({ name: l.name ?? 'Staff member', active: l.n })),
    };
  }

  private async reviewFigures(
    cw: Window,
    pw: Window,
  ): Promise<NonNullable<SupportReport['reviews']>> {
    const [submitted, submittedPrev, rating, ratingPrev, verification, pending, flagged, reports] =
      await Promise.all([
        this.count('reviews', 'created_at', '', cw),
        this.count('reviews', 'created_at', '', pw),
        this.publishedRating(cw),
        this.publishedRating(pw),
        this.prisma.$queryRaw<{ v: string; n: number }[]>`
          SELECT verification::text AS v, count(*)::int AS n FROM reviews
           WHERE created_at >= ${cw.start} AND created_at < ${cw.end} GROUP BY 1`,
        this.prisma.review.count({ where: { status: 'PENDING' } }),
        this.prisma.review.count({ where: { status: 'FLAGGED' } }),
        this.prisma.reviewReport.count({ where: { status: 'OPEN' } }),
      ]);
    const byVerification: Record<string, number> = {};
    for (const v of verification) byVerification[v.v.toLowerCase()] = v.n;
    return {
      submitted: { value: submitted, previous: submittedPrev },
      averagePublishedRating: { value: rating.avg, previous: ratingPrev.avg },
      publishedInPeriod: rating.n,
      byVerification,
      pendingNow: pending,
      flaggedNow: flagged,
      openReportsNow: reports,
    };
  }

  private async publishedRating(w: Window) {
    const [row] = await this.prisma.$queryRaw<{ avg: number | null; n: number }[]>`
      SELECT round(avg(rating)::numeric, 2)::float8 AS avg, count(*)::int AS n FROM reviews
       WHERE status = 'PUBLISHED' AND published_at >= ${w.start} AND published_at < ${w.end}`;
    return { avg: row?.avg ?? null, n: row?.n ?? 0 };
  }
}

// ─── Types and pure helpers ─────────────────────────────────────────────

interface MoneyTotals {
  gbv: Map<string, bigint>;
  priced: Map<string, number>;
  collected: Map<string, bigint>;
  refunded: Map<string, bigint>;
}

interface RevenueFigures {
  gbv: bigint;
  confirmed: number;
  unpriced: number;
  promotion: bigint;
  coupon: bigint;
  points: bigint;
  credit: bigint;
  paid: bigint;
  refunded: bigint;
}
const emptyFigures = (): RevenueFigures => ({
  gbv: 0n,
  confirmed: 0,
  unpriced: 0,
  promotion: 0n,
  coupon: 0n,
  points: 0n,
  credit: 0n,
  paid: 0n,
  refunded: 0n,
});

interface MoneyDay {
  day: string;
  demo: boolean;
  currency: string;
  total: string;
}

export interface FunnelRow {
  category: string;
  day: string;
  results: boolean;
  viewed: boolean;
  selected: boolean;
  initiated: boolean;
  real_booked: boolean;
  demo_booked: boolean;
  real_paid: boolean;
  demo_paid: boolean;
  supplier: boolean;
  n: number;
}

/**
 * The furthest of the first six stages a search reached (0 = initiated …
 * 5 = booking created). A later stage implies the earlier ones.
 */
export function stageReached(r: FunnelRow): number {
  if (r.real_booked || r.demo_booked) return 5;
  if (r.initiated) return 4;
  if (r.selected) return 3;
  if (r.viewed) return 2;
  if (r.results) return 1;
  return 0;
}

const STAGE_LABELS: Record<(typeof FUNNEL_STAGES)[number], string> = {
  search_initiated: 'Search started',
  results_returned: 'Results returned',
  offer_viewed: 'Offer viewed',
  offer_selected: 'Offer chosen',
  booking_initiated: 'Booking submitted',
  booking_created: 'Booking created',
  payment_completed: 'Payment completed',
  supplier_confirmed: 'Supplier confirmed',
};

/** Funnel stages from per-search rows (docs/analytics.md#funnel). */
export function funnelStages(rows: readonly FunnelRow[]): FunnelStage[] {
  const reached = [0, 0, 0, 0, 0, 0];
  const observed = [0, 0, 0, 0, 0, 0];
  const booked = { real: 0, demo: 0 };
  const paid = { real: 0, demo: 0 };
  let supplier = 0;
  for (const r of rows) {
    const s = stageReached(r);
    for (let i = 0; i <= s; i++) reached[i]! += r.n;
    const seen = [
      true,
      r.results,
      r.viewed,
      r.selected,
      r.initiated,
      r.real_booked || r.demo_booked,
    ];
    seen.forEach((v, i) => {
      if (v) observed[i]! += r.n;
    });
    if (r.real_booked) booked.real += r.n;
    else if (r.demo_booked) booked.demo += r.n;
    if (r.real_paid) paid.real += r.n;
    else if (r.demo_paid) paid.demo += r.n;
    if (r.supplier) supplier += r.n;
  }
  const stages: FunnelStage[] = FUNNEL_STAGES.slice(0, 6).map((key, i) => ({
    key,
    label: STAGE_LABELS[key],
    count: reached[i]!,
    observed: observed[i]!,
    conversion: i === 0 ? null : ratio(reached[i]!, reached[i - 1]!),
    dropOff: i === 0 ? null : reached[i - 1]! - reached[i]!,
    split: key === 'booking_created' ? booked : null,
  }));
  const created = reached[5]!;
  const paidTotal = paid.real + paid.demo;
  stages.push({
    key: 'payment_completed',
    label: STAGE_LABELS.payment_completed,
    count: paidTotal,
    observed: paidTotal,
    conversion: ratio(paidTotal, created),
    dropOff: created - paidTotal,
    split: paid,
  });
  stages.push({
    key: 'supplier_confirmed',
    label: STAGE_LABELS.supplier_confirmed,
    count: supplier,
    observed: supplier,
    // Real bookings only: demo bookings never reach a supplier.
    conversion: ratio(supplier, booked.real),
    dropOff: booked.real - supplier,
    split: { real: supplier, demo: 0 },
  });
  return stages;
}
