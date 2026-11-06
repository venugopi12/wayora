import type { Money, PromotionOffer } from '@wayora/contracts';
import { formatMoney } from '@wayora/ui';

/*
 * Wording for promotions, from the server's own figures (Phase 26). Nothing
 * here decides a discount; it only describes the rule as configured.
 */

export const money = (m: Money) => formatMoney(m.amountMinor, m.currency);

const CATEGORY: Record<string, string> = {
  flights: 'flights',
  hotels: 'hotels',
  trains: 'trains',
  buses: 'buses',
  metro: 'metro',
  cabs: 'cabs',
  holidays: 'holiday packages',
};

/** "10% off, up to ₹1,000" or "₹500 off". */
export function discountText(
  o: Pick<PromotionOffer, 'discountType' | 'percentBps' | 'amount' | 'maxDiscount'>,
): string {
  if (o.discountType === 'percentage') {
    const pct = `${(o.percentBps ?? 0) / 100}% off`;
    return o.maxDiscount ? `${pct}, up to ${money(o.maxDiscount)}` : pct;
  }
  return `${o.amount ? money(o.amount) : ''} off`;
}

/** "Hotels and flights" / "All travel". */
export function categoriesText(categories: readonly string[]): string {
  if (categories.length === 0) return 'All travel categories';
  const names = categories.map((c) => CATEGORY[c] ?? c);
  const text =
    names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const dayFormat = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
});
// The customer's own clock, like the payment page's "Pay by" (the hold ends with it).
const timeFormat = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

/** "Until 30 Nov 2026" (India time). */
export const validUntil = (iso: string) => `Until ${dayFormat.format(new Date(iso))}`;
export const formatTime = (iso: string) => timeFormat.format(new Date(iso));
export const formatDay = (iso: string) => dayFormat.format(new Date(iso));

/** The conditions as short phrases, from the offer's fields. */
export function conditions(o: PromotionOffer): string[] {
  return [
    categoriesText(o.categories),
    o.minAmount ? `Bookings of ${money(o.minAmount)} or more` : null,
    o.firstBookingOnly ? 'Your first confirmed booking only' : null,
    o.kind === 'automatic' ? 'Applied automatically at payment' : 'Enter the code at payment',
    o.stackable ? 'Combines with an automatic offer' : null,
  ].filter((x): x is string => x !== null);
}
