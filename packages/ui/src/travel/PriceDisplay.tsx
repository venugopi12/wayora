import { cn } from '../lib/cn';
import {
  formatMoney,
  formatMoneyParts,
  type FormatMoneyOptions,
  type MinorAmount,
} from '../lib/format';

export interface PriceDisplayProps extends FormatMoneyOptions {
  /** Integer amount in the currency's minor unit (paise, cents) — never a float. */
  amountMinor: MinorAmount;
  /** ISO 4217 code, e.g. "INR". */
  currency: string;
  /** Previous price, shown struck through (e.g. before a discount). */
  originalAmountMinor?: MinorAmount;
  /** Shown before the amount, e.g. "From". */
  prefix?: string;
  /** Unit after the amount, e.g. "per night", "per person". */
  suffix?: string;
  size?: 'sm' | 'md' | 'lg';
  /** Right-align (for price columns). */
  align?: 'start' | 'end';
  /** For deep-navy surfaces. */
  inverse?: boolean;
  className?: string;
}

const sizes = {
  sm: { amount: 'text-title font-bold', symbol: 'text-[0.8em]' },
  md: { amount: 'text-numeric', symbol: 'text-[0.72em]' },
  lg: { amount: 'text-numeric-lg', symbol: 'text-[0.62em]' },
} as const;

/**
 * Formats a price from exact minor units with tabular figures. The visible
 * layout is decorative; screen readers get one clear sentence.
 */
export function PriceDisplay({
  amountMinor,
  currency,
  originalAmountMinor,
  prefix,
  suffix,
  size = 'md',
  align = 'start',
  inverse = false,
  locale,
  minorDigits,
  className,
}: PriceDisplayProps) {
  const opts = { locale, minorDigits };
  const parts = formatMoneyParts(amountMinor, currency, opts);
  const full = formatMoney(amountMinor, currency, opts);
  const original =
    originalAmountMinor !== undefined
      ? formatMoney(originalAmountMinor, currency, opts)
      : undefined;
  const spoken = [prefix, full, suffix, original ? `, was ${original}` : '']
    .filter(Boolean)
    .join(' ')
    .replace(' ,', ',');
  const muted = inverse ? 'text-ink-inverse-secondary' : 'text-ink-secondary';

  return (
    <span
      className={cn(
        'inline-flex flex-col',
        align === 'end' ? 'items-end text-end' : 'items-start',
        className,
      )}
    >
      <span className="sr-only">{spoken}</span>
      <span aria-hidden="true" className="flex flex-wrap items-baseline gap-x-1.5">
        {prefix ? <span className={cn('text-body-sm', muted)}>{prefix}</span> : null}
        <span
          className={cn('numeric', sizes[size].amount, inverse ? 'text-ink-inverse' : 'text-ink')}
        >
          {parts.map((part, i) =>
            part.type === 'currency' ? (
              <span key={i} className={cn('font-semibold', sizes[size].symbol)}>
                {part.value}
              </span>
            ) : (
              <span key={i}>{part.value}</span>
            ),
          )}
        </span>
        {original ? <s className={cn('numeric text-body-sm', muted)}>{original}</s> : null}
      </span>
      {suffix ? (
        <span aria-hidden="true" className={cn('text-caption', muted)}>
          {suffix}
        </span>
      ) : null}
    </span>
  );
}
