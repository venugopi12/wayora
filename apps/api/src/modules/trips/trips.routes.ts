import { Router, type RequestHandler, type Response } from 'express';
import {
  bookingParamsSchema,
  tripDisruptionsQuerySchema,
  tripTimelineQuerySchema,
} from '@wayora/contracts';
import { currentUser, noStore, requireAuth, type AuthLocals } from '../../middleware/session.js';
import { AppError } from '../../utils/errors.js';
import { errorForLog } from '../../utils/log-safety.js';
import type { Logger } from '../../utils/logger.js';
import { sendData } from '../../utils/respond.js';
import { validateRequest } from '../../utils/validate.js';
import type { TripEventHub } from './stream.js';
import type { TripsService } from './trips.service.js';

export interface TripsRouterOptions {
  trips: TripsService;
  hub: TripEventHub;
  logger: Logger;
  /** Per-user limit on status refreshes (they may call a provider). */
  refreshLimiter?: RequestHandler;
  /** Whether a session token still names a valid session (long-lived streams re-check). */
  sessionValid: (token: string | undefined) => Promise<boolean>;
  /** Stream timings (tests shorten them). */
  stream?: Partial<StreamTimings>;
}

export interface StreamTimings {
  heartbeatMs: number;
  /** Re-read the newest entry (safety net for missed announcements). */
  catchUpMs: number;
  /** Re-check the session. */
  sessionCheckMs: number;
  /** Close after this long; the browser reconnects (and is authenticated again). */
  maxAgeMs: number;
  /** Open streams per user (per process). */
  maxPerUser: number;
}

const DEFAULT_TIMINGS: StreamTimings = {
  heartbeatMs: 25_000,
  catchUpMs: 30_000,
  sessionCheckMs: 60_000,
  maxAgeMs: 30 * 60_000,
  maxPerUser: 5,
};

const noQuery = (req: Parameters<RequestHandler>[0]) => {
  if (Object.keys(req.query).length > 0) {
    throw new AppError('VALIDATION_FAILED', 'The request is invalid.', {
      details: [
        { path: 'query', message: 'This endpoint takes no parameters.', code: 'unrecognized_keys' },
      ],
    });
  }
};

/**
 * Trip tracking for the signed-in user's bookings (docs/trips.md#api).
 * Ownership is checked on every request: someone else's booking is 404.
 *
 * GET  /bookings/:reference/timeline        timeline, oldest first (cursor paged)
 * GET  /bookings/:reference/status          travel status with freshness
 * GET  /bookings/:reference/disruptions     ?state=open|all
 * POST /bookings/:reference/status/refresh  ask the provider (rate limited)
 * GET  /bookings/:reference/events          live updates (Server-Sent Events)
 */
export function tripsRouter(options: TripsRouterOptions): Router {
  const { trips, hub, logger } = options;
  const timings = { ...DEFAULT_TIMINGS, ...options.stream };
  const router = Router();
  const refreshLimit: RequestHandler[] = options.refreshLimiter ? [options.refreshLimiter] : [];
  const openStreams = new Map<string, number>();

  router.get('/:reference/timeline', noStore, requireAuth, async (req, res) => {
    const { params, query } = validateRequest(req, {
      params: bookingParamsSchema,
      query: tripTimelineQuerySchema,
    });
    sendData(res, await trips.timeline(currentUser(res).id, params.reference, query));
  });

  router.get('/:reference/status', noStore, requireAuth, async (req, res) => {
    const { params } = validateRequest(req, { params: bookingParamsSchema });
    noQuery(req);
    sendData(res, await trips.status(currentUser(res).id, params.reference));
  });

  router.get('/:reference/disruptions', noStore, requireAuth, async (req, res) => {
    const { params, query } = validateRequest(req, {
      params: bookingParamsSchema,
      query: tripDisruptionsQuerySchema,
    });
    sendData(res, await trips.disruptions(currentUser(res).id, params.reference, query.state));
  });

  router.post(
    '/:reference/status/refresh',
    noStore,
    requireAuth,
    ...refreshLimit,
    async (req, res) => {
      const { params } = validateRequest(req, { params: bookingParamsSchema });
      noQuery(req);
      sendData(res, await trips.refresh(currentUser(res).id, params.reference));
    },
  );

  router.get('/:reference/events', noStore, requireAuth, async (req, res) => {
    const { params } = validateRequest(req, { params: bookingParamsSchema });
    noQuery(req);
    const user = currentUser(res);
    const booking = await trips.owned(user.id, params.reference);
    const open = openStreams.get(user.id) ?? 0;
    if (open >= timings.maxPerUser) {
      throw new AppError(
        'RATE_LIMITED',
        'Too many open live-update connections. Close a tab and try again.',
      );
    }
    openStreams.set(user.id, open + 1);
    stream(res, {
      bookingId: booking.id,
      reference: booking.reference,
      lastEventId: req.get('Last-Event-ID'),
      onClose: () => {
        const n = (openStreams.get(user.id) ?? 1) - 1;
        if (n <= 0) openStreams.delete(user.id);
        else openStreams.set(user.id, n);
      },
    });
  });

  function stream(
    res: Response,
    ctx: {
      bookingId: string;
      reference: string;
      lastEventId: string | undefined;
      onClose: () => void;
    },
  ): void {
    const token = (res.locals as AuthLocals).sessionToken;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Connection', 'keep-alive');
    // Proxies must not buffer the stream.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let lastSent =
      ctx.lastEventId && /^\d{1,19}$/.test(ctx.lastEventId) ? BigInt(ctx.lastEventId) : -1n;
    let closed = false;
    const write = (chunk: string) => {
      if (!closed) res.write(chunk);
    };
    const send = (seq: string) => {
      if (BigInt(seq) <= lastSent) return; // already announced on this stream
      lastSent = BigInt(seq);
      write(
        `id: ${seq}\nevent: trip-event\ndata: ${JSON.stringify({ seq, reference: ctx.reference })}\n\n`,
      );
    };
    const end = (reason: 'signed-out' | 'reconnect') => {
      write(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
      cleanup();
      res.end();
    };
    const catchUp = async () => {
      try {
        const seq = await trips.latestSeq(ctx.bookingId);
        if (seq) send(seq);
      } catch (err) {
        logger.warn({ err: errorForLog(err) }, 'Trip stream catch-up failed');
      }
    };

    // The browser retries after 10 s if the connection drops.
    write('retry: 10000\n\n');
    const unsubscribe = hub.subscribe(ctx.bookingId, (signal) => {
      if ('seq' in signal) send(signal.seq);
      else if ('closing' in signal) end('reconnect');
      else void catchUp();
    });
    const timers = [
      setInterval(() => write(': ping\n\n'), timings.heartbeatMs),
      setInterval(() => void catchUp(), timings.catchUpMs),
      setInterval(() => {
        void options.sessionValid(token).then(
          (valid) => {
            if (!valid && !closed) end('signed-out');
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
      ctx.onClose();
    }
    res.on('close', cleanup);

    // A reconnecting browser (Last-Event-ID) hears about anything newer than
    // what it last saw; a new one has just read the timeline itself.
    const start = async () => {
      if (lastSent < 0n) {
        const seq = await trips.latestSeq(ctx.bookingId).catch(() => null);
        if (seq && BigInt(seq) > lastSent) lastSent = BigInt(seq);
      } else {
        await catchUp();
      }
      write(`event: ready\ndata: ${JSON.stringify({ live: hub.live })}\n\n`);
    };
    void start();
  }

  return router;
}
