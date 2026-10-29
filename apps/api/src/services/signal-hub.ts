import { listen, type Listener } from '@wayora/database';
import { scrub } from '../utils/log-safety.js';
import type { Logger } from '../utils/logger.js';

/*
 * In-process fan-out of database announcements to open live-update streams
 * (Server-Sent Events). Used by trip tracking (Phase 17, docs/trips.md) and
 * plan collaboration (Phase 19, docs/planner.md#live-updates).
 *
 * The database announces each new row itself (a trigger → pg_notify on
 * commit). Each API instance LISTENs once per channel and passes the
 * announcement to the streams following that key (a booking, a plan).
 * Announcements carry ids and a sequence number only; browsers re-read
 * through the normal, authorized endpoints, so a missed or repeated
 * announcement can't lose or duplicate anything.
 */

export type Signal = { seq: string } | { resync: true } | { closing: true };
type Subscriber = (signal: Signal) => void;

export interface SignalHub {
  /** Whether announcements are arriving (the LISTEN connection is up). */
  readonly live: boolean;
  subscribe(key: string, subscriber: Subscriber): () => void;
  /** Delivers an announcement to this process's subscribers. */
  deliver(key: string, seq: string): void;
  close(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fan-out only (no database listener): tests, and processes without one. */
export class LocalSignalHub implements SignalHub {
  protected readonly subscribers = new Map<string, Set<Subscriber>>();
  get live(): boolean {
    return false;
  }
  subscribe(key: string, subscriber: Subscriber): () => void {
    let set = this.subscribers.get(key);
    if (!set) {
      set = new Set();
      this.subscribers.set(key, set);
    }
    set.add(subscriber);
    return () => {
      set.delete(subscriber);
      if (set.size === 0) this.subscribers.delete(key);
    };
  }
  deliver(key: string, seq: string): void {
    for (const s of this.subscribers.get(key) ?? []) s({ seq });
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

export interface PgSignalHubOptions {
  /** pg_notify channel. */
  channel: string;
  /** Payload field holding the key (a UUID), e.g. `bookingId`. */
  keyField: string;
  /** Logger component name. */
  component: string;
  /** What is announced, for log lines (e.g. "trip updates"). */
  label: string;
}

/** Fan-out fed by PostgreSQL LISTEN. Payloads: `{ <keyField>: uuid, seq: number }`. */
export class PgSignalHub extends LocalSignalHub {
  private readonly listener: Listener;
  private lastErrorLogAt = 0;

  constructor(databaseUrl: string, logger: Logger, options: PgSignalHubOptions) {
    super();
    const log = logger.child({ component: options.component });
    let connectedBefore = false;
    this.listener = listen(databaseUrl, options.channel, {
      onMessage: (payload) => {
        try {
          const msg = JSON.parse(payload) as Record<string, unknown>;
          const key = msg[options.keyField];
          const seq =
            typeof msg.seq === 'number' || typeof msg.seq === 'string' ? String(msg.seq) : '';
          if (typeof key === 'string' && UUID.test(key) && /^\d+$/.test(seq)) {
            this.deliver(key, seq);
          }
        } catch {
          // Not ours or malformed: ignore.
        }
      },
      onConnect: () => {
        // Announcements may have been missed while disconnected.
        if (connectedBefore) this.resyncAll();
        connectedBefore = true;
        log.info(`Listening for ${options.label}`);
      },
      onError: (error) => {
        const now = Date.now();
        if (now - this.lastErrorLogAt < 60_000) return;
        this.lastErrorLogAt = now;
        log.warn(
          { err: { message: scrub(error.message) } },
          `Listener for ${options.label} disconnected (retrying)`,
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
