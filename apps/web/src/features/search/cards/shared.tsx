import { ArrowRight, FlaskConical, Store } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { SearchPrice, SearchResult } from '@wayora/contracts';
import { Badge, cn, formatMoney, interaction } from '@wayora/ui';

/*
 * Building blocks shared by the category result cards (and the offer page).
 * Cards show only fields present in the result; nothing is filled in.
 */

/** "06:15" from "2026-11-12T06:15:00+05:30" (local time at the place). */
export const localTime = (dateTime: string) => dateTime.slice(11, 16);
export const localDate = (dateTime: string) => dateTime.slice(0, 10);

/** Calendar days between departure and arrival, in local dates ("+1"). */
export function dayOffset(departAt: string, arriveAt: string): number {
  return Math.round(
    (Date.parse(`${localDate(arriveAt)}T00:00:00Z`) -
      Date.parse(`${localDate(departAt)}T00:00:00Z`)) /
      86_400_000,
  );
}

export const money = (m: { amountMinor: string; currency: string }) =>
  formatMoney(m.amountMinor, m.currency);

export const UNIT_LABEL = {
  traveller: 'per traveller',
  adult: 'per adult',
  night: 'per night',
  passenger: 'per passenger',
} as const;

/**
 * Price with its basis. A range is an estimate, never a quote; demo prices
 * say so.
 */
export function PriceBlock({
  price,
  demo,
  align = 'end',
  size = 'md',
}: {
  price: SearchPrice | null;
  demo: boolean;
  align?: 'start' | 'end';
  size?: 'md' | 'lg';
}) {
  const box = cn(
    'flex flex-col gap-0.5',
    align === 'end' ? 'items-start sm:items-end sm:text-right' : 'items-start',
  );
  const amount = cn('numeric text-ink', size === 'lg' ? 'text-heading-2' : 'text-heading-3');
  if (!price) {
    return (
      <div className={box}>
        <p className="text-body-sm text-ink-secondary">No price in this result</p>
      </div>
    );
  }
  if (price.kind === 'range') {
    return (
      <div className={box}>
        <p className={amount}>
          {money(price.min)} – {money(price.max)}
        </p>
        <p className="text-caption text-ink-secondary">
          {demo ? 'Demo estimate, not a quote' : 'Estimate, not a quote'}
        </p>
      </div>
    );
  }
  return (
    <div className={box}>
      <p className={amount}>{money(price.total)}</p>
      <p className="text-caption text-ink-secondary">
        {demo ? 'Demo total' : 'Total'}
        {price.perUnit ? ` · ${money(price.perUnit.amount)} ${UNIT_LABEL[price.perUnit.unit]}` : ''}
      </p>
    </div>
  );
}

export function DemoBadge() {
  return (
    <Badge size="sm" tone="warning" icon={<FlaskConical />}>
      Demo data
    </Badge>
  );
}

/**
 * A result from a configured supplier (Phase 22, docs/providers.md). Plain
 * wording: no "live" pulse or supplier logo, and it says nothing about the
 * price being guaranteed or bookable.
 */
export function SupplierBadge() {
  return (
    <Badge size="sm" tone="neutral" icon={<Store />}>
      Supplier offer
    </Badge>
  );
}

/** Demo or supplier, as the result says; never assumed. */
export function SourceBadge({ source }: { source: SearchResult['source'] }) {
  return source === 'demo' ? <DemoBadge /> : <SupplierBadge />;
}

export function Chips({ items }: { items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Features">
      {items.map((item) => (
        <li key={item}>
          <Badge size="sm" tone="neutral">
            {item}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/**
 * Card frame: badges, heading, price, body, and a footer whose only action
 * is "View details" (a link to the offer page). There is no booking action:
 * only a demo booking can be made.
 */
export function ResultCardShell({
  result,
  heading,
  subheading,
  meta,
  body,
  href,
}: {
  result: SearchResult;
  heading: string;
  subheading?: ReactNode;
  meta?: ReactNode;
  body: ReactNode;
  href: string;
}) {
  const demo = result.source === 'demo';
  return (
    <article
      aria-label={heading}
      className="group/card relative flex flex-col gap-4 rounded-xl border border-line bg-card p-4 shadow-xs transition-[box-shadow,border-color] duration-(--duration-base) ease-standard focus-within:border-brand-300 hover:border-brand-200 hover:shadow-sm sm:p-5"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <SourceBadge source={result.source} />
            {meta}
          </div>
          <h3 className="text-title text-ink">{heading}</h3>
          {subheading ? <p className="text-body-sm text-ink-secondary">{subheading}</p> : null}
        </div>
        <PriceBlock price={result.price} demo={demo} />
      </div>
      {body}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <p className="text-caption text-ink-secondary">
          {demo
            ? 'Demo offer: demo booking only.'
            : 'Supplier price, may change. Can’t be booked on Wayora yet.'}
        </p>
        <Link
          to={href}
          className="group inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 text-body-sm font-semibold text-brand-ink hover:bg-brand-soft"
          aria-label={`View details: ${heading}`}
        >
          View details
          <ArrowRight aria-hidden="true" className={cn('size-4', interaction.iconNudge)} />
        </Link>
      </div>
    </article>
  );
}
