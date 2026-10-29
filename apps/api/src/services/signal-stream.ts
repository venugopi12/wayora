import type { Response } from 'express';
import { errorForLog } from '../utils/log-safety.js';
import type { Logger } from '../utils/logger.js';
import type { SignalHub } from './signal-hub.js';

/*
 * One Server-Sent Events stream fed by a SignalHub (trip tracking, plan
 * collaboration). It only says "something new, sequence N": the browser
 * re-reads through the authorized endpoints. Safety nets:
 * - `Last-Event-ID` (sent by the browser on reconnect) and a periodic
 *   catch-up re-read cover announcements missed while disconnected;
 * - repeated or older sequence numbers are dropped (no duplicate events);
 * - who may follow it is re-checked periodically (and, if asked, before each
 *   event): a signed-out session or lost access ends the stream;
 * - streams end after `maxAgeMs`, so the browser reconnects and is
 *   authenticated again.
 */

export interface StreamTimings {
  heartbeatMs: number;
  /** Re-read the newest sequence number (safety net for missed announcements). */
  catchUpMs: number;
  /** Re-check the session (and access). */
  sessionCheckMs: number;
  /** Close after this long; the browser reconnects (and is authenticated again). */
  maxAgeMs: number;
  /** Open streams per user (per process). */
  maxPerUser: number;
}

export const DEFAULT_STREAM_TIMINGS: StreamTimings = {
  heartbeatMs: 25_000,
  catchUpMs: 30_000,
  sessionCheckMs: 60_000,
  maxAgeMs: 30 * 60_000,
  maxPerUser: 5,
};

export type StreamAccess = 'ok' | 'signed-out' | 'access-ended';

export interface SignalStreamOptions {
  hub: SignalHub;
  /** What this stream follows (a booking id, a plan id). */
  key: string;
  /** SSE event name for announcements. */
  eventName: string;
  /** The event's JSON payload for a sequence number (ids only). */
  payload: (seq: string) => Record<string, unknown>;
  lastEventId: string | undefined;
  /** The newest sequence number, or null. */
  latest: () => Promise<string | null>;
  /** Whether the viewer may still follow the stream. */
  check: () => Promise<StreamAccess>;
  /** Also check before sending each announcement (membership can change any time). */
  checkBeforeEachEvent?: boolean;
  timings: StreamTimings;
  logger: Logger;
  onClose: () => void;
}

export function serveSignalStream(res: Response, options: SignalStreamOptions): void {
  const { hub, timings, logger } = options;
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Connection', 'keep-alive');
  // Proxies must not buffer the stream.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let lastSent =
    options.lastEventId && /^\d{1,19}$/.test(options.lastEventId)
      ? BigInt(options.lastEventId)
      : -1n;
  let closed = false;
  const write = (chunk: string) => {
    if (!closed) res.write(chunk);
  };
  const end = (reason: 'signed-out' | 'reconnect' | 'access-ended') => {
    write(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
    cleanup();
    res.end();
  };
  const emit = (seq: string) => {
    if (closed || BigInt(seq) <= lastSent) return; // already announced on this stream
    lastSent = BigInt(seq);
    write(
      `id: ${seq}\nevent: ${options.eventName}\ndata: ${JSON.stringify(options.payload(seq))}\n\n`,
    );
  };
  const send = async (seq: string) => {
    if (closed || BigInt(seq) <= lastSent) return;
    if (options.checkBeforeEachEvent) {
      // Fail closed: if access can't be checked, say nothing now. The
      // announcement isn't lost: the next catch-up re-reads the newest one.
      const access = await options.check().catch(() => 'unknown' as const);
      if (access === 'unknown') return;
      if (access !== 'ok') {
        if (!closed) end(access);
        return;
      }
    }
    emit(seq);
  };
  const catchUp = async () => {
    try {
      const seq = await options.latest();
      if (seq) await send(seq);
    } catch (err) {
      logger.warn({ err: errorForLog(err) }, 'Live-update catch-up failed');
    }
  };

  // The browser retries after 10 s if the connection drops.
  write('retry: 10000\n\n');
  const unsubscribe = hub.subscribe(options.key, (signal) => {
    if ('seq' in signal) void send(signal.seq);
    else if ('closing' in signal) end('reconnect');
    else void catchUp();
  });
  const timers = [
    setInterval(() => write(': ping\n\n'), timings.heartbeatMs),
    setInterval(() => void catchUp(), timings.catchUpMs),
    setInterval(() => {
      void options.check().then(
        (access) => {
          if (access !== 'ok' && !closed) end(access);
        },
        () => undefined,
      );
    }, timings.sessionCheckMs),
  ];
  const maxAge = setTimeout(() => end('reconnect'), timings.maxAgeMs);
  for (const t of timers) t.unref();
  maxAge.unref();

  function cleanup() {
    if (closed) return;
    closed = true;
    unsubscribe();
    for (const t of timers) clearInterval(t);
    clearTimeout(maxAge);
    options.onClose();
  }
  res.on('close', cleanup);

  // A reconnecting browser (Last-Event-ID) hears about anything newer than
  // what it last saw; a new one has just read the data itself.
  const start = async () => {
    if (lastSent < 0n) {
      const seq = await options.latest().catch(() => null);
      if (seq && BigInt(seq) > lastSent) lastSent = BigInt(seq);
    } else {
      await catchUp();
    }
    write(`event: ready\ndata: ${JSON.stringify({ live: hub.live })}\n\n`);
  };
  void start();
}

/** Counts open streams per user (per process) and enforces the cap. */
export class StreamCounter {
  private readonly open = new Map<string, number>();
  constructor(private readonly max: number) {}
  /** Reserves a slot; false when the user is at the cap. */
  take(userId: string): boolean {
    const n = this.open.get(userId) ?? 0;
    if (n >= this.max) return false;
    this.open.set(userId, n + 1);
    return true;
  }
  release(userId: string): void {
    const n = (this.open.get(userId) ?? 1) - 1;
    if (n <= 0) this.open.delete(userId);
    else this.open.set(userId, n);
  }
}
