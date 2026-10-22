import type { BadgeTone } from '@wayora/ui';
import type { BookingStatus, BookingSummary } from '@wayora/contracts';
import { bookingRequirementsFor } from '@wayora/contracts';

const dayFormat = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const dateTimeFormat = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** A local travel date (YYYY-MM-DD), shown as written: "Tue, 10 Nov 2026". */
export const formatDay = (isoDate: string) => dayFormat.format(new Date(`${isoDate}T00:00:00Z`));

export const formatMoment = (iso: string) => dateTimeFormat.format(new Date(iso));

/** "Tue, 10 Nov 2026", "Tue, 10 Nov – Fri, 13 Nov 2026", or the metro wording. */
export function travelDates(booking: Pick<BookingSummary, 'startsOn' | 'endsOn'>): string {
  const { startsOn, endsOn } = booking;
  if (!startsOn) return 'No travel date (metro demo tickets have none)';
  if (!endsOn || endsOn === startsOn) return formatDay(startsOn);
  return `${formatDay(startsOn)} – ${formatDay(endsOn)}`;
}

export function partyText(booking: Pick<BookingSummary, 'offer' | 'partySize'>): string {
  const { one, many } = bookingRequirementsFor(booking.offer).partyNoun;
  return `${booking.partySize} ${booking.partySize === 1 ? one : many}`;
}

/** Status wording: "confirmed" is always qualified as a demo. */
export const STATUS_LABEL: Record<BookingStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Pending (demo)', tone: 'warning' },
  confirmed: { label: 'Demo confirmed', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
};
