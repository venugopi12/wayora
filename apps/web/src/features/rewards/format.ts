import type { Money, RewardTransaction, TravelCredit } from '@wayora/contracts';
import { formatMoney } from '@wayora/ui';

/** "₹1,234.50" from exact minor units (never a float). */
export const money = (m: Money) => formatMoney(m.amountMinor, m.currency);

export const points = (n: number) => `${new Intl.NumberFormat('en-IN').format(n)} pts`;

/** "×1.25" from basis points. */
export const multiplier = (bps: number) => `×${(bps / 10_000).toString()}`;

/** "50%" from basis points. */
export const percent = (bps: number) => `${(bps / 100).toString()}%`;

const dateFormat = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
export const formatDay = (iso: string) =>
  dateFormat.format(new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso));

const monthFormat = new Intl.DateTimeFormat('en-IN', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
export const formatMonth = (yyyyMm: string) =>
  monthFormat.format(new Date(`${yyyyMm}-01T00:00:00Z`));

export const TRANSACTION_LABEL: Record<RewardTransaction['type'], string> = {
  points_earned: 'Points earned',
  points_redeemed: 'Points used',
  points_restored: 'Points given back',
  points_reversed: 'Points taken back',
  points_expired: 'Points expired',
  points_adjusted: 'Points adjusted',
  credit_issued: 'Credit issued',
  credit_redeemed: 'Credit used',
  credit_restored: 'Credit given back',
  credit_expired: 'Credit expired',
  credit_revoked: 'Credit withdrawn',
};

export const CREDIT_REASON: Record<TravelCredit['reason'], string> = {
  promotion: 'Promotion',
  support_compensation: 'From Wayora support',
  booking_adjustment: 'Booking adjustment',
};

export const CREDIT_STATUS: Record<TravelCredit['status'], string> = {
  active: 'Available',
  used: 'Used',
  expired: 'Expired',
  revoked: 'Withdrawn',
};

export const CATEGORY_NAME: Record<string, string> = {
  flights: 'Flights',
  hotels: 'Hotels',
  trains: 'Trains',
  buses: 'Buses',
  metro: 'Metro',
  cabs: 'Cabs',
  holidays: 'Holidays',
};
