import type {
  AnalyticsReport,
  AnalyticsReports,
  Compared,
  ComparedMoney,
  ReportMeta,
  Trend,
} from '@wayora/contracts';

/*
 * CSV export (docs/analytics.md#export). One long table per report, the
 * same figures the dashboard shows (both come from the same computed
 * report), so a spreadsheet and the screen always agree:
 *
 *   section, metric, dimension, mode, currency, value, previous
 *
 * `mode` is "real" or "demo" wherever the distinction applies (demo rows
 * are simulated and never money). Money is in minor units (paise, cents),
 * as integers. No row names a customer; staff appear only by display name
 * in support workload, as on the screen.
 */

export const CSV_COLUMNS = [
  'section',
  'metric',
  'dimension',
  'mode',
  'currency',
  'value',
  'previous',
] as const;

type Cell = string | number | null | undefined;
type Row = Record<(typeof CSV_COLUMNS)[number], Cell>;

/** Hard cap: a report never exports more rows than this. */
export const MAX_EXPORT_ROWS = 5000;

/**
 * Quotes a cell. Text that a spreadsheet would run as a formula (starting
 * with = + - @, tab or carriage return) is prefixed with an apostrophe.
 */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // Plain integers and decimals (e.g. a negative net amount) stay numbers.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s))
    s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const row = (section: string, metric: string, extra: Partial<Row> = {}): Row => ({
  section,
  metric,
  dimension: null,
  mode: null,
  currency: null,
  value: null,
  previous: null,
  ...extra,
});

const compared = (section: string, metric: string, c: Compared, extra: Partial<Row> = {}): Row =>
  row(section, metric, { value: c.value, previous: c.previous, ...extra });

const money = (
  section: string,
  metric: string,
  m: ComparedMoney,
  mode: string,
  extra: Partial<Row> = {},
): Row =>
  row(section, metric, {
    mode,
    currency: m.currency,
    value: m.amountMinor,
    previous: m.previousMinor,
    ...extra,
  });

function trendRows(section: string, t: Trend, mode?: string, currency?: string): Row[] {
  const out: Row[] = [];
  t.series.forEach((s, si) => {
    t.buckets.forEach((b, bi) => {
      out.push(
        row(section, s.key, {
          dimension: b.start,
          mode: mode ?? null,
          currency: currency ?? null,
          value: s.points[bi] ?? null,
          previous: t.previous[si]?.points[bi] ?? null,
        }),
      );
    });
  });
  return out;
}

const rateRow = (
  section: string,
  metric: string,
  r: { value: number | null; previous: number | null },
  extra: Partial<Row> = {},
) => row(section, metric, { value: r.value, previous: r.previous, ...extra });

/** The rows of a report, in display order. */
export function reportRows<R extends AnalyticsReport>(report: R, data: AnalyticsReports[R]): Row[] {
  const rows: Row[] = [];
  switch (report) {
    case 'overview': {
      const d = data as AnalyticsReports['overview'];
      rows.push(row('users', 'total', { value: d.users.total }));
      rows.push(compared('users', 'new', d.users.new));
      rows.push(compared('users', 'active', d.users.active));
      rows.push(compared('searches', 'searches', d.searches.total));
      rows.push(row('searches', 'requests', { value: d.searches.requests }));
      rows.push(rateRow('conversion', 'search_to_booking', d.conversion));
      rows.push(compared('bookings', 'created', d.bookings.created.real, { mode: 'real' }));
      rows.push(compared('bookings', 'created', d.bookings.created.demo, { mode: 'demo' }));
      rows.push(row('bookings', 'cancelled', { mode: 'real', value: d.bookings.cancelled.real }));
      rows.push(row('bookings', 'cancelled', { mode: 'demo', value: d.bookings.cancelled.demo }));
      rows.push(
        compared('bookings', 'supplier_confirmed', d.bookings.supplierConfirmed, { mode: 'real' }),
      );
      rows.push(rateRow('payments', 'success_rate', d.payments.successRate.real, { mode: 'real' }));
      rows.push(rateRow('payments', 'success_rate', d.payments.successRate.demo, { mode: 'demo' }));
      for (const m of d.money ?? []) {
        for (const x of m.grossBookingValue)
          rows.push(money('money', 'gross_booking_value', x, m.mode));
        for (const x of m.collected) rows.push(money('money', 'collected', x, m.mode));
        for (const x of m.refunded) rows.push(money('money', 'refunded', x, m.mode));
        for (const x of m.averageBookingValue)
          rows.push(money('money', 'average_booking_value', x, m.mode));
      }
      rows.push(...trendRows('trend', d.trend));
      break;
    }
    case 'revenue': {
      const d = data as AnalyticsReports['revenue'];
      for (const m of d.modes) {
        for (const l of m.lines) {
          const add = (metric: string, x: ComparedMoney) =>
            rows.push(money('revenue', metric, x, m.mode));
          add('gross_booking_value', l.grossBookingValue);
          rows.push(
            compared('revenue', 'confirmed_bookings', l.confirmedBookings, {
              mode: m.mode,
              currency: l.currency,
            }),
          );
          rows.push(
            row('revenue', 'unpriced_bookings', {
              mode: m.mode,
              currency: l.currency,
              value: l.unpricedBookings,
            }),
          );
          add('promotion_discount', l.promotionDiscount);
          add('coupon_discount', l.couponDiscount);
          add('points_redeemed', l.pointsRedeemed);
          add('travel_credit_used', l.travelCreditUsed);
          add('payments_succeeded', l.paymentsSucceeded);
          add('refunds_completed', l.refundsCompleted);
          rows.push(
            row('revenue', 'refunds_pending', {
              mode: m.mode,
              currency: l.currency,
              value: l.refundsPending.amountMinor,
            }),
          );
          rows.push(
            row('revenue', 'refunds_pending_count', {
              mode: m.mode,
              currency: l.currency,
              value: l.refundsPending.count,
            }),
          );
          add('net_collected', l.netCollected);
          add('average_booking_value', l.averageBookingValue);
        }
      }
      for (const t of d.trends) rows.push(...trendRows('trend', t.trend, t.mode, t.currency));
      break;
    }
    case 'funnel': {
      const d = data as AnalyticsReports['funnel'];
      for (const s of d.stages) {
        rows.push(row('funnel', s.key, { value: s.count }));
        rows.push(row('funnel', `${s.key}_observed`, { value: s.observed }));
        rows.push(row('funnel', `${s.key}_conversion`, { value: s.conversion }));
        if (s.split) {
          rows.push(row('funnel', s.key, { mode: 'real', value: s.split.real }));
          rows.push(row('funnel', s.key, { mode: 'demo', value: s.split.demo }));
        }
      }
      for (const c of d.byCategory)
        c.counts.forEach((n, i) =>
          rows.push(
            row('by_category', d.stages[i]?.key ?? String(i), { dimension: c.category, value: n }),
          ),
        );
      rows.push(...trendRows('trend', d.trend));
      break;
    }
    case 'search': {
      const d = data as AnalyticsReports['search'];
      for (const c of d.byCategory) {
        rows.push(row('by_category', 'searches', { dimension: c.category, value: c.searches }));
        rows.push(row('by_category', 'requests', { dimension: c.category, value: c.requests }));
        rows.push(row('by_category', 'no_results', { dimension: c.category, value: c.noResults }));
        rows.push(row('by_category', 'failed', { dimension: c.category, value: c.failed }));
      }
      rows.push(rateRow('rates', 'no_results_rate', d.noResultsRate));
      rows.push(rateRow('rates', 'search_to_offer', d.searchToOffer));
      rows.push(rateRow('rates', 'abandonment', d.abandonment));
      for (const r of d.routes)
        rows.push(
          row('routes', r.category, {
            dimension: `${r.originName ?? ''} → ${r.destinationName}`,
            value: r.searches,
          }),
        );
      for (const m of d.travelMonths)
        rows.push(row('travel_months', 'searches', { dimension: m.month, value: m.searches }));
      for (const f of d.filters)
        rows.push(row('filters', 'requests', { dimension: f.filter, value: f.requests }));
      for (const s of d.sorts)
        rows.push(row('sorts', 'requests', { dimension: s.sort, value: s.requests }));
      for (const v of d.destinationViews)
        rows.push(row('destination_views', 'views', { dimension: v.name, value: v.views }));
      rows.push(...trendRows('trend', d.trend));
      break;
    }
    case 'customers': {
      const d = data as AnalyticsReports['customers'];
      rows.push(compared('customers', 'registrations', d.registrations));
      rows.push(compared('customers', 'active', d.active));
      rows.push(compared('customers', 'returning', d.returning));
      for (const b of d.booking) {
        rows.push(compared('booking', 'customers', b.customers, { mode: b.mode }));
        rows.push(rateRow('booking', 'repeat_rate', b.repeat, { mode: b.mode }));
        rows.push(row('booking', 'frequency', { mode: b.mode, value: b.frequency }));
      }
      if (d.retention) rows.push(rateRow('customers', 'retention', d.retention));
      for (const t of d.tiers)
        rows.push(row('tiers', 'accounts', { mode: t.mode, dimension: t.tier, value: t.accounts }));
      for (const r of d.rewards) {
        rows.push(row('rewards', 'earners', { mode: r.mode, value: r.earners }));
        rows.push(row('rewards', 'redeemers', { mode: r.mode, value: r.redeemers }));
        rows.push(row('rewards', 'accounts', { mode: r.mode, value: r.accounts }));
      }
      rows.push(...trendRows('trend', d.trend));
      break;
    }
    case 'providers': {
      const d = data as AnalyticsReports['providers'];
      for (const p of d.search) {
        const dim = { dimension: p.id, mode: p.kind };
        rows.push(compared('search_providers', 'calls', p.calls, dim));
        for (const [o, n] of Object.entries(p.byOutcome))
          rows.push(row('search_providers', `outcome_${o}`, { ...dim, value: n }));
        rows.push(rateRow('search_providers', 'answer_rate', p.answerRate, dim));
        rows.push(rateRow('search_providers', 'timeout_rate', p.timeoutRate, dim));
        rows.push(row('search_providers', 'average_ms', { ...dim, value: p.averageMs }));
        rows.push(row('search_providers', 'p95_ms', { ...dim, value: p.p95Ms }));
      }
      for (const r of d.reservations) {
        const dim = { dimension: r.provider, mode: r.kind };
        rows.push(row('reservations', 'started', { ...dim, value: r.started }));
        for (const [s, n] of Object.entries(r.byStatus))
          rows.push(row('reservations', `status_${s}`, { ...dim, value: n }));
        rows.push(rateRow('reservations', 'success_rate', r.successRate, dim));
        for (const [c, n] of Object.entries(r.errorCategories))
          rows.push(row('reservations', `error_${c}`, { ...dim, value: n }));
      }
      break;
    }
    case 'marketing': {
      const d = data as AnalyticsReports['marketing'];
      rows.push(
        compared('promoted_bookings', 'bookings', d.promotedBookings.real, { mode: 'real' }),
      );
      rows.push(
        compared('promoted_bookings', 'bookings', d.promotedBookings.demo, { mode: 'demo' }),
      );
      for (const p of d.promotions) {
        const dim = { dimension: `${p.name}${p.code ? ` (${p.code})` : ''}` };
        rows.push(row('promotions', 'applied', { ...dim, value: p.applied }));
        rows.push(row('promotions', 'redeemed', { ...dim, mode: 'real', value: p.redeemed.real }));
        rows.push(row('promotions', 'redeemed', { ...dim, mode: 'demo', value: p.redeemed.demo }));
        rows.push(row('promotions', 'released', { ...dim, value: p.released }));
        for (const mode of ['real', 'demo'] as const)
          for (const a of p.discount[mode])
            rows.push(
              row('promotions', 'discount', {
                ...dim,
                mode,
                currency: a.currency,
                value: a.amountMinor,
              }),
            );
      }
      rows.push(rateRow('coupons', 'conversion', d.couponConversion));
      for (const l of d.loyalty) {
        rows.push(row('loyalty', 'points_earned', { mode: l.mode, value: l.pointsEarned }));
        rows.push(row('loyalty', 'points_redeemed', { mode: l.mode, value: l.pointsRedeemed }));
        rows.push(row('loyalty', 'points_expired', { mode: l.mode, value: l.pointsExpired }));
        for (const [metric, list] of [
          ['credit_issued', l.creditIssued],
          ['credit_used', l.creditUsed],
          ['credit_expired', l.creditExpired],
        ] as const)
          for (const a of list)
            rows.push(
              row('loyalty', metric, { mode: l.mode, currency: a.currency, value: a.amountMinor }),
            );
      }
      break;
    }
    case 'support': {
      const d = data as AnalyticsReports['support'];
      if (d.tickets) {
        const t = d.tickets;
        rows.push(compared('tickets', 'created', t.created));
        rows.push(compared('tickets', 'resolved', t.resolved));
        rows.push(row('tickets', 'escalated', { value: t.escalated }));
        rows.push(row('tickets', 'open_now', { value: t.openNow }));
        rows.push(
          row('tickets', 'first_response_average_minutes', {
            value: t.firstResponse.averageMinutes,
          }),
        );
        rows.push(
          row('tickets', 'first_response_median_minutes', { value: t.firstResponse.medianMinutes }),
        );
        rows.push(
          row('tickets', 'resolution_average_minutes', { value: t.resolution.averageMinutes }),
        );
        rows.push(
          row('tickets', 'resolution_median_minutes', { value: t.resolution.medianMinutes }),
        );
        for (const c of t.byCategory)
          rows.push(
            row('tickets_by_category', 'created', { dimension: c.category, value: c.created }),
          );
        for (const w of t.workload)
          rows.push(row('workload', 'active', { dimension: w.name, value: w.active }));
      }
      if (d.reviews) {
        const r = d.reviews;
        rows.push(compared('reviews', 'submitted', r.submitted));
        rows.push(compared('reviews', 'average_published_rating', r.averagePublishedRating));
        rows.push(row('reviews', 'published_in_period', { value: r.publishedInPeriod }));
        for (const [v, n] of Object.entries(r.byVerification))
          rows.push(row('reviews_by_verification', 'submitted', { dimension: v, value: n }));
        rows.push(row('reviews', 'pending_now', { value: r.pendingNow }));
        rows.push(row('reviews', 'flagged_now', { value: r.flaggedNow }));
        rows.push(row('reviews', 'open_reports_now', { value: r.openReportsNow }));
      }
      rows.push(...trendRows('trend', d.trend));
      break;
    }
  }
  return rows.slice(0, MAX_EXPORT_ROWS);
}

/** The CSV document: a few lines describing the export, then the table. */
export function toCsv<R extends AnalyticsReport>(report: R, data: AnalyticsReports[R]): string {
  const meta = data as ReportMeta;
  const lines = [
    ['report', report],
    [
      'period',
      `${meta.period.from} to ${meta.period.to}${meta.period.partial ? ' (to date)' : ''}`,
    ],
    ['comparison', `${meta.previous.from} to ${meta.previous.to}`],
    ['timezone', meta.timezone],
    ['generated', meta.generatedAt],
    ['amounts', 'minor units (e.g. paise); mode "demo" rows are simulated and never money'],
    [],
    [...CSV_COLUMNS],
    ...reportRows(report, data).map((r) => CSV_COLUMNS.map((c) => r[c])),
  ];
  return lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
