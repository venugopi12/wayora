import type { UseQueryResult } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Info, RotateCw, SearchX } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { adminRangeSchema, type AdminRange, type Money, type Pagination } from '@wayora/contracts';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  Skeleton,
  cn,
  formatMoney,
  type BadgeTone,
} from '@wayora/ui';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { ApiClientError } from '../../lib/api-client';
import { AccessDenied, isForbidden } from './AdminLayout';
import { RANGE_LABEL, formatCount, humanize, statusTone } from './format';

// ─── Page frame ─────────────────────────────────────────────────────────

export function AdminPage({
  title,
  description,
  actions,
  back,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
  children: ReactNode;
}) {
  useDocumentTitle(`${title} · Admin`);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        {back ? (
          <Link
            to={back.to}
            className="inline-flex min-h-11 w-fit items-center gap-1 rounded-md text-body-sm text-ink-secondary hover:text-ink"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
            {back.label}
          </Link>
        ) : null}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex max-w-3xl min-w-0 flex-col gap-1.5">
            <h1 className="text-heading-2 break-words">{title}</h1>
            {description ? <p className="text-body-sm text-ink-secondary">{description}</p> : null}
          </div>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </div>
      </div>
      {children}
    </div>
  );
}

export function Section({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = `section-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <section
      aria-labelledby={id}
      className={cn(
        'min-w-0 rounded-xl border border-line bg-card p-4 shadow-xs sm:p-5',
        className,
      )}
    >
      <div className="mb-4 flex flex-col gap-0.5">
        <h2 id={id} className="text-title">
          {title}
        </h2>
        {description ? <p className="text-body-sm text-ink-secondary">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

// ─── Loading, errors, "no access" ───────────────────────────────────────

/**
 * Renders a query's states consistently: skeleton while loading, "no access"
 * when the server refuses (403), not-found, other errors with a retry, then
 * the content.
 */
export function QueryView<T>({
  query,
  label,
  notFound,
  children,
}: {
  query: UseQueryResult<T>;
  /** "users", "this booking" … for messages. */
  label: string;
  notFound?: string;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) {
    return (
      <div role="status" aria-label={`Loading ${label}`} className="flex flex-col gap-3">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    );
  }
  if (query.isError) {
    if (isForbidden(query.error)) return <AccessDenied />;
    const error = query.error instanceof ApiClientError ? query.error : null;
    if (error?.code === 'NOT_FOUND' && notFound) {
      return (
        <div className="rounded-xl border border-dashed border-line-strong bg-card">
          <EmptyState size="page" icon={<SearchX />} title={notFound} />
        </div>
      );
    }
    if (error?.code === 'VALIDATION_FAILED') {
      return (
        <Alert tone="warning" title="Those filters aren’t valid">
          {error.details[0]?.message ?? 'Check the filters and try again.'}
        </Alert>
      );
    }
    return (
      <ErrorState
        title={`We couldn’t load ${label}`}
        description="Check your connection, then try again."
        reference={error?.requestId ?? undefined}
        action={
          <Button
            variant="secondary"
            onClick={() => void query.refetch()}
            loading={query.isFetching}
          >
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
        }
      />
    );
  }
  return <>{children(query.data)}</>;
}

// ─── Figures ────────────────────────────────────────────────────────────

export function StatGrid({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">{children}</dl>;
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-line bg-card p-4 shadow-xs">
      <dt className="text-caption font-medium text-ink-secondary">{label}</dt>
      <dd className="text-heading-3 tabular-nums">{value}</dd>
      {hint ? <dd className="text-caption text-ink-secondary">{hint}</dd> : null}
    </div>
  );
}

/**
 * Counts as labelled horizontal bars. The numbers are text (the bars are
 * decoration), so the list reads the same to everyone.
 */
export function BarList({
  label,
  items,
  format = humanize,
}: {
  label: string;
  items: Record<string, number>;
  format?: (key: string) => string;
}) {
  const entries = Object.entries(items);
  const max = Math.max(1, ...entries.map(([, n]) => n));
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  return (
    <ul aria-label={label} className="flex flex-col gap-2.5">
      {entries.map(([key, n]) => (
        <li key={key} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3 text-body-sm">
            <span className="truncate">{format(key)}</span>
            <span className="tabular-nums text-ink-secondary">
              {formatCount(n)}
              {total > 0 ? <span className="sr-only"> of {formatCount(total)}</span> : null}
            </span>
          </div>
          <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-sunken">
            <div
              className={cn('h-full rounded-full', n === 0 ? 'bg-transparent' : 'bg-brand')}
              style={{ width: `${(n / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function StatusBadge({ status, tone }: { status: string; tone?: BadgeTone }) {
  return <Badge tone={tone ?? statusTone(status)}>{humanize(status)}</Badge>;
}

export function DemoBadge({ demo }: { demo: boolean }) {
  return demo ? <Badge tone="brand">Demo</Badge> : <Badge tone="neutral">Live</Badge>;
}

export const money = (m: Money | null) => (m ? formatMoney(m.amountMinor, m.currency) : '—');

export function Unavailable({ items }: { items: { metric: string; reason: string }[] }) {
  if (items.length === 0) return null;
  return (
    <Alert tone="info" title="Not available">
      <ul className="flex flex-col gap-1">
        {items.map((u) => (
          <li key={u.metric}>
            <span className="font-medium">{u.metric}:</span> {u.reason}
          </li>
        ))}
      </ul>
    </Alert>
  );
}

export function DetailList({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[minmax(9rem,auto)_1fr]">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-body-sm text-ink-secondary">{k}</dt>
          <dd className="min-w-0 text-body-sm break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2 text-caption text-ink-secondary">
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

// ─── Tables ─────────────────────────────────────────────────────────────

/**
 * A data table. On narrow screens it scrolls sideways inside its own
 * keyboard-focusable region; the page itself never scrolls sideways.
 */
export function Table({
  label,
  head,
  children,
}: {
  label: string;
  head: string[];
  children: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={`${label} table`}
      tabIndex={0}
      className="overflow-x-auto rounded-xl border border-line bg-card shadow-xs focus-visible:outline-2"
    >
      <table className="w-full min-w-[40rem] border-collapse text-left text-body-sm">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr className="border-b border-line bg-sunken/60">
            {head.map((h) => (
              <th
                key={h}
                scope="col"
                className="px-4 py-2.5 text-caption font-semibold text-ink-secondary"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr]:border-b [&>tr]:border-line [&>tr:last-child]:border-0 [&_td]:px-4 [&_td]:py-3 [&_td]:align-top">
          {children}
        </tbody>
      </table>
    </div>
  );
}

export function EmptyRows({ what }: { what: string }) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-card">
      <EmptyState
        icon={<SearchX />}
        title={`No ${what} match`}
        description="Try different filters."
      />
    </div>
  );
}

export function Pager({ pagination, label }: { pagination: Pagination; label: string }) {
  const [params, setParams] = useSearchParams();
  const { page, totalPages, totalResults } = pagination;
  const go = (next: number) => {
    const copy = new URLSearchParams(params);
    if (next === 1) copy.delete('page');
    else copy.set('page', String(next));
    setParams(copy);
  };
  return (
    <nav
      aria-label={`${label} pages`}
      className="flex flex-wrap items-center justify-between gap-3"
    >
      <p className="text-body-sm text-ink-secondary" aria-live="polite">
        {formatCount(totalResults)} {totalResults === 1 ? 'result' : 'results'}
        {totalPages > 1 ? ` · page ${page} of ${totalPages}` : ''}
      </p>
      {totalPages > 1 ? (
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => go(page - 1)}>
            <ChevronLeft aria-hidden="true" />
            Previous
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => go(page + 1)}
          >
            Next
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </nav>
  );
}

// ─── Filters (kept in the URL, so views can be shared and survive reloads) ─

export type FilterSpec =
  | { name: string; label: string; kind: 'text'; placeholder?: string }
  | { name: string; label: string; kind: 'date' }
  | { name: string; label: string; kind: 'select'; options: { value: string; label: string }[] };

/** The URL's filter values plus `page` (1 when absent or invalid). */
export function useFilters(names: string[]) {
  const [params] = useSearchParams();
  const values: Record<string, string | undefined> = {};
  for (const name of names) {
    const v = params.get(name);
    if (v) values[name] = v;
  }
  const pageParam = Number(params.get('page') ?? '1');
  const page = Number.isInteger(pageParam) && pageParam >= 1 && pageParam <= 1000 ? pageParam : 1;
  return { values, page };
}

export function FilterBar({ label, specs }: { label: string; specs: FilterSpec[] }) {
  const [params] = useSearchParams();
  // Remounts when the URL changes (back/forward, links), so the form shows what the URL says.
  return <FilterForm key={params.toString()} label={label} specs={specs} />;
}

function FilterForm({ label, specs }: { label: string; specs: FilterSpec[] }) {
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(specs.map((s) => [s.name, params.get(s.name) ?? ''])),
  );

  const apply = (event: FormEvent) => {
    event.preventDefault();
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(draft)) if (v.trim()) next.set(k, v.trim());
    setParams(next);
  };
  const active = specs.some((s) => params.get(s.name));
  return (
    <form
      role="search"
      aria-label={label}
      onSubmit={apply}
      className="grid gap-3 rounded-xl border border-line bg-card p-4 shadow-xs sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] lg:items-end"
    >
      {specs.map((spec) => (
        <Field key={spec.name} label={spec.label}>
          {spec.kind === 'select' ? (
            <Select
              value={draft[spec.name] ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, [spec.name]: e.target.value }))}
            >
              <option value="">Any</option>
              {spec.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              type={spec.kind === 'date' ? 'date' : 'search'}
              value={draft[spec.name] ?? ''}
              placeholder={spec.kind === 'text' ? spec.placeholder : undefined}
              maxLength={100}
              onChange={(e) => setDraft((d) => ({ ...d, [spec.name]: e.target.value }))}
            />
          )}
        </Field>
      ))}
      <div className="flex gap-2 sm:col-span-2 lg:col-span-1">
        <Button type="submit">Apply</Button>
        {active ? (
          <Button type="button" variant="ghost" onClick={() => setParams(new URLSearchParams())}>
            Clear
          </Button>
        ) : null}
      </div>
    </form>
  );
}

// ─── Time range ─────────────────────────────────────────────────────────

export function useRange(): AdminRange {
  const [params] = useSearchParams();
  const parsed = adminRangeSchema.safeParse(params.get('range'));
  return parsed.success ? parsed.data : '7d';
}

export function RangePicker() {
  const range = useRange();
  const [params, setParams] = useSearchParams();
  return (
    <Field label="Time range">
      <Select
        value={range}
        onChange={(e) => {
          const next = new URLSearchParams(params);
          next.set('range', e.target.value);
          setParams(next);
        }}
      >
        {(Object.keys(RANGE_LABEL) as AdminRange[]).map((r) => (
          <option key={r} value={r}>
            {RANGE_LABEL[r]} (UTC)
          </option>
        ))}
      </Select>
    </Field>
  );
}
