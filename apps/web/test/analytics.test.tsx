import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ROLE_PERMISSIONS,
  funnelReportSchema,
  overviewReportSchema,
  type UserRole,
} from '@wayora/contracts';
import { changeText, compactMoney } from '../src/features/admin/AnalyticsAdmin';
import { LineChart, niceTicks } from '../src/features/admin/charts';
import { trackOfferSelected } from '../src/services/analytics-events';
import { installFakeAdminApi } from './fake-admin-api';
import { renderRoute } from './render';

/*
 * Analytics pages (Phase 31, docs/analytics.md): figures from the server,
 * demo labelled apart from real, money only for roles that may see it,
 * honest charts (zero-based, gaps for "not recorded", a data table), the
 * shared date filter in the URL, and CSV downloads. The API's own access
 * rules are tested in apps/api/test/integration/analytics.test.ts.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const JOURNEY = { timeout: 20_000 };

const META = {
  timezone: 'Asia/Kolkata',
  period: {
    from: '2026-11-04',
    to: '2026-11-10',
    start: '2026-11-03T18:30:00.000Z',
    end: '2026-11-10T09:00:00.000Z',
    days: 7,
    partial: true,
  },
  previous: {
    from: '2026-10-28',
    to: '2026-11-03',
    start: '2026-10-27T18:30:00.000Z',
    end: '2026-11-03T18:30:00.000Z',
    days: 7,
    partial: false,
  },
  granularity: 'day' as const,
  generatedAt: '2026-11-10T09:00:00.000Z',
};
const days = ['4 Nov', '5 Nov', '6 Nov', '7 Nov', '8 Nov', '9 Nov', '10 Nov'];
const buckets = days.map((label, i) => ({
  start: `2026-11-${String(4 + i).padStart(2, '0')}`,
  label,
}));
const series = (key: string, label: string, points: (number | null)[]) => ({ key, label, points });

const overview = (withMoney: boolean) =>
  overviewReportSchema.parse({
    ...META,
    users: {
      total: 120,
      new: { value: 9, previous: 6 },
      active: { value: 31, previous: null },
      activeCoverage: { since: '2026-11-06T00:00:00.000Z', complete: false },
    },
    searches: {
      total: { value: 80, previous: 64 },
      requests: 140,
      coverage: { since: '2026-01-01T00:00:00.000Z', complete: true },
    },
    conversion: { numerator: 8, denominator: 80, value: 0.1, previous: 0.125 },
    bookings: {
      created: { real: { value: 0, previous: 0 }, demo: { value: 8, previous: 8 } },
      cancelled: { real: 0, demo: 1 },
      supplierConfirmed: { value: 0, previous: 0 },
    },
    payments: {
      successRate: {
        real: { numerator: 0, denominator: 0, value: null, previous: null },
        demo: { numerator: 6, denominator: 7, value: 6 / 7, previous: 1 },
      },
    },
    money: withMoney
      ? [
          {
            mode: 'real',
            grossBookingValue: [],
            collected: [],
            refunded: [],
            averageBookingValue: [],
          },
          {
            mode: 'demo',
            grossBookingValue: [
              { currency: 'INR', amountMinor: '4500000', previousMinor: '3000000' },
            ],
            collected: [{ currency: 'INR', amountMinor: '4200000', previousMinor: '3000000' }],
            refunded: [],
            averageBookingValue: [
              { currency: 'INR', amountMinor: '750000', previousMinor: '500000' },
            ],
          },
        ]
      : null,
    trend: {
      buckets,
      series: [
        series('searches', 'Searches', [10, 12, 8, 14, 9, 15, 12]),
        series('bookings_real', 'Real bookings', [0, 0, 0, 0, 0, 0, 0]),
        series('bookings_demo', 'Demo bookings', [1, 2, 0, 1, 1, 2, 1]),
        series('new_users', 'New customers', [1, 2, 1, 1, 2, 1, 1]),
        series('active_users', 'Active customers', [null, null, 4, 6, 7, 8, 9]),
      ],
      previous: [
        series('searches', 'Searches', [9, 9, 9, 9, 9, 9, 10]),
        series('bookings_real', 'Real bookings', [0, 0, 0, 0, 0, 0, 0]),
        series('bookings_demo', 'Demo bookings', [1, 1, 1, 1, 1, 1, 2]),
        series('new_users', 'New customers', [1, 1, 1, 1, 1, 1, 0]),
        series('active_users', 'Active customers', [null, null, null, null, null, null, null]),
      ],
    },
    notes: [
      { metric: 'Real revenue', reason: 'No real (live) payment has succeeded in this period.' },
    ],
  });

const funnel = funnelReportSchema.parse({
  ...META,
  coverage: {
    searches: { since: '2026-01-01T00:00:00.000Z', complete: true },
    events: { since: '2026-11-06T00:00:00.000Z', complete: false },
  },
  stages: [
    ['search_initiated', 'Search started', 80, 80, null, null, null],
    ['results_returned', 'Results returned', 72, 72, 0.9, 8, null],
    ['offer_viewed', 'Offer viewed', 30, 20, 30 / 72, 42, null],
    ['offer_selected', 'Offer chosen', 12, 5, 0.4, 18, null],
    ['booking_initiated', 'Booking submitted', 10, 10, 10 / 12, 2, null],
    ['booking_created', 'Booking created', 8, 8, 0.8, 2, { real: 0, demo: 8 }],
    ['payment_completed', 'Payment completed', 6, 6, 0.75, 2, { real: 0, demo: 6 }],
    ['supplier_confirmed', 'Supplier confirmed', 0, 0, null, 0, { real: 0, demo: 0 }],
  ].map(([key, label, count, observed, conversion, dropOff, split]) => ({
    key,
    label,
    count,
    observed,
    conversion,
    dropOff,
    split,
  })),
  byCategory: [{ category: 'hotels', counts: [80, 72, 30, 12, 10, 8, 6, 0] }],
  trend: {
    buckets,
    series: [series('searches', 'Searches', [10, 12, 8, 14, 9, 15, 12])],
    previous: [],
  },
  notes: [],
});

/** The admin fake plus the analytics endpoints, with the server's rules. */
function installAnalytics(role: UserRole) {
  const admin = installFakeAdminApi({ role });
  const base = globalThis.fetch;
  const calls: string[] = [];
  const can = (p: string) => (ROLE_PERMISSIONS[role] as readonly string[]).includes(p);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const forbidden = () =>
    json(403, {
      error: { code: 'FORBIDDEN', message: 'You don’t have access to this.', requestId: 'r' },
    });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const m = /^\/api\/v1\/admin\/analytics\/(\w+)(\/export)?$/.exec(url.pathname);
    if (!m) return base(input, init);
    calls.push(`${url.pathname}${url.search}`);
    if (!can('admin.analytics.read')) return forbidden();
    const [, report, exp] = m;
    if (exp) {
      if (!can('admin.analytics.export')) return forbidden();
      return new Response('report,overview\r\n', {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition':
            'attachment; filename="wayora-overview-2026-11-04-to-2026-11-10.csv"',
        },
      });
    }
    if (report === 'overview')
      return json(200, {
        data: overview(can('admin.analytics.financial')),
        meta: { requestId: 'r' },
      });
    if (report === 'funnel') return json(200, { data: funnel, meta: { requestId: 'r' } });
    return json(404, { error: { code: 'NOT_FOUND', message: 'Not found.', requestId: 'r' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { admin, calls };
}

describe('analytics pages', JOURNEY, () => {
  it('administrators see figures, demo labelled apart from real money, and notes', async () => {
    installAnalytics('admin');
    renderRoute('/admin/analytics');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Analytics: Overview' }),
    ).toBeInTheDocument();
    const reports = screen.getByRole('navigation', { name: 'Reports' });
    expect(within(reports).getByRole('link', { name: 'Revenue' })).toBeInTheDocument();
    expect(within(reports).getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    expect((await screen.findAllByText('Demo bookings'))[0]).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Money (real)' })).toBeInTheDocument();
    expect(
      screen.getByText(/No real bookings were confirmed and no real payments succeeded/),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Demo · simulated, not money').length).toBeGreaterThan(0);
    // A comparison that wasn't recorded says so; never a fake percentage.
    expect(screen.getAllByText(/No comparison: not recorded then/).length).toBeGreaterThan(0);
    expect(screen.getByText(/days in Asia\/Kolkata/)).toBeInTheDocument();
    expect(screen.getByText('Real revenue:')).toBeInTheDocument();
  });

  it('support staff get counts without money, no Revenue tab and no download', async () => {
    const { calls } = installAnalytics('support');
    renderRoute('/admin/analytics');
    await screen.findAllByText('Demo bookings');
    expect(screen.queryByRole('heading', { name: 'Money (real)' })).toBeNull();
    const reports = screen.getByRole('navigation', { name: 'Reports' });
    expect(within(reports).queryByRole('link', { name: 'Revenue' })).toBeNull();
    expect(screen.queryByRole('button', { name: /download csv/i })).toBeNull();
    expect(calls.every((c) => !c.includes('/export'))).toBe(true);
  });

  it('customers get "no access" and the analytics API is never asked', async () => {
    const { calls } = installAnalytics('user');
    renderRoute('/admin/analytics');
    expect(
      (await screen.findAllByRole('heading', { name: /you don’t have access/i })).length,
    ).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });

  it('the period filter lives in the URL and is sent to the server as is', async () => {
    const { calls } = installAnalytics('admin');
    const { router } = renderRoute('/admin/analytics/funnel?preset=last_7_days');
    await screen.findByRole('heading', { level: 1, name: 'Analytics: Funnel' });
    expect(calls[0]).toBe('/api/v1/admin/analytics/funnel?preset=last_7_days');
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To (inclusive)'), { target: { value: '2026-10-31' } });
    fireEvent.change(screen.getByLabelText('Group by'), { target: { value: 'week' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(router.state.location.search).toBe(
        '?preset=custom&from=2026-10-01&to=2026-10-31&granularity=week',
      ),
    );
    await waitFor(() =>
      expect(calls.at(-1)).toBe(
        '/api/v1/admin/analytics/funnel?preset=custom&from=2026-10-01&to=2026-10-31&granularity=week',
      ),
    );
    // Moving between reports keeps the period.
    const reports = screen.getByRole('navigation', { name: 'Reports' });
    expect(within(reports).getByRole('link', { name: 'Search' })).toHaveAttribute(
      'href',
      '/admin/analytics/search?preset=custom&from=2026-10-01&to=2026-10-31&granularity=week',
    );
  });

  it('funnel stages show counts, step conversion, what was recorded directly and the demo split', async () => {
    installAnalytics('admin');
    renderRoute('/admin/analytics/funnel');
    const list = await screen.findByRole('list', { name: 'Funnel stages' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(8);
    expect(items[2]).toHaveTextContent('Offer viewed');
    expect(items[2]).toHaveTextContent('20 recorded at this stage');
    expect(items[5]).toHaveTextContent('0 real · 8 demo');
    expect(items[1]).toHaveTextContent('↓ 90%');
  });

  it('downloads a CSV for administrators', async () => {
    const { calls } = installAnalytics('admin');
    const createObjectURL = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: revoke }));
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    renderRoute('/admin/analytics?preset=today');
    fireEvent.click(await screen.findByRole('button', { name: /download csv/i }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(calls).toContain('/api/v1/admin/analytics/overview/export?preset=today');
    expect(createObjectURL).toHaveBeenCalled();
    click.mockRestore();
  });
});

describe('charts', () => {
  it('axes start at zero with round ticks', () => {
    expect(niceTicks(9)).toEqual([0, 2.5, 5, 7.5, 10]);
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(1234)[0]).toBe(0);
    expect(niceTicks(1234).at(-1)).toBeGreaterThanOrEqual(1234);
  });

  it('line charts name their series, show values on focus, and offer the numbers as a table', () => {
    render(
      <LineChart
        title="Searches"
        labels={['1 Nov', '2 Nov', '3 Nov']}
        lines={[
          { label: 'This period', points: [null, 4, 6] },
          { label: 'Previous period', points: [2, 3, 5], previous: true },
        ]}
      />,
    );
    const chart = screen.getByRole('img', { name: 'Searches' });
    expect(screen.getByText('Previous period', { selector: 'li' })).toBeInTheDocument();
    fireEvent.keyDown(chart, { key: 'Home' });
    const tip = screen.getByRole('status');
    expect(tip).toHaveTextContent('1 Nov');
    expect(tip).toHaveTextContent('Not recorded');
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    expect(screen.getByRole('status')).toHaveTextContent('2 Nov');
    const table = screen.getByRole('table', { name: 'Searches' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
  });

  it('says when there is nothing to draw, instead of a flat zero line', () => {
    render(
      <LineChart title="Active" labels={['1 Nov']} lines={[{ label: 'Active', points: [null] }]} />,
    );
    expect(screen.getByText('No data recorded for this period.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('money axes are compact amounts in major units, from minor units', () => {
    expect(compactMoney('INR')(5_000_000)).toBe('₹50K');
    expect(compactMoney('INR')(0)).toBe('₹0');
    expect(compactMoney('JPY')(12_000)).toBe('¥12K');
  });

  it('comparisons never divide by zero or invent a change', () => {
    expect(changeText(5, 0)).toBe('Up from 0');
    expect(changeText(0, 0)).toBe('Same as previous period');
    expect(changeText(5, null)).toBe('No comparison: not recorded then');
    expect(changeText(null, 3)).toBe('Not recorded');
    expect(changeText(15, 10)).toBe('+50% vs previous period');
  });
});

describe('"offer chosen" event', () => {
  it('is sent without credentials, and not at all when tracking is declined', () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
    vi.stubGlobal('fetch', fetchMock);
    const event = {
      serviceType: 'hotels' as const,
      searchId: '0190a6b4-0000-7000-8000-000000000001',
      offerId: 'demo:H1',
    };
    trackOfferSelected(event);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/v1\/analytics\/interactions$/);
    expect(init.credentials).toBe('omit');
    expect(JSON.parse(String(init.body))).toEqual({
      events: [{ type: 'offer.selected', ...event }],
    });

    vi.stubGlobal('navigator', { ...navigator, globalPrivacyControl: true });
    trackOfferSelected(event);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
