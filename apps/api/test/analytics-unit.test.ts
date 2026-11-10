import { describe, expect, it, vi } from 'vitest';
import {
  ANALYTICS_EVENT_DEFINITIONS,
  ANALYTICS_EVENT_TYPES,
  STORED_EVENT_TYPES,
  analyticsInteractionsSchema,
  analyticsQuerySchema,
  hasPermission,
} from '@wayora/contracts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  averageMinor,
  funnelStages,
  rate,
  stageReached,
  type FunnelRow,
} from '../src/modules/analytics/analytics.service.js';
import { scopeFor } from '../src/modules/analytics/analytics.routes.js';
import { MemoryAnalyticsCache, redisAnalyticsCache } from '../src/modules/analytics/cache.js';
import { CSV_COLUMNS, csvCell, reportRows, toCsv } from '../src/modules/analytics/csv.js';
import {
  activityTracker,
  declinedTracking,
  isAutomatic,
  keyPart,
  offerSelected,
  offerViewed,
  type AnalyticsRecorder,
  type ApiEvent,
} from '../src/modules/analytics/events.js';
import {
  bucketIndex,
  bucketLabel,
  bucketStarts,
  defaultGranularity,
  localDayOf,
  resolveRange,
  startOfLocalDay,
} from '../src/modules/analytics/range.js';
import { searchDetails } from '../src/modules/search/analytics.js';
import { VALID_INPUTS, hotelsRequest, parse } from './search-support.js';

/* Analytics building blocks without a database (Phase 31, docs/analytics.md). */

const IST = 'Asia/Kolkata';
const NY = 'America/New_York';

describe('reporting periods', () => {
  const now = new Date('2026-11-10T20:00:00Z'); // 11 Nov, 01:30 in India

  it('uses the reporting timezone’s calendar for "today"', () => {
    expect(localDayOf(now, IST)).toBe('2026-11-11');
    expect(localDayOf(now, 'UTC')).toBe('2026-11-10');
    const r = resolveRange({ preset: 'today' }, IST, now);
    expect(r.period).toMatchObject({
      from: '2026-11-11',
      to: '2026-11-11',
      start: '2026-11-10T18:30:00.000Z',
      end: now.toISOString(),
      days: 1,
      partial: true,
    });
    expect(r.previous).toMatchObject({
      from: '2026-11-10',
      to: '2026-11-10',
      start: '2026-11-09T18:30:00.000Z',
      end: '2026-11-10T18:30:00.000Z',
      partial: false,
    });
  });

  it('resolves every preset, with a same-length comparison period just before', () => {
    const cases = {
      last_7_days: ['2026-11-05', '2026-11-11', '2026-10-29', '2026-11-04'],
      last_30_days: ['2026-10-13', '2026-11-11', '2026-09-13', '2026-10-12'],
      this_month: ['2026-11-01', '2026-11-11', '2026-10-21', '2026-10-31'],
      last_month: ['2026-10-01', '2026-10-31', '2026-08-31', '2026-09-30'],
    } as const;
    for (const [preset, [from, to, pFrom, pTo]] of Object.entries(cases)) {
      const r = resolveRange({ preset: preset as keyof typeof cases }, IST, now);
      expect([r.period.from, r.period.to, r.previous.from, r.previous.to], preset).toEqual([
        from,
        to,
        pFrom,
        pTo,
      ]);
      expect(r.previous.days, preset).toBe(r.period.days);
    }
    expect(resolveRange({ preset: 'last_month' }, IST, now).period.partial).toBe(false);
  });

  it('handles daylight saving: a 23-hour and a 25-hour day are each one day', () => {
    // 8 March 2026: clocks go forward in New York; 1 November 2026: back.
    const spring = resolveRange(
      { preset: 'custom', from: '2026-03-08', to: '2026-03-08' },
      NY,
      now,
    );
    expect(spring.period.start).toBe('2026-03-08T05:00:00.000Z');
    expect(spring.period.end).toBe('2026-03-09T04:00:00.000Z');
    const autumn = resolveRange(
      { preset: 'custom', from: '2026-11-01', to: '2026-11-01' },
      NY,
      now,
    );
    expect(Date.parse(autumn.period.end) - Date.parse(autumn.period.start)).toBe(25 * 3600_000);
    expect(startOfLocalDay('2026-07-01', NY).toISOString()).toBe('2026-07-01T04:00:00.000Z');
  });

  it('validates custom ranges', () => {
    const bad = [
      { preset: 'custom', from: '2026-11-05', to: '2026-11-01' },
      { preset: 'custom', from: '2026-11-01', to: '2026-11-12' }, // future in India
      { preset: 'custom', from: '2025-01-01', to: '2026-11-01' }, // > 366 days
      { preset: 'custom', from: '2026-02-29', to: '2026-03-01' }, // not a real date
    ] as const;
    for (const q of bad) expect(() => resolveRange(q, IST, now), JSON.stringify(q)).toThrow();
    expect(analyticsQuerySchema.safeParse({ preset: 'custom' }).success).toBe(false);
    expect(analyticsQuerySchema.safeParse({ preset: 'today', from: '2026-01-01' }).success).toBe(
      false,
    );
    expect(() =>
      resolveRange(
        { preset: 'custom', from: '2025-11-12', to: '2026-11-11', granularity: 'day' },
        IST,
        now,
      ),
    ).not.toThrow();
  });

  it('buckets by day, ISO week (Monday) and month, clipped to the period', () => {
    expect(bucketStarts('2026-11-04', '2026-11-17', 'week')).toEqual([
      '2026-11-04',
      '2026-11-09',
      '2026-11-16',
    ]);
    expect(bucketStarts('2026-10-15', '2026-12-02', 'month')).toEqual([
      '2026-10-15',
      '2026-11-01',
      '2026-12-01',
    ]);
    const starts = bucketStarts('2026-11-04', '2026-11-17', 'week');
    expect(bucketIndex(starts, '2026-11-08')).toBe(0);
    expect(bucketIndex(starts, '2026-11-09')).toBe(1);
    expect(bucketIndex(starts, '2026-11-03')).toBe(-1);
    expect(bucketLabel('2026-11-09', 'week')).toBe('Week of 9 Nov');
    expect(bucketLabel('2026-11-01', 'month')).toBe('Nov 2026');
    expect([defaultGranularity(31), defaultGranularity(90), defaultGranularity(366)]).toEqual([
      'day',
      'week',
      'month',
    ]);
  });
});

describe('figures', () => {
  it('averages money exactly in minor units (half up), never with floats', () => {
    expect(averageMinor(1000n, 3)).toBe(333n);
    expect(averageMinor(1001n, 2)).toBe(501n);
    expect(averageMinor(9_007_199_254_740_993n, 1)).toBe(9_007_199_254_740_993n);
    expect(averageMinor(5n, 0)).toBe(0n);
  });

  it('rates are null with nothing to divide by', () => {
    expect(rate(0, 0)).toEqual({ numerator: 0, denominator: 0, value: null, previous: null });
    expect(rate(1, 4, 0.5).value).toBe(0.25);
  });

  const row = (over: Partial<FunnelRow>): FunnelRow => ({
    category: 'HOTEL',
    day: '2026-11-01',
    results: true,
    viewed: false,
    selected: false,
    initiated: false,
    real_booked: false,
    demo_booked: false,
    real_paid: false,
    demo_paid: false,
    supplier: false,
    n: 1,
    ...over,
  });

  it('funnel: a later stage implies the earlier ones; observed counts what was recorded', () => {
    const rows = [
      row({ results: false, n: 2 }), // failed or empty
      row({ n: 3 }), // results only
      row({ viewed: true, n: 2 }),
      row({ demo_booked: true, demo_paid: true }), // no client events (e.g. Do Not Track)
      row({ viewed: true, selected: true, initiated: true, real_booked: true, supplier: true }),
    ];
    const stages = funnelStages(rows);
    expect(stages.map((s) => s.count)).toEqual([9, 7, 4, 2, 2, 2, 1, 1]);
    expect(stages.map((s) => s.observed)).toEqual([9, 7, 3, 1, 1, 2, 1, 1]);
    expect(stages[5]!.split).toEqual({ real: 1, demo: 1 });
    expect(stages[6]!.split).toEqual({ real: 0, demo: 1 });
    // Supplier stage is measured against real bookings only.
    expect(stages[7]).toMatchObject({ count: 1, conversion: 1, split: { real: 1, demo: 0 } });
    expect(stages[1]).toMatchObject({ conversion: 7 / 9, dropOff: 2 });
    expect(stageReached(row({ results: false }))).toBe(0);
  });

  it('roles: support reads analytics without money; admins have everything', () => {
    expect(scopeFor('support')).toEqual({ financial: false, support: true, reviews: true });
    expect(scopeFor('admin')).toEqual({ financial: true, support: true, reviews: true });
    expect(hasPermission('support', 'admin.analytics.read')).toBe(true);
    expect(hasPermission('support', 'admin.analytics.export')).toBe(false);
    expect(hasPermission('user', 'admin.analytics.read')).toBe(false);
  });
});

describe('events', () => {
  it('every event type is defined, and critical ones are never client-side', () => {
    for (const t of ANALYTICS_EVENT_TYPES) {
      const d = ANALYTICS_EVENT_DEFINITIONS[t];
      expect(d.description.length, t).toBeGreaterThan(10);
      if (d.critical) expect(d.recordedBy, t).toBe('trigger');
    }
    expect(STORED_EVENT_TYPES).toContain('payment.succeeded');
    expect(STORED_EVENT_TYPES).not.toContain('search.initiated');
  });

  it('the migration’s triggers write exactly the trigger-recorded types', () => {
    const sql = readFileSync(
      fileURLToPath(
        new URL(
          '../../../database/migrations/20261110000000_analytics/migration.sql',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    const emitted = new Set([...sql.matchAll(/"analytics_emit"\('([a-z._]+)'/g)].map((m) => m[1]));
    const triggers = ANALYTICS_EVENT_TYPES.filter(
      (t) => ANALYTICS_EVENT_DEFINITIONS[t].recordedBy === 'trigger',
    );
    expect([...emitted].sort()).toEqual([...triggers].sort());
  });

  it('keys are deterministic: the same occurrence is recorded once', () => {
    const a = offerViewed('hotels', '0190a6b4-0000-7000-8000-000000000001', 'demo:H1');
    const b = offerViewed('hotels', '0190a6b4-0000-7000-8000-000000000001', 'demo:H1');
    expect(a.dedupeKey).toBe(b.dedupeKey);
    expect(a.dedupeKey).not.toContain('demo:H1');
    expect(keyPart('x')).toHaveLength(32);
    const s = offerSelected({
      type: 'offer.selected',
      serviceType: 'flights',
      searchId: '0190a6b4-0000-7000-8000-000000000001',
      offerId: 'demo:F1',
    });
    expect(s).toMatchObject({ type: 'offer.selected', category: 'FLIGHT' });
  });

  it('client events accept the allow-listed shape only', () => {
    const ok = {
      type: 'offer.selected',
      serviceType: 'hotels',
      searchId: '0190a6b4-0000-7000-8000-000000000001',
      offerId: 'demo:H1',
    };
    expect(analyticsInteractionsSchema.safeParse({ events: [ok] }).success).toBe(true);
    for (const bad of [
      { ...ok, email: 'a@b.c' },
      { ...ok, type: 'payment.succeeded' },
      { ...ok, searchId: 'not-a-uuid' },
    ])
      expect(analyticsInteractionsSchema.safeParse({ events: [bad] }).success).toBe(false);
    expect(analyticsInteractionsSchema.safeParse({ events: Array(11).fill(ok) }).success).toBe(
      false,
    );
  });

  it('honours Do Not Track and Global Privacy Control', () => {
    const req = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] });
    expect(declinedTracking(req({ dnt: '1' }))).toBe(true);
    expect(declinedTracking(req({ 'sec-gpc': '1' }))).toBe(true);
    expect(declinedTracking(req({ dnt: '0' }))).toBe(false);
  });

  it('activity: once per customer per local day; staff and polling never count', () => {
    const recorded: ApiEvent[] = [];
    const recorder: AnalyticsRecorder = {
      record: (e) => void recorded.push(e),
      recordNow: () => Promise.resolve(0),
    };
    let t = Date.parse('2026-11-10T18:29:00Z');
    const track = activityTracker(
      recorder,
      (d) => localDayOf(d, IST),
      () => new Date(t),
    );
    const user = { id: '0190a6b4-0000-7000-8000-00000000000a', role: 'USER' };
    expect(track(user, '/api/v1/auth/me')).toBe(true);
    expect(track(user, '/api/v1/bookings')).toBe(false);
    t += 2 * 60_000; // past midnight in India
    expect(track(user, '/api/v1/notifications/unread-count')).toBe(false);
    expect(track(user, '/api/v1/trips/WYD-1/events')).toBe(false);
    expect(track(user, '/api/v1/auth/me')).toBe(true);
    expect(track({ ...user, role: 'ADMIN' }, '/api/v1/admin/overview')).toBe(false);
    expect(recorded.map((e) => e.dedupeKey.slice(-10))).toEqual(['2026-11-10', '2026-11-11']);
    expect(isAutomatic('/api/v1/notifications?page=1')).toBe(false);
  });

  it('search details are coarse: place ids, a month, field names — never values or dates', () => {
    const d = searchDetails(
      hotelsRequest({
        filters: { amenities: ['wifi'], breakfastIncluded: true },
        sortBy: 'price-desc',
      } as never),
      false,
    );
    expect(d).toMatchObject({
      originPlace: null,
      destinationPlace: 'city:goa',
      filterKeys: ['amenities', 'breakfastIncluded'],
      sort: 'price-desc',
      reused: false,
    });
    expect(d.travelMonth).toMatch(/^\d{4}-\d{2}-01$/);
    expect(JSON.stringify(d)).not.toMatch(/wifi|true/);
    // The category's default sort isn't a sort the visitor chose.
    expect(searchDetails(hotelsRequest(), true)).toMatchObject({ sort: null, reused: true });
    const cab = searchDetails(parse(VALID_INPUTS.cabs), false);
    expect(cab).toMatchObject({
      originPlace: 'airport:BLR',
      destinationPlace: 'locality:blr-koramangala',
      travelMonth: `${VALID_INPUTS.cabs.pickupAt.slice(0, 7)}-01`,
    });
  });
});

describe('cache', () => {
  it('expires entries and stays bounded', async () => {
    let t = 0;
    const cache = new MemoryAnalyticsCache(2, () => t);
    await cache.set('a', '1', 60);
    expect(await cache.get('a')).toBe('1');
    t = 61_000;
    expect(await cache.get('a')).toBeNull();
    await cache.set('b', '2', 60);
    await cache.set('c', '3', 60);
    await cache.set('d', '4', 60);
    expect(await cache.get('b')).toBeNull();
    expect(await cache.get('d')).toBe('4');
  });

  it('a Redis failure is a miss, never an error', async () => {
    const broken = redisAnalyticsCache({
      get: vi.fn().mockRejectedValue(new Error('down')),
      set: vi.fn().mockRejectedValue(new Error('down')),
    });
    expect(await broken.get('k')).toBeNull();
    await expect(broken.set('k', 'v', 60)).resolves.toBeUndefined();
  });
});

describe('CSV', () => {
  it('quotes cells and neutralises spreadsheet formulas, but keeps negative numbers', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-1500')).toBe('-1500');
    expect(csvCell(null)).toBe('');
    expect(csvCell(0)).toBe('0');
  });

  it('exports the same figures as the report, with demo rows labelled', () => {
    const meta = {
      timezone: IST,
      period: {
        from: '2026-11-01',
        to: '2026-11-07',
        start: '2026-10-31T18:30:00.000Z',
        end: '2026-11-07T18:30:00.000Z',
        days: 7,
        partial: false,
      },
      previous: {
        from: '2026-10-25',
        to: '2026-10-31',
        start: '2026-10-24T18:30:00.000Z',
        end: '2026-10-31T18:30:00.000Z',
        days: 7,
        partial: false,
      },
      granularity: 'day' as const,
      generatedAt: '2026-11-08T00:00:00.000Z',
    };
    const marketing = {
      ...meta,
      promotedBookings: {
        real: { value: 0, previous: 0 },
        demo: { value: 2, previous: 1 },
      },
      promotions: [
        {
          id: '0190a6b4-0000-7000-8000-000000000001',
          name: '=cmd',
          kind: 'coupon' as const,
          code: 'SAVE10',
          live: true,
          applied: 3,
          redeemed: { real: 0, demo: 2 },
          released: 1,
          discount: { real: [], demo: [{ currency: 'INR', amountMinor: '20000' }] },
        },
      ],
      couponConversion: rate(2, 3),
      loyalty: [],
      notes: [],
    };
    const rows = reportRows('marketing', marketing);
    expect(rows).toContainEqual(
      expect.objectContaining({
        section: 'promotions',
        metric: 'discount',
        mode: 'demo',
        value: '20000',
      }),
    );
    const csv = toCsv('marketing', marketing);
    expect(csv.split('\r\n')).toContain(CSV_COLUMNS.join(','));
    expect(csv).toContain("'=cmd (SAVE10)");
    expect(csv).toContain('timezone,Asia/Kolkata');
  });
});
