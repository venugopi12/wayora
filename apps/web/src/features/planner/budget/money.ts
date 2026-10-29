import type { BudgetPerson } from '@wayora/contracts';
import { formatMoney } from '@wayora/ui';

/*
 * Display helpers for the budget pages (docs/planner.md#budget). Amounts are
 * integer minor units (strings) formatted exactly by @wayora/ui's formatMoney
 * — never converted to floating point, never converted between currencies.
 */

/** "₹1,499.50" — always with the currency's minor digits, so totals line up. */
export const money = (amountMinor: string | bigint, currency: string) =>
  formatMoney(amountMinor, currency, { minorDigits: 'always' });

/** Absolute value of a minor-unit string. */
export const abs = (amountMinor: string) =>
  amountMinor.startsWith('-') ? amountMinor.slice(1) : amountMinor;

/** Basis points as a percentage with two decimals, by integer arithmetic ("25.00%"). */
export function percent(basisPoints: number): string {
  const whole = Math.floor(basisPoints / 100);
  const fraction = String(basisPoints % 100).padStart(2, '0');
  return `${whole}.${fraction}%`;
}

/**
 * How a net balance reads. Sign convention (shown on the page): positive =
 * others owe this person; negative = this person owes others.
 */
export function balanceText(netMinor: string, currency: string, person: BudgetPerson): string {
  const value = BigInt(netMinor);
  const who = person.isYou ? 'You' : person.name;
  if (value === 0n) return `${who} ${person.isYou ? 'are' : 'is'} settled up`;
  return value > 0n
    ? `${who} ${person.isYou ? 'are' : 'is'} owed ${money(netMinor, currency)}`
    : `${who} ${person.isYou ? 'owe' : 'owes'} ${money(abs(netMinor), currency)}`;
}

export const nameOf = (people: Map<string, BudgetPerson>, id: string) => {
  const p = people.get(id);
  if (!p) return 'Someone';
  return p.isYou ? 'You' : p.name;
};

/** Bar width for a value against a limit, capped at 100% (text always says the real figure). */
export function barWidth(valueMinor: string, limitMinor: string | null): number {
  if (!limitMinor) return 0;
  const limit = BigInt(limitMinor);
  if (limit <= 0n) return 0;
  const bp = (BigInt(valueMinor) * 10_000n) / limit;
  return Number(bp > 10_000n ? 10_000n : bp) / 100;
}
