import type { Logger } from '../../utils/logger.js';
import {
  LocalSignalHub,
  PgSignalHub,
  type Signal,
  type SignalHub,
} from '../../services/signal-hub.js';

/*
 * Live trip updates (docs/trips.md#live-updates): the shared signal hub
 * (services/signal-hub.ts) on the trip timeline's channel. Every new
 * timeline entry is announced by the database (`trip_events_announce`
 * trigger → pg_notify on commit), keyed by booking id.
 */

export const TRIP_EVENTS_CHANNEL = 'wayora_trip_events';

export type TripSignal = Signal;
export type TripEventHub = SignalHub;

/** Fan-out only (no database listener): tests, and processes without one. */
export class LocalTripEventHub extends LocalSignalHub {}

/** Fan-out fed by PostgreSQL LISTEN on the trip timeline channel. */
export class PgTripEventHub extends PgSignalHub {
  constructor(databaseUrl: string, logger: Logger) {
    super(databaseUrl, logger, {
      channel: TRIP_EVENTS_CHANNEL,
      keyField: 'bookingId',
      component: 'trip-events',
      label: 'trip updates',
    });
  }
}
