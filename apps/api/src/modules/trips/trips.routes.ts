import { Router, type RequestHandler } from 'express';
import {
  bookingParamsSchema,
  tripDisruptionsQuerySchema,
  tripTimelineQuerySchema,
} from '@wayora/contracts';
import { currentUser, noStore, requireAuth, type AuthLocals } from '../../middleware/session.js';
import {
  DEFAULT_STREAM_TIMINGS,
  StreamCounter,
  serveSignalStream,
  type StreamTimings,
} from '../../services/signal-stream.js';
import { AppError } from '../../utils/errors.js';
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

export type { StreamTimings };

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
  const timings = { ...DEFAULT_STREAM_TIMINGS, ...options.stream };
  const router = Router();
  const refreshLimit: RequestHandler[] = options.refreshLimiter ? [options.refreshLimiter] : [];
  const openStreams = new StreamCounter(timings.maxPerUser);

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
    if (!openStreams.take(user.id)) {
      throw new AppError(
        'RATE_LIMITED',
        'Too many open live-update connections. Close a tab and try again.',
      );
    }
    const token = (res.locals as AuthLocals).sessionToken;
    serveSignalStream(res, {
      hub,
      key: booking.id,
      eventName: 'trip-event',
      payload: (seq) => ({ seq, reference: booking.reference }),
      lastEventId: req.get('Last-Event-ID'),
      latest: () => trips.latestSeq(booking.id),
      check: async () => ((await options.sessionValid(token)) ? 'ok' : 'signed-out'),
      timings,
      logger,
      onClose: () => openStreams.release(user.id),
    });
  });

  return router;
}
