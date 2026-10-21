/**
 * Exact money formatting from integer minor units (no floating point).
 * Mirrors the `moneySchema` contract: amountMinor is an integer string.
 */
export type MinorAmount = string | number | bigint;

export function currencyFractionDigits(currency: string, locale = 'en-IN'): number {
  return (
    new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/** Converts minor units to an exact decimal string, e.g. (149950n, 2) → "1499.50". */
export function minorToDecimalString(amountMinor: MinorAmount, digits: number): string {
  const value = BigInt(amountMinor);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  if (digits === 0) return `${negative ? '-' : ''}${abs}`;
  const factor = 10n ** BigInt(digits);
  const whole = abs / factor;
  const fraction = (abs % factor).toString().padStart(digits, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export interface FormatMoneyOptions {
  locale?: string;
  /** `auto` drops ".00" on whole amounts (typical for travel prices). */
  minorDigits?: 'auto' | 'always' | 'never';
}

export function formatMoneyParts(
  amountMinor: MinorAmount,
  currency: string,
  { locale = 'en-IN', minorDigits = 'auto' }: FormatMoneyOptions = {},
): Intl.NumberFormatPart[] {
  const digits = currencyFractionDigits(currency, locale);
  const decimal = minorToDecimalString(amountMinor, digits);
  const isWhole = digits === 0 || /\.0+$/.test(decimal);
  const showMinor = minorDigits === 'always' || (minorDigits === 'auto' && !isWhole);
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: showMinor ? digits : 0,
    maximumFractionDigits: showMinor ? digits : 0,
    roundingMode: 'trunc',
  } as Intl.NumberFormatOptions);
  // Intl formats decimal strings exactly (no Number conversion) in modern engines.
  return formatter.formatToParts(decimal as unknown as number);
}

export function formatMoney(
  amountMinor: MinorAmount,
  currency: string,
  options?: FormatMoneyOptions,
): string {
  return formatMoneyParts(amountMinor, currency, options)
    .map((p) => p.value)
    .join('');
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function formatDurationLong(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const parts = [
    h ? `${h} hour${h === 1 ? '' : 's'}` : '',
    m ? `${m} minute${m === 1 ? '' : 's'}` : '',
  ];
  return parts.filter(Boolean).join(' ') || '0 minutes';
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
