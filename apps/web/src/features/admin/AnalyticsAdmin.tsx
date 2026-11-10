import { useMutation, useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { NavLink, useParams, useSearchParams } from 'react-router';
import {
  ANALYTICS_PRESETS,
  analyticsQuerySchema,
  analyticsReportSchema,
  type AnalyticsNote,
  type AnalyticsPreset,
  type AnalyticsQuery,
  type AnalyticsRate,
  type AnalyticsReport,
  type AnalyticsReports,
  type Compared,
  type ComparedMoney,
  type ReportMeta,
  type Trend,
} from '@wayora/contracts';
import { Alert, Badge, Button, Field, Input, Select, cn, formatMoney } from '@wayora/ui';
import { ApiClientError } from '../../lib/api-client';
import { downloadReport, getReport } from '../../services/analytics';
import { useCan } from './AdminLayout';
import { Donut, FunnelChart, LineChart, type Line } from './charts';
import { formatCount, formatPercent, humanize } from './format';
import { adminKeys } from './keys';
import { ADMIN_PATHS } from './paths';
import { AdminPage, BarList, QueryView, Section, Stat, StatGrid, Table } from './ui';

/*
 * Analytics (Phase 31, docs/analytics.md). One page per report, sharing a
 * date filter kept in the URL (so a view can be shared and survives a
 * reload). Every figure comes from the server; demo and real are shown
 * apart and labelled; a figure that wasn't recorded says so instead of 0.
 */

const PRESET_LABEL: Record<AnalyticsPreset, string> = {
  today: 'Today',
  last_7_days: 'Last 7 days',
  last_30_days: 'Last 30 days',
  this_month: 'This month',
  last_month: 'Last month',
  custom: 'Custom range',
};

const REPORT_LABEL: Record<AnalyticsReport, string> = {
  overview: 'Overview',
  revenue: 'Revenue',
  funnel: 'Funnel',
  search: 'Search',
  customers: 'Customers',
  providers: 'Providers',
  marketing: 'Marketing',
  support: 'Support & reviews',
};

// ─── Query in the URL ───────────────────────────────────────────────────

export function useAnalyticsQuery(): AnalyticsQuery {
  const [params] = useSearchParams();
  const raw: Record<string, string> = {};
  for (const k of ['preset', 'from', 'to', 'granularity']) {
    const v = params.get(k);
    if (v) raw[k] = v;
  }
  const parsed = analyticsQuerySchema.safeParse(raw);
  return parsed.success ? parsed.data : { preset: 'last_30_days' };
}

function Filters() {
  const [params, setParams] = useSearchParams();
  const current = useAnalyticsQuery();
  return <FilterForm key={params.toString()} current={current} apply={setParams} />;
}

function FilterForm({
  current,
  apply,
}: {
  current: AnalyticsQuery;
  apply: (p: URLSearchParams) => void;
}) {
  const [preset, setPreset] = useState<AnalyticsPreset>(current.preset ?? 'last_30_days');
  const [from, setFrom] = useState(current.from ?? '');
  const [to, setTo] = useState(current.to ?? '');
  const [granularity, setGranularity] = useState<string>(current.granularity ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams({ preset });
    if (preset === 'custom') {
      if (from) next.set('from', from);
      if (to) next.set('to', to);
    }
    if (granularity) next.set('granularity', granularity);
    apply(next);
  };
  return (
    <form
      onSubmit={submit}
      aria-label="Reporting period"
      className="grid gap-3 rounded-xl border border-line bg-card p-4 shadow-xs sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-end"
    >
      <Field label="Period">
        <Select value={preset} onChange={(e) => setPreset(e.target.value as AnalyticsPreset)}>
          {ANALYTICS_PRESETS.map((p) => (
            <option key={p} value={p}>
              {PRESET_LABEL[p]}
            </option>
          ))}
        </Select>
      </Field>
      {preset === 'custom' ? (
        <>
          <Field label="From">
            <Input type="date" value={from} required onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To (inclusive)">
            <Input type="date" value={to} required onChange={(e) => setTo(e.target.value)} />
          </Field>
        </>
      ) : null}
      <Field label="Group by">
        <Select value={granularity} onChange={(e) => setGranularity(e.target.value)}>
          <option value="">Automatic</option>
          <option value="day">Day</option>
          <option value="week">Week (from Monday)</option>
          <option value="month">Month</option>
        </Select>
      </Field>
      <div>
        <Button type="submit">Apply</Button>
      </div>
    </form>
  );
}

function ReportTabs({ query }: { query: string }) {
  const financial = useCan('admin.analytics.financial');
  return (
    <nav aria-label="Reports" className="-mx-1 overflow-x-auto px-1">
      <ul className="flex gap-1">
        {analyticsReportSchema.options
          .filter((r) => r !== 'revenue' || financial)
          .map((r) => (
            <li key={r} className="shrink-0">
              <NavLink
                to={`${ADMIN_PATHS.analyticsReport(r)}${query}`}
                end
                className={({ isActive }) =>
                  cn(
                    'inline-flex min-h-11 items-center rounded-lg px-3 text-body-sm font-medium text-ink-secondary hover:bg-sunken hover:text-ink',
                    isActive && 'bg-brand-soft text-brand-ink',
                  )
                }
              >
                {REPORT_LABEL[r]}
              </NavLink>
            </li>
          ))}
      </ul>
    </nav>
  );
}

function ExportButton({ report, query }: { report: AnalyticsReport; query: AnalyticsQuery }) {
  const canExport = useCan('admin.analytics.export');
  const download = useMutation({ mutationFn: () => downloadReport(report, query) });
  if (!canExport) return null;
  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <Button variant="secondary" loading={download.isPending} onClick={() => download.mutate()}>
        <Download aria-hidden="true" />
        Download CSV
      </Button>
      {download.isError ? (
        <p role="alert" className="text-caption text-danger-ink">
          {download.error instanceof ApiClientError
            ? download.error.message
            : 'The download failed. Try again.'}
        </p>
      ) : null}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────

export function AnalyticsRoute() {
  const params = useParams();
  const parsed = analyticsReportSchema.safeParse(params.report ?? 'overview');
  const report: AnalyticsReport = parsed.success ? parsed.data : 'overview';
  const query = useAnalyticsQuery();
  const [search] = useSearchParams();
  const qs = search.toString() ? `?${search.toString()}` : '';
  const result = useQuery({
    queryKey: adminKeys.view('analytics', report, query),
    queryFn: ({ signal }) => getReport(report, query, signal),
  });
  return (
    <AdminPage
      title={`Analytics: ${REPORT_LABEL[report]}`}
      description="Figures computed from Wayora’s own records. Demo bookings and payments are simulated and always shown apart from real ones."
      actions={<ExportButton report={report} query={query} />}
    >
      <ReportTabs query={qs} />
      <Filters />
      <QueryView query={result} label={`the ${REPORT_LABEL[report].toLowerCase()} report`}>
        {(data) => (
          <div className="flex flex-col gap-5">
            <PeriodLine meta={data} />
            <ReportBody report={report} data={data} />
          </div>
        )}
      </QueryView>
    </AdminPage>
  );
}

function ReportBody({ report, data }: { report: AnalyticsReport; data: unknown }) {
  switch (report) {
    case 'overview':
      return <OverviewView o={data as AnalyticsReports['overview']} />;
    case 'revenue':
      return <RevenueView r={data as AnalyticsReports['revenue']} />;
    case 'funnel':
      return <FunnelView f={data as AnalyticsReports['funnel']} />;
    case 'search':
      return <SearchView s={data as AnalyticsReports['search']} />;
    case 'customers':
      return <CustomersView c={data as AnalyticsReports['customers']} />;
    case 'providers':
      return <ProvidersView p={data as AnalyticsReports['providers']} />;
    case 'marketing':
      return <MarketingView m={data as AnalyticsReports['marketing']} />;
    case 'support':
      return <SupportView s={data as AnalyticsReports['support']} />;
  }
}

// ─── Shared pieces ──────────────────────────────────────────────────────

const longDay = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const dayText = (d: string) => longDay.format(new Date(`${d}T00:00:00Z`));

function PeriodLine({ meta }: { meta: ReportMeta }) {
  const p = meta.period;
  return (
    <p className="text-body-sm text-ink-secondary">
      <span className="font-medium text-ink">
        {dayText(p.from)}
        {p.to !== p.from ? ` – ${dayText(p.to)}` : ''}
      </span>{' '}
      ({formatCount(p.days)} {p.days === 1 ? 'day' : 'days'}
      {p.partial ? ', to date' : ''}) · compared with {dayText(meta.previous.from)}
      {meta.previous.to !== meta.previous.from ? ` – ${dayText(meta.previous.to)}` : ''} · days in{' '}
      {meta.timezone} · grouped by {meta.granularity}
    </p>
  );
}

/** "+12.5% vs previous" / "Up from 0" / "No comparison". Never a percentage of zero. */
export function changeText(value: number | null, previous: number | null): string {
  if (value === null) return 'Not recorded';
  if (previous === null) return 'No comparison: not recorded then';
  if (previous === 0) return value === 0 ? 'Same as previous period' : 'Up from 0';
  const change = (value - previous) / previous;
  if (change === 0) return 'Same as previous period';
  const pct = new Intl.NumberFormat('en-IN', {
    style: 'percent',
    maximumFractionDigits: 1,
    signDisplay: 'always',
  }).format(change);
  return `${pct} vs previous period`;
}

function CountStat({ label, c, hint }: { label: string; c: Compared; hint?: ReactNode }) {
  return (
    <Stat
      label={label}
      value={c.value === null ? '—' : formatCount(c.value)}
      hint={
        <>
          {changeText(c.value, c.previous)}
          {hint ? <> · {hint}</> : null}
        </>
      }
    />
  );
}

const rateText = (r: { value: number | null }) => (r.value === null ? '—' : formatPercent(r.value));

function RateStat({ label, r, hint }: { label: string; r: AnalyticsRate; hint?: string }) {
  return (
    <Stat
      label={label}
      value={rateText(r)}
      hint={`${formatCount(r.numerator)} of ${formatCount(r.denominator)}${
        r.previous !== null ? ` · previously ${formatPercent(r.previous)}` : ''
      }${hint ? ` · ${hint}` : ''}`}
    />
  );
}

const money = (amountMinor: string, currency: string) => formatMoney(amountMinor, currency);

/** Axis labels for minor-unit amounts: "₹50K", "₹1.5M". */
export function compactMoney(currency: string) {
  const digits =
    new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  // "en", not "en-IN": browsers abbreviate thousands as "T" in en-IN.
  const f = new Intl.NumberFormat('en', {
    style: 'currency',
    currency,
    notation: 'compact',
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });
  return (minor: number) => f.format(minor / 10 ** digits);
}

function MoneyStat({ label, m }: { label: string; m: ComparedMoney }) {
  const value = Number(m.amountMinor);
  const prev = m.previousMinor === null ? null : Number(m.previousMinor);
  return (
    <Stat
      label={`${label} (${m.currency})`}
      value={money(m.amountMinor, m.currency)}
      hint={changeText(value, prev)}
    />
  );
}

function ModeBadge({ mode }: { mode: 'real' | 'demo' }) {
  return mode === 'demo' ? (
    <Badge tone="brand">Demo · simulated, not money</Badge>
  ) : (
    <Badge tone="neutral">Real</Badge>
  );
}

function Notes({ notes }: { notes: AnalyticsNote[] }) {
  if (notes.length === 0) return null;
  return (
    <Alert tone="info" title="How to read these figures">
      <ul className="flex flex-col gap-1">
        {notes.map((n) => (
          <li key={n.metric}>
            <span className="font-medium">{n.metric}:</span> {n.reason}
          </li>
        ))}
      </ul>
    </Alert>
  );
}

/** Lines for a trend: each series, and optionally its comparison line. */
function linesOf(t: Trend, keys: string[], compare: boolean): Line[] {
  const lines: Line[] = [];
  for (const key of keys) {
    const s = t.series.find((x) => x.key === key);
    if (!s) continue;
    lines.push({ label: s.label, points: s.points });
    if (compare) {
      const p = t.previous.find((x) => x.key === key);
      if (p)
        lines.push({
          label: `${s.label}, previous period`,
          points: t.buckets.map((_, i) => p.points[i] ?? null),
          previous: true,
        });
    }
  }
  return lines;
}

function TrendSection({
  title,
  trend,
  keys,
  description,
  format,
  tickFormat,
}: {
  title: string;
  trend: Trend;
  keys: string[];
  description?: ReactNode;
  format?: (n: number) => string;
  tickFormat?: (n: number) => string;
}) {
  const [compare, setCompare] = useState(keys.length === 1);
  return (
    <Section title={title} description={description}>
      <label className="mb-3 inline-flex min-h-11 items-center gap-2 text-body-sm text-ink-secondary">
        <input
          type="checkbox"
          className="size-4 accent-brand"
          checked={compare}
          onChange={(e) => setCompare(e.target.checked)}
        />
        Compare with the previous period
        <span className="sr-only"> ({title})</span>
      </label>
      <LineChart
        title={title}
        labels={trend.buckets.map((b) => b.label)}
        lines={linesOf(trend, keys, compare)}
        {...(format ? { format } : {})}
        {...(tickFormat ? { tickFormat } : {})}
      />
    </Section>
  );
}

// ─── Overview ───────────────────────────────────────────────────────────

function OverviewView({ o }: { o: AnalyticsReports['overview'] }) {
  return (
    <>
      <StatGrid>
        <Stat
          label="Customers"
          value={formatCount(o.users.total)}
          hint="Accounts at the end of the period"
        />
        <CountStat label="New customers" c={o.users.new} />
        <CountStat
          label="Active customers"
          c={o.users.active}
          hint={o.users.activeCoverage.complete ? 'Signed in or used Wayora' : 'Partly recorded'}
        />
        <CountStat
          label="Searches"
          c={o.searches.total}
          hint={`${formatCount(o.searches.requests)} requests`}
        />
        <RateStat label="Search → booking" r={o.conversion} hint="searches with a booking" />
        <CountStat label="Real bookings" c={o.bookings.created.real} />
        <CountStat label="Demo bookings" c={o.bookings.created.demo} hint="simulated" />
        <CountStat label="Supplier reservations confirmed" c={o.bookings.supplierConfirmed} />
      </StatGrid>
      <StatGrid>
        <Stat
          label="Cancelled bookings"
          value={`${formatCount(o.bookings.cancelled.real)} real`}
          hint={`${formatCount(o.bookings.cancelled.demo)} demo`}
        />
        <RateStat label="Payment success (real)" r={o.payments.successRate.real} />
        <RateStat label="Payment success (demo)" r={o.payments.successRate.demo} hint="simulated" />
      </StatGrid>
      {o.money ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {o.money.map((m) => (
            <Section key={m.mode} title={m.mode === 'real' ? 'Money (real)' : 'Money (demo)'}>
              <div className="mb-3">
                <ModeBadge mode={m.mode} />
              </div>
              {m.grossBookingValue.length + m.collected.length === 0 ? (
                <p className="text-body-sm text-ink-secondary">
                  {m.mode === 'real'
                    ? 'No real bookings were confirmed and no real payments succeeded in this period.'
                    : 'No demo bookings were confirmed in this period.'}
                </p>
              ) : (
                <dl className="grid gap-3 sm:grid-cols-2">
                  {m.grossBookingValue.map((x) => (
                    <MoneyStat key={`g${x.currency}`} label="Gross booking value" m={x} />
                  ))}
                  {m.collected.map((x) => (
                    <MoneyStat key={`c${x.currency}`} label="Payments succeeded" m={x} />
                  ))}
                  {m.refunded.map((x) => (
                    <MoneyStat key={`r${x.currency}`} label="Refunds completed" m={x} />
                  ))}
                  {m.averageBookingValue.map((x) => (
                    <MoneyStat key={`a${x.currency}`} label="Average booking value" m={x} />
                  ))}
                </dl>
              )}
            </Section>
          ))}
        </div>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-2">
        <TrendSection title="Searches" trend={o.trend} keys={['searches']} />
        <TrendSection
          title="Bookings created"
          trend={o.trend}
          keys={['bookings_real', 'bookings_demo']}
          description="Real and demo shown as separate lines; never added together."
        />
        <TrendSection title="New customers" trend={o.trend} keys={['new_users']} />
        <TrendSection
          title="Active customers"
          trend={o.trend}
          keys={['active_users']}
          description="Distinct customers in each period. Gaps: not recorded yet."
        />
      </div>
      <Notes notes={o.notes} />
    </>
  );
}

// ─── Revenue ────────────────────────────────────────────────────────────

function RevenueView({ r }: { r: AnalyticsReports['revenue'] }) {
  return (
    <>
      <Notes notes={r.notes} />
      {r.modes.map((m) => (
        <Section
          key={m.mode}
          title={m.mode === 'real' ? 'Real money' : 'Demo (simulated)'}
          description={
            m.mode === 'demo'
              ? 'Simulated bookings and payments: no money moved. Shown so the flow can be checked.'
              : 'Live payments and refunds only.'
          }
        >
          <div className="mb-3">
            <ModeBadge mode={m.mode} />
          </div>
          {m.lines.length === 0 ? (
            <p className="text-body-sm text-ink-secondary">Nothing in this period.</p>
          ) : (
            m.lines.map((l) => (
              <div key={l.currency} className="mb-4 last:mb-0">
                <h3 className="mb-2 text-label">{l.currency}</h3>
                <Table
                  label={`${m.mode} revenue in ${l.currency}`}
                  head={['Figure', 'This period', 'Previous period']}
                >
                  {(
                    [
                      ['Gross booking value', l.grossBookingValue],
                      ['Promotion discounts', l.promotionDiscount],
                      ['Coupon discounts', l.couponDiscount],
                      ['Points redeemed (value)', l.pointsRedeemed],
                      ['Travel credit used', l.travelCreditUsed],
                      ['Payments succeeded', l.paymentsSucceeded],
                      ['Refunds completed', l.refundsCompleted],
                      ['Net collected', l.netCollected],
                      ['Average booking value', l.averageBookingValue],
                    ] as const
                  ).map(([label, v]) => (
                    <tr key={label}>
                      <td>{label}</td>
                      <td className="tabular-nums">{money(v.amountMinor, v.currency)}</td>
                      <td className="tabular-nums">
                        {v.previousMinor === null ? '—' : money(v.previousMinor, v.currency)}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td>Confirmed bookings (with a fixed price)</td>
                    <td className="tabular-nums">{formatCount(l.confirmedBookings.value ?? 0)}</td>
                    <td className="tabular-nums">
                      {l.confirmedBookings.previous === null
                        ? '—'
                        : formatCount(l.confirmedBookings.previous)}
                    </td>
                  </tr>
                  <tr>
                    <td>Refunds pending (not deducted)</td>
                    <td className="tabular-nums">
                      {money(l.refundsPending.amountMinor, l.currency)} (
                      {formatCount(l.refundsPending.count)})
                    </td>
                    <td>—</td>
                  </tr>
                </Table>
                {l.unpricedBookings > 0 ? (
                  <p className="mt-2 text-caption text-ink-secondary">
                    {formatCount(l.unpricedBookings)} confirmed bookings had a fare range, not a
                    fixed price, and aren’t in booking value.
                  </p>
                ) : null}
              </div>
            ))
          )}
        </Section>
      ))}
      {r.trends.map((t) => (
        <TrendSection
          key={`${t.mode}${t.currency}`}
          title={`Payments and refunds, ${t.mode === 'demo' ? 'demo (simulated)' : 'real'}, ${t.currency}`}
          trend={t.trend}
          keys={['collected', 'refunded']}
          format={(n) => money(String(Math.round(n)), t.currency)}
          tickFormat={compactMoney(t.currency)}
        />
      ))}
    </>
  );
}

// ─── Funnel ─────────────────────────────────────────────────────────────

function FunnelView({ f }: { f: AnalyticsReports['funnel'] }) {
  return (
    <>
      <div className="flex flex-col gap-4">
        <Section
          title="From search to confirmed booking"
          description="Searches started in the period, followed to the furthest stage each reached."
        >
          <FunnelChart
            label="Funnel stages"
            stages={f.stages.map((s) => ({
              key: s.key,
              label: s.label,
              count: s.count,
              conversion: s.conversion,
              note: [
                s.observed !== s.count ? `${formatCount(s.observed)} recorded at this stage` : null,
                s.split
                  ? `${formatCount(s.split.real)} real · ${formatCount(s.split.demo)} demo`
                  : null,
                s.dropOff ? `${formatCount(s.dropOff)} went no further` : null,
              ]
                .filter(Boolean)
                .join(' · '),
            }))}
          />
        </Section>
        <Section title="By category" description="Searches reaching each stage.">
          {f.byCategory.length === 0 ? (
            <p className="text-body-sm text-ink-secondary">No searches in this period.</p>
          ) : (
            <Table
              label="Funnel by category"
              head={['Category', 'Searches', 'With results', 'Booked']}
            >
              {f.byCategory.map((c) => (
                <tr key={c.category}>
                  <td>{humanize(c.category)}</td>
                  <td className="tabular-nums">{formatCount(c.counts[0] ?? 0)}</td>
                  <td className="tabular-nums">{formatCount(c.counts[1] ?? 0)}</td>
                  <td className="tabular-nums">{formatCount(c.counts[5] ?? 0)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Section>
      </div>
      <TrendSection
        title="Searches and bookings by day of search"
        trend={f.trend}
        keys={['searches', 'with_results', 'booked']}
      />
      <Notes notes={f.notes} />
    </>
  );
}

// ─── Search ─────────────────────────────────────────────────────────────

const monthName = new Intl.DateTimeFormat('en-GB', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

function SearchView({ s }: { s: AnalyticsReports['search'] }) {
  const toRecord = <T,>(rows: T[], key: (r: T) => string, value: (r: T) => number) =>
    Object.fromEntries(rows.map((r) => [key(r), value(r)]));
  return (
    <>
      <StatGrid>
        <RateStat label="No results" r={s.noResultsRate} hint="of answered requests" />
        <RateStat label="Search → offer viewed" r={s.searchToOffer} />
        <RateStat label="Abandoned after results" r={s.abandonment} />
      </StatGrid>
      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="Searches by category">
          {s.byCategory.length === 0 ? (
            <p className="text-body-sm text-ink-secondary">No searches in this period.</p>
          ) : (
            <BarList
              label="Searches by category"
              items={toRecord(
                s.byCategory,
                (c) => c.category,
                (c) => c.searches,
              )}
            />
          )}
        </Section>
        <TrendSection title="Searches" trend={s.trend} keys={['searches', 'no_results']} />
        <Section
          title="Popular routes"
          description={`Only routes searched at least ${s.minimumCount} times are listed.`}
        >
          {s.routes.length === 0 ? (
            <p className="text-body-sm text-ink-secondary">No route reached the minimum yet.</p>
          ) : (
            <Table label="Popular routes" head={['Category', 'Route', 'Searches']}>
              {s.routes.map((r) => (
                <tr key={`${r.category}${r.origin}${r.destination}`}>
                  <td>{humanize(r.category)}</td>
                  <td>
                    {r.originName ? `${r.originName} → ${r.destinationName}` : r.destinationName}
                  </td>
                  <td className="tabular-nums">{formatCount(r.searches)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Section>
        <Section title="When people plan to travel" description="Month of travel searched for.">
          {s.travelMonths.length === 0 ? (
            <p className="text-body-sm text-ink-secondary">No month reached the minimum yet.</p>
          ) : (
            <BarList
              label="Searches by month of travel"
              items={toRecord(
                s.travelMonths,
                (m) => monthName.format(new Date(`${m.month}-01T00:00:00Z`)),
                (m) => m.searches,
              )}
              format={(k) => k}
            />
          )}
        </Section>
        <Section title="Filters used" description="Requests using each filter (names only).">
          {s.filters.length === 0 ? (
            <p className="text-body-sm text-ink-secondary">No filters used in this period.</p>
          ) : (
            <BarList
              label="Filters used"
              items={toRecord(
                s.filters,
                (f) => f.filter,
                (f) => f.requests,
              )}
            />
          )}
        </Section>
        <Section title="Sort orders chosen" description="Other than each category’s default.">
          {s.sorts.length === 0 ? (
            <p className="text-body-sm text-ink-secondary">Only default sorting in this period.</p>
          ) : (
            <BarList
              label="Sort orders"
              items={toRecord(
                s.sorts,
                (x) => x.sort,
                (x) => x.requests,
              )}
            />
          )}
        </Section>
        <Section title="Most viewed destinations" description="Destination page views.">
          {s.destinationViews.length === 0 ? (
            <p className="text-body-sm text-ink-secondary">No destination page views recorded.</p>
          ) : (
            <BarList
              label="Destination page views"
              items={toRecord(
                s.destinationViews,
                (d) => d.name,
                (d) => d.views,
              )}
              format={(k) => k}
            />
          )}
        </Section>
      </div>
      <Notes notes={s.notes} />
    </>
  );
}

// ─── Customers ──────────────────────────────────────────────────────────

function CustomersView({ c }: { c: AnalyticsReports['customers'] }) {
  return (
    <>
      <StatGrid>
        <CountStat label="New registrations" c={c.registrations} />
        <CountStat label="Active customers" c={c.active} />
        <CountStat label="Returning customers" c={c.returning} hint="active, joined earlier" />
        {c.retention ? (
          <RateStat
            label="Retention"
            r={c.retention}
            hint="of last period’s active, active again"
          />
        ) : (
          <Stat label="Retention" value="—" hint="Not recorded for the previous period" />
        )}
      </StatGrid>
      <div className="grid gap-4 xl:grid-cols-2">
        {c.booking.map((b) => (
          <Section
            key={b.mode}
            title={b.mode === 'real' ? 'Booking customers (real)' : 'Booking customers (demo)'}
          >
            <div className="mb-3">
              <ModeBadge mode={b.mode} />
            </div>
            <dl className="grid gap-3 sm:grid-cols-3">
              <CountStat label="With a confirmed booking" c={b.customers} />
              <RateStat label="Repeat customers" r={b.repeat} />
              <Stat
                label="Bookings per customer"
                value={b.frequency === null ? '—' : b.frequency.toFixed(2)}
              />
            </dl>
          </Section>
        ))}
        <TrendSection
          title="New and active customers"
          trend={c.trend}
          keys={['registrations', 'active']}
        />
        <Section title="Loyalty tiers" description="Current tier of each loyalty account.">
          {(['real', 'demo'] as const).map((mode) => {
            const parts = c.tiers.filter((t) => t.mode === mode);
            return (
              <div key={mode} className="mb-4 flex flex-col gap-2 last:mb-0">
                <ModeBadge mode={mode} />
                <Donut
                  label={`${mode} loyalty tiers`}
                  parts={parts.map((t) => ({ label: humanize(t.tier), value: t.accounts }))}
                />
              </div>
            );
          })}
        </Section>
        <Section
          title="Rewards engagement"
          description="Customers who earned or used rewards in the period."
        >
          <Table
            label="Rewards engagement"
            head={['Mode', 'Earned points', 'Used points or credit', 'Accounts']}
          >
            {c.rewards.map((r) => (
              <tr key={r.mode}>
                <td>{r.mode === 'demo' ? 'Demo' : 'Real'}</td>
                <td className="tabular-nums">{formatCount(r.earners)}</td>
                <td className="tabular-nums">{formatCount(r.redeemers)}</td>
                <td className="tabular-nums">{formatCount(r.accounts)}</td>
              </tr>
            ))}
          </Table>
        </Section>
      </div>
      <Notes notes={c.notes} />
    </>
  );
}

// ─── Providers ──────────────────────────────────────────────────────────

const KIND_LABEL = { live: 'Live', demo: 'Demo', unknown: 'No longer registered' } as const;

function ProvidersView({ p }: { p: AnalyticsReports['providers'] }) {
  return (
    <>
      <Section title="Search providers" description="Calls made by searches in the period.">
        {p.search.length === 0 ? (
          <p className="text-body-sm text-ink-secondary">No provider calls in this period.</p>
        ) : (
          <Table
            label="Search providers"
            head={[
              'Provider',
              'Kind',
              'Calls',
              'Answered',
              'Timed out',
              'Average',
              '95th percentile',
            ]}
          >
            {p.search.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>
                  <Badge tone={s.kind === 'live' ? 'success' : 'neutral'}>
                    {KIND_LABEL[s.kind]}
                  </Badge>
                </td>
                <td className="tabular-nums">
                  {formatCount(s.calls.value ?? 0)}
                  <span className="block text-caption text-ink-secondary">
                    {changeText(s.calls.value, s.calls.previous)}
                  </span>
                </td>
                <td className="tabular-nums">{rateText(s.answerRate)}</td>
                <td className="tabular-nums">{rateText(s.timeoutRate)}</td>
                <td className="tabular-nums">
                  {s.averageMs === null ? '—' : `${formatCount(s.averageMs)} ms`}
                </td>
                <td className="tabular-nums">
                  {s.p95Ms === null ? '—' : `${formatCount(s.p95Ms)} ms`}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
      <Section
        title="Supplier reservations"
        description="Started in the period, by their state now."
      >
        {p.reservations.length === 0 ? (
          <p className="text-body-sm text-ink-secondary">
            No supplier reservations in this period. Demo bookings don’t reserve anything.
          </p>
        ) : (
          <Table
            label="Supplier reservations"
            head={['Provider', 'Started', 'Success rate', 'States', 'Errors']}
          >
            {p.reservations.map((r) => (
              <tr key={r.provider}>
                <td>{r.provider}</td>
                <td className="tabular-nums">{formatCount(r.started)}</td>
                <td className="tabular-nums">{rateText(r.successRate)}</td>
                <td>
                  {Object.entries(r.byStatus)
                    .map(([k, v]) => `${humanize(k)} ${formatCount(v)}`)
                    .join(' · ')}
                </td>
                <td>
                  {Object.entries(r.errorCategories)
                    .map(([k, v]) => `${humanize(k)} ${formatCount(v)}`)
                    .join(' · ') || '—'}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
      <Notes notes={p.notes} />
    </>
  );
}

// ─── Marketing ──────────────────────────────────────────────────────────

const amountsText = (list: { currency: string; amountMinor: string }[]) =>
  list.length === 0 ? '—' : list.map((a) => money(a.amountMinor, a.currency)).join(' · ');

function MarketingView({ m }: { m: AnalyticsReports['marketing'] }) {
  return (
    <>
      <StatGrid>
        <CountStat label="Promoted bookings (real)" c={m.promotedBookings.real} />
        <CountStat label="Promoted bookings (demo)" c={m.promotedBookings.demo} hint="simulated" />
        <RateStat label="Coupon applied → paid" r={m.couponConversion} />
      </StatGrid>
      <Section
        title="Promotions"
        description="Live promotions, and any other promotion used in the period."
      >
        {m.promotions.length === 0 ? (
          <p className="text-body-sm text-ink-secondary">
            No live or used promotions in this period.
          </p>
        ) : (
          <Table
            label="Promotions"
            head={[
              'Promotion',
              'Applied',
              'Redeemed (real · demo)',
              'Released',
              'Discount (real)',
              'Discount (demo)',
            ]}
          >
            {m.promotions.map((p) => (
              <tr key={p.id}>
                <td>
                  {p.name}
                  {p.code ? <span className="ml-1 font-mono text-caption">{p.code}</span> : null}
                  <span className="block text-caption text-ink-secondary">
                    {p.kind === 'coupon' ? 'Coupon' : 'Automatic'} · {p.live ? 'live' : 'not live'}
                  </span>
                </td>
                <td className="tabular-nums">{formatCount(p.applied)}</td>
                <td className="tabular-nums">
                  {formatCount(p.redeemed.real)} · {formatCount(p.redeemed.demo)}
                </td>
                <td className="tabular-nums">{formatCount(p.released)}</td>
                <td className="tabular-nums">{amountsText(p.discount.real)}</td>
                <td className="tabular-nums">{amountsText(p.discount.demo)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
      <Section
        title="Loyalty points and travel credit"
        description="Earned and issued are not the same as used."
      >
        <Table
          label="Loyalty"
          head={[
            'Mode',
            'Points earned',
            'Points redeemed',
            'Points expired',
            'Credit issued',
            'Credit used',
            'Credit expired',
          ]}
        >
          {m.loyalty.map((l) => (
            <tr key={l.mode}>
              <td>{l.mode === 'demo' ? 'Demo' : 'Real'}</td>
              <td className="tabular-nums">{formatCount(Number(l.pointsEarned))}</td>
              <td className="tabular-nums">{formatCount(Number(l.pointsRedeemed))}</td>
              <td className="tabular-nums">{formatCount(Number(l.pointsExpired))}</td>
              <td className="tabular-nums">{amountsText(l.creditIssued)}</td>
              <td className="tabular-nums">{amountsText(l.creditUsed)}</td>
              <td className="tabular-nums">{amountsText(l.creditExpired)}</td>
            </tr>
          ))}
        </Table>
      </Section>
      <Notes notes={m.notes} />
    </>
  );
}

// ─── Support and reviews ────────────────────────────────────────────────

const minutesText = (m: number | null) => {
  if (m === null) return '—';
  if (m < 60) return `${formatCount(m)} min`;
  if (m < 48 * 60) return `${(m / 60).toFixed(1)} h`;
  return `${(m / 1440).toFixed(1)} days`;
};

function SupportView({ s }: { s: AnalyticsReports['support'] }) {
  const t = s.tickets;
  const r = s.reviews;
  return (
    <>
      {t ? (
        <>
          <StatGrid>
            <CountStat label="Tickets opened" c={t.created} />
            <CountStat label="Tickets resolved" c={t.resolved} />
            <Stat
              label="Open now"
              value={formatCount(t.openNow)}
              hint={`${formatCount(t.escalated)} escalated in the period`}
            />
            <Stat
              label="First response"
              value={minutesText(t.firstResponse.medianMinutes)}
              hint={`median · average ${minutesText(t.firstResponse.averageMinutes)} · ${formatCount(t.firstResponse.count)} tickets`}
            />
            <Stat
              label="Resolution"
              value={minutesText(t.resolution.medianMinutes)}
              hint={`median · average ${minutesText(t.resolution.averageMinutes)} · ${formatCount(t.resolution.count)} tickets`}
            />
          </StatGrid>
          <div className="grid gap-4 xl:grid-cols-2">
            <Section title="Tickets by category">
              {t.byCategory.length === 0 ? (
                <p className="text-body-sm text-ink-secondary">No tickets in this period.</p>
              ) : (
                <BarList
                  label="Tickets by category"
                  items={Object.fromEntries(t.byCategory.map((c) => [c.category, c.created]))}
                />
              )}
            </Section>
            <Section title="Open tickets per agent">
              {t.workload.length === 0 ? (
                <p className="text-body-sm text-ink-secondary">No assigned open tickets.</p>
              ) : (
                <BarList
                  label="Open tickets per agent"
                  items={Object.fromEntries(t.workload.map((w) => [w.name, w.active]))}
                  format={(k) => k}
                />
              )}
            </Section>
          </div>
        </>
      ) : null}
      {r ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <Section title="Reviews">
            <dl className="grid gap-3 sm:grid-cols-2">
              <CountStat label="Submitted" c={r.submitted} />
              <Stat
                label="Average published rating"
                value={
                  r.averagePublishedRating.value === null
                    ? '—'
                    : `${r.averagePublishedRating.value.toFixed(2)} / 5`
                }
                hint={`${formatCount(r.publishedInPeriod)} published in the period${
                  r.averagePublishedRating.previous !== null
                    ? ` · previously ${r.averagePublishedRating.previous.toFixed(2)}`
                    : ''
                }`}
              />
              <Stat label="Awaiting moderation" value={formatCount(r.pendingNow)} hint="now" />
              <Stat
                label="Flagged"
                value={formatCount(r.flaggedNow)}
                hint={`${formatCount(r.openReportsNow)} open reports now`}
              />
            </dl>
          </Section>
          <Section title="Submitted reviews by verification">
            <Donut
              label="Reviews by verification"
              parts={Object.entries(r.byVerification).map(([k, v]) => ({
                label: humanize(k),
                value: v,
              }))}
            />
          </Section>
        </div>
      ) : null}
      {s.trend.series.length > 0 ? (
        <TrendSection
          title="Tickets and reviews"
          trend={s.trend}
          keys={s.trend.series.map((x) => x.key)}
        />
      ) : null}
      <Notes notes={s.notes} />
    </>
  );
}
