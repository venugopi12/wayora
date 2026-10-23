import pg from 'pg';

/*
 * PostgreSQL LISTEN for in-process fan-out (docs/trips.md#live-updates).
 *
 * One dedicated connection per process listens on a channel; NOTIFY payloads
 * are delivered on commit, to every listening process, so API instances learn
 * about changes made by any instance or job without another service. The
 * connection reconnects with capped backoff; while it is down, messages are
 * missed (consumers recover by re-reading the database).
 */

export interface ListenerEvents {
  onMessage: (payload: string) => void;
  /** Connected (also after a reconnect: a good moment to re-read state). */
  onConnect?: () => void;
  /** Connection lost or failed; `error` has a driver message (scrub before logging). */
  onError?: (error: Error) => void;
}

export interface Listener {
  readonly connected: boolean;
  close(): Promise<void>;
}

const CHANNEL = /^[a-z_][a-z0-9_]{0,62}$/;

export function listen(url: string, channel: string, events: ListenerEvents): Listener {
  if (!CHANNEL.test(channel)) throw new Error('Invalid channel name');
  let client: pg.Client | null = null;
  let connected = false;
  let closed = false;
  let attempt = 0;
  let timer: NodeJS.Timeout | undefined;

  const schedule = () => {
    if (closed) return;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
    attempt += 1;
    timer = setTimeout(() => void connect(), delay);
    timer.unref();
  };

  const connect = async () => {
    if (closed) return;
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    client = c;
    c.on('notification', (msg) => {
      if (msg.channel === channel && msg.payload) events.onMessage(msg.payload);
    });
    c.on('error', (error) => {
      connected = false;
      events.onError?.(error);
      void c.end().catch(() => undefined);
      if (client === c) schedule();
    });
    try {
      await c.connect();
      await c.query(`LISTEN ${channel}`);
      if (closed) {
        await c.end();
        return;
      }
      connected = true;
      attempt = 0;
      events.onConnect?.();
    } catch (error) {
      connected = false;
      events.onError?.(error as Error);
      await c.end().catch(() => undefined);
      if (client === c) schedule();
    }
  };

  void connect();
  return {
    get connected() {
      return connected;
    },
    async close() {
      closed = true;
      clearTimeout(timer);
      connected = false;
      const c = client;
      client = null;
      await c?.end().catch(() => undefined);
    },
  };
}
