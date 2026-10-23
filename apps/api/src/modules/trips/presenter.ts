import type {
  DisruptionSeverity,
  DisruptionType,
  SearchServiceType,
  TripEvent,
  TripEventType,
  TripSource,
} from '@wayora/contracts';
import { tripEventKind } from '@wayora/contracts';
import type { TripEventSource } from '@wayora/database';

/*
 * Timeline and disruption wording (docs/trips.md#timeline). Written by
 * Wayora from structured fields only; provider text never appears. Demo
 * (simulated) information always says so.
 */

export const SOURCE: Record<TripEventSource, TripSource> = {
  WAYORA: 'wayora',
  DEMO_PROVIDER: 'demo',
  LIVE_PROVIDER: 'live',
};

export const SIMULATED_NOTE = 'Simulated by the demo status provider: not real travel information.';

export const DISRUPTION_NOTICE =
  'Wayora doesn’t change your booking because of a disruption: nothing is cancelled, rebooked, refunded or compensated automatically.';

type Data = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const STATE_TITLE: Record<string, string> = {
  scheduled: 'On schedule',
  delayed: 'Running late',
  departed: 'Departed',
  arrived: 'Arrived',
  cancelled: 'Cancelled by the operator',
  unknown: 'Status unknown',
};

const minutes = (n: number) =>
  n >= 60 && n % 60 === 0
    ? `${n / 60} hour${n === 60 ? '' : 's'}`
    : n >= 60
      ? `${Math.floor(n / 60)} h ${n % 60} min`
      : `${n} minutes`;

export function disruptionTitle(type: DisruptionType, delayMinutes: number | null): string {
  switch (type) {
    case 'departure_delay':
      return delayMinutes
        ? `Departure delayed by about ${minutes(delayMinutes)}`
        : 'Departure delayed';
    case 'arrival_delay':
      return delayMinutes ? `Arrival delayed by about ${minutes(delayMinutes)}` : 'Arrival delayed';
    case 'cancellation':
      return 'Cancelled by the operator';
    case 'schedule_change':
      return 'Schedule changed';
    case 'service_disruption':
      return 'Service disruption';
    case 'booking_change':
      return 'Booking changed by the provider';
  }
}

export function disruptionDescription(
  type: DisruptionType,
  severity: DisruptionSeverity,
  simulated: boolean,
): string {
  const what =
    type === 'cancellation'
      ? 'The operator reports this journey as cancelled.'
      : type === 'schedule_change'
        ? 'The operator reports new times for this journey.'
        : severity === 'info'
          ? 'The operator reports a minor change.'
          : 'The operator reports a change to this journey.';
  return `${simulated ? `${SIMULATED_NOTE} ` : ''}${what} ${DISRUPTION_NOTICE}`;
}

interface EventRow {
  id: string;
  type: string;
  source: TripEventSource;
  occurredAt: Date;
  observedAt: Date | null;
  data: unknown;
}

function text(
  type: TripEventType,
  data: Data,
  booking: { serviceType: SearchServiceType; demo: boolean },
  simulated: boolean,
): { title: string; description: string | null } {
  const serviceType = booking.serviceType;
  const note = str(data.note);
  const demoMode = data.mode === 'DEMO';
  const stay = serviceType === 'hotels';
  const legLabel = str(data.legLabel);
  const prefix = legLabel ? `${legLabel}: ` : '';
  const sim = simulated ? SIMULATED_NOTE : null;
  switch (type) {
    case 'booking_created':
      return { title: 'Booking requested', description: note };
    case 'booking_confirmed':
      return {
        title: booking.demo ? 'Demo booking confirmed' : 'Booking confirmed',
        description: note,
      };
    case 'booking_cancelled':
      return { title: 'Booking cancelled', description: note };
    case 'booking_expired':
      return { title: 'Booking expired', description: note };
    case 'booking_failed':
      return { title: 'Booking failed', description: note };
    case 'payment_succeeded':
      return { title: demoMode ? 'Demo payment succeeded' : 'Payment received', description: note };
    case 'payment_failed':
      return {
        title: demoMode ? 'Demo payment didn’t go through' : 'Payment didn’t go through',
        description: note,
      };
    case 'payment_refund_pending':
      return { title: 'Refund requested', description: note };
    case 'payment_refunded':
      return { title: 'Refund confirmed by the payment provider', description: note };
    case 'travel_reminder':
      return {
        title: stay ? 'Check-in is tomorrow' : 'Your trip starts tomorrow',
        description: 'Reminder sent by Wayora.',
      };
    case 'check_out_reminder':
      return { title: 'Check-out is tomorrow', description: 'Reminder sent by Wayora.' };
    case 'status_changed': {
      const state = str(data.state) ?? 'unknown';
      const delay = num(data.delayMinutes);
      const late = state === 'delayed' && delay ? ` (about ${minutes(delay)} late)` : '';
      return {
        title: `${prefix}${STATE_TITLE[state] ?? 'Status changed'}${late}`,
        description: sim,
      };
    }
    case 'disruption_reported':
    case 'disruption_updated': {
      const kind = (str(data.disruptionType) ?? 'service_disruption') as DisruptionType;
      const title = disruptionTitle(kind, num(data.delayMinutes));
      return {
        title: `${prefix}${type === 'disruption_updated' ? `Update: ${title.charAt(0).toLowerCase()}${title.slice(1)}` : title}`,
        description: `${sim ? `${sim} ` : ''}${DISRUPTION_NOTICE}`,
      };
    }
    case 'disruption_resolved':
      return {
        title: `${prefix}Disruption over`,
        description: sim ?? 'The provider no longer reports this disruption.',
      };
  }
}

export function presentEvent(
  row: EventRow,
  booking: { serviceType: SearchServiceType; demo: boolean },
): TripEvent {
  const type = row.type.toLowerCase() as TripEventType;
  const data = (row.data && typeof row.data === 'object' ? row.data : {}) as Data;
  const source = SOURCE[row.source];
  const { title, description } = text(type, data, booking, source === 'demo');
  const amountMinor = str(data.amountMinor);
  const currency = str(data.currency);
  return {
    id: row.id,
    type,
    kind: tripEventKind(type),
    source,
    title,
    description,
    occurredAt: row.occurredAt.toISOString(),
    observedAt: row.observedAt?.toISOString() ?? null,
    amount:
      amountMinor && currency && /^-?\d+$/.test(amountMinor) ? { amountMinor, currency } : null,
    paymentId: str(data.paymentId),
  };
}
