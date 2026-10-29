import { currencyCodeSchema, type Money } from '@wayora/contracts';

/*
 * Normalizing supplier values (docs/providers.md#normalization).
 *
 * Suppliers usually send amounts as decimal strings ("4520.50") or, less
 * safely, as JSON numbers. Wayora stores integer minor units. This converts
 * by string arithmetic only — never `Number * 100` — and refuses anything it
 * can't convert exactly: a malformed string, a float, more decimals than the
 * currency has, or an unknown currency. A refused amount means the offer is
 * dropped (and counted), never rounded or guessed.
 */

const KNOWN_CURRENCIES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('currency'));

/** Minor digits for an ISO 4217 currency (2 for INR/USD, 0 for JPY, 3 for KWD), or null. */
export function currencyDigits(currency: string): number | null {
  if (!currencyCodeSchema.safeParse(currency).success) return null;
  // Intl formats any well-formed code (even "XXQ"); only ISO currencies it knows count.
  if (!KNOWN_CURRENCIES.has(currency)) return null;
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? null
    );
  } catch {
    return null;
  }
}

/** A supplier amount as Money in minor units, or null when it can't be converted exactly. */
export function supplierMoney(value: unknown, currency: unknown): Money | null {
  if (typeof currency !== 'string') return null;
  const code = currency.trim().toUpperCase();
  const digits = currencyDigits(code);
  if (digits === null) return null;
  let text: string;
  if (typeof value === 'string') text = value.trim();
  else if (typeof value === 'number' && Number.isSafeInteger(value)) text = String(value);
  else return null; // floats can't be trusted to be exact
  const match = /^(0|[1-9]\d{0,15})(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? '';
  if (fraction.length > digits) {
    // Only trailing zeros may be dropped: "12.50" in a 1-digit currency is fine, "12.55" isn't.
    if (!/^0*$/.test(fraction.slice(digits))) return null;
  }
  const minor =
    BigInt(match[1]!) * 10n ** BigInt(digits) +
    BigInt((fraction.slice(0, digits) || '0').padEnd(digits, '0') || '0');
  return { amountMinor: minor.toString(), currency: code };
}
