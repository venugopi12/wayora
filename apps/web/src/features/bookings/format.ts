import type { BadgeTone } from '@wayora/ui';
import type {
  BookingStatus,
  BookingSummary,
  PaymentStatus,
  RefundState,
  ReservationState,
} from '@wayora/contracts';
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
  expired: { label: 'Expired (not paid)', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
};

/** A supplier reservation's state (Phase 23): never "confirmed" until the supplier says so. */
export const RESERVATION_LABEL: Record<ReservationState, { label: string; tone: BadgeTone }> = {
  requested: { label: 'Sending to the supplier', tone: 'warning' },
  'in-progress': { label: 'Awaiting the supplier', tone: 'warning' },
  confirmed: { label: 'Confirmed by the supplier', tone: 'success' },
  failed: { label: 'Not reserved', tone: 'danger' },
  unknown: { label: 'Checking with the supplier', tone: 'warning' },
  'cancellation-pending': { label: 'Cancellation requested', tone: 'warning' },
  cancelled: { label: 'Cancelled by the supplier', tone: 'neutral' },
};

export const REFUND_LABEL: Record<RefundState, { label: string; tone: BadgeTone }> = {
  'not-applicable': { label: 'None', tone: 'neutral' },
  required: { label: 'Owed', tone: 'warning' },
  requested: { label: 'Requested', tone: 'warning' },
  pending: { label: 'Processing', tone: 'warning' },
  succeeded: { label: 'Refunded', tone: 'success' },
  failed: { label: 'Refused', tone: 'danger' },
  unknown: { label: 'Being checked', tone: 'warning' },
};

/** Supplier reservation states that are still changing (the page keeps checking). */
export const OPEN_RESERVATION: readonly ReservationState[] = [
  'requested',
  'in-progress',
  'unknown',
  'cancellation-pending',
];

/**
 * A booking's badge: a pending booking that waits for its demo payment says
 * so; a supplier booking says where its reservation stands.
 */
export function bookingStatusLabel(
  booking: Pick<BookingSummary, 'status' | 'payment'> &
    Partial<Pick<BookingSummary, 'reservation'>>,
): {
  label: string;
  tone: BadgeTone;
} {
  const reservation = booking.reservation;
  if (reservation?.kind === 'supplier' && reservation.state) {
    if (booking.status === 'pending' || reservation.state === 'cancellation-pending') {
      return RESERVATION_LABEL[reservation.state];
    }
    if (booking.status === 'confirmed') return { label: 'Confirmed', tone: 'success' };
    if (booking.status === 'failed') return { label: 'Not booked', tone: 'danger' };
    return STATUS_LABEL[booking.status];
  }
  if (booking.status === 'pending' && booking.payment.mode === 'demo') {
    return booking.payment.state === 'processing'
      ? { label: 'Demo payment processing', tone: 'warning' }
      : { label: 'Awaiting demo payment', tone: 'warning' };
  }
  return STATUS_LABEL[booking.status];
}

/** Payment status wording. Success is always qualified as a demo where it is one. */
export function paymentStatusLabel(
  status: PaymentStatus,
  demo: boolean,
): { label: string; tone: BadgeTone } {
  const d = demo ? ' (demo)' : '';
  switch (status) {
    case 'created':
      return { label: `Starting${d}`, tone: 'warning' };
    case 'pending':
      return { label: `Processing${d}`, tone: 'warning' };
    case 'succeeded':
      return { label: demo ? 'Demo payment succeeded' : 'Paid', tone: 'success' };
    case 'failed':
      return { label: `Failed${d}`, tone: 'danger' };
    case 'cancelled':
      return { label: `Cancelled${d}`, tone: 'neutral' };
    case 'refund_pending':
      return { label: 'Refund processing', tone: 'warning' };
    case 'refunded':
      return { label: 'Refunded', tone: 'neutral' };
  }
}
