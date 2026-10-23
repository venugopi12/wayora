import { listen, type Listener } from '@wayora/database';
import { scrub } from '../../utils/log-safety.js';
import type { Logger } from '../../utils/logger.js';

/*
 * Live trip updates, in-process fan-out (docs/trips.md#live-updates).
 *
 * Every new timeline entry is announced by the database itself
 * (`trip_events_announce` trigger → pg_notify on commit). Each API instance
 * LISTENs once and passes the announcement to the browsers following that
 * booking. Announcements carry ids only; browsers re-read the timeline
 * through the normal, authorized endpoint, so a missed or repeated
 * announcement can't lose or duplicate anything.
 */

export const TRIP_EVENTS_CHANNEL = 'wayora_trip_events';

export type TripSignal = { seq: string } | { resync: true } | { closing: true };
type Subscriber = (signal: TripSignal) => void;

export interface TripEventHub {
  /** Whether announcements are arriving (the LISTEN connection is up). */
  readonly live: boolean;
  subscribe(bookingId: string, subscriber: Subscriber): () => void;
  /** Delivers an announcement to this process's subscribers. */
  deliver(bookingId: string, seq: string): void;
  close(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fan-out only (no database listener): tests, and processes without one. */
export class LocalTripEventHub implements TripEventHub {
  protected readonly subscribers = new Map<string, Set<Subscriber>>();
  get live(): boolean {
    return false;
  }
  subscribe(bookingId: string, subscriber: Subscriber): () => void {
    let set = this.subscribers.get(bookingId);
    if (!set) {
      set = new Set();
      this.subscribers.set(bookingId, set);
    }
    set.add(subscriber);
    return () => {
      set.delete(subscriber);
      if (set.size === 0) this.subscribers.delete(bookingId);
    };
  }
  deliver(bookingId: string, seq: string): void {
    for (const s of this.subscribers.get(bookingId) ?? []) s({ seq });
  }
  /** Tells every subscriber to re-read (after a gap in announcements). */
  protected resyncAll(): void {
    for (const set of this.subscribers.values()) for (const s of set) s({ resync: true });
  }
  get subscriberCount(): number {
    let n = 0;
    for (const set of this.subscribers.values()) n += set.size;
    return n;
  }
  /** Ends every open stream (they reconnect elsewhere), then stops. */
  close(): Promise<void> {
    for (const set of [...this.subscribers.values()])
      for (const s of [...set]) s({ closing: true });
    this.subscribers.clear();
    return Promise.resolve();
  }
}

/** Fan-out fed by PostgreSQL LISTEN. */
export class PgTripEventHub extends LocalTripEventHub {
  private readonly listener: Listener;
  private lastErrorLogAt = 0;

  constructor(databaseUrl: string, logger: Logger) {
    super();
    const log = logger.child({ component: 'trip-events' });
    let connectedBefore = false;
    this.listener = listen(databaseUrl, TRIP_EVENTS_CHANNEL, {
      onMessage: (payload) => {
        try {
          const msg = JSON.parse(payload) as { bookingId?: unknown; seq?: unknown };
          const seq =
            typeof msg.seq === 'number' || typeof msg.seq === 'string' ? String(msg.seq) : '';
          if (typeof msg.bookingId === 'string' && UUID.test(msg.bookingId) && /^\d+$/.test(seq)) {
            this.deliver(msg.bookingId, seq);
          }
        } catch {
          // Not ours or malformed: ignore.
        }
      },
      onConnect: () => {
        // Announcements may have been missed while disconnected.
        if (connectedBefore) this.resyncAll();
        connectedBefore = true;
        log.info('Listening for trip updates');
      },
      onError: (error) => {
        const now = Date.now();
        if (now - this.lastErrorLogAt < 60_000) return;
        this.lastErrorLogAt = now;
        log.warn(
          { err: { message: scrub(error.message) } },
          'Trip update listener disconnected (retrying)',
        );
      },
    });
  }
  override get live(): boolean {
    return this.listener.connected;
  }
  override async close(): Promise<void> {
    await super.close();
    await this.listener.close();
  }
}
