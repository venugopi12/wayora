import { z } from 'zod';

/** ISO 4217 alphabetic currency code, e.g. `INR`, `USD`. */
export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter uppercase ISO 4217 code');
export type CurrencyCode = z.infer<typeof currencyCodeSchema>;

/**
 * Money crosses the wire as an integer amount of the currency's minor unit
 * (paise for INR, cents for USD) encoded as a **string**, so values above
 * Number.MAX_SAFE_INTEGER survive JSON and nobody does float arithmetic.
 *
 * Example: ₹1,499.50 → `{ "amountMinor": "149950", "currency": "INR" }`
 */
export const moneySchema = z.object({
  amountMinor: z
    .string()
    .regex(/^-?(0|[1-9]\d*)$/, 'amountMinor must be an integer string in minor units'),
  currency: currencyCodeSchema,
});
export type Money = z.infer<typeof moneySchema>;

/** Converts a validated Money value to a BigInt for exact arithmetic. */
export function toMinorUnits(money: Money): bigint {
  return BigInt(money.amountMinor);
}

/** Builds a Money value from exact minor units. */
export function fromMinorUnits(amountMinor: bigint, currency: CurrencyCode): Money {
  return { amountMinor: amountMinor.toString(), currency };
}

/** Adds two Money values of the same currency without precision loss. */
export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(`Cannot add ${a.currency} to ${b.currency}`);
  }
  return fromMinorUnits(toMinorUnits(a) + toMinorUnits(b), a.currency);
}
