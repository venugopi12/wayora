import { Router, type RequestHandler, type Response } from 'express';
import {
  bookingListQuerySchema,
  bookingParamsSchema,
  createBookingRequestSchema,
  type SearchServiceType,
} from '@wayora/contracts';
import { currentUser, noStore, requireAuth } from '../../middleware/session.js';
import { sendData } from '../../utils/respond.js';
import { validateRequest } from '../../utils/validate.js';
import type { BookingsService } from './bookings.service.js';
import { IDEMPOTENCY_KEY_HEADER, validateIdempotencyKey } from './idempotency.js';

const requestIdOf = (res: Response): string | undefined =>
  typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;

/**
 * Demo bookings (docs/bookings.md#api). Every route needs a session; whose
 * bookings these are comes from the session alone, never from the request.
 * A booking is addressed by its public reference, not its database id.
 *
 * POST /bookings                      create (Idempotency-Key required)   201
 * GET  /bookings?view=&page=&pageSize= your bookings, paged
 * GET  /bookings/:reference           one of your bookings
 * POST /bookings/:reference/cancel    cancel it (demo status change)
 */
export function bookingsRouter(
  bookings: BookingsService,
  /** Limits writes per user; runs after requireAuth. */
  writeLimiter?: RequestHandler,
  /** A booking was submitted (analytics, Phase 31). Must not throw or wait. */
  onSubmitted?: (submission: {
    userId: string;
    idempotencyKey: string;
    serviceType: SearchServiceType;
    searchId: string;
  }) => void,
): Router {
  const router = Router();
  router.use(noStore, requireAuth);
  const writes: RequestHandler[] = writeLimiter ? [writeLimiter] : [];

  router.post('/', ...writes, async (req, res) => {
    const key = validateIdempotencyKey(req.get(IDEMPOTENCY_KEY_HEADER));
    const rawBody: unknown = req.body;
    const { body } = validateRequest(req, { body: createBookingRequestSchema });
    onSubmitted?.({
      userId: currentUser(res).id,
      idempotencyKey: key,
      serviceType: body.serviceType,
      searchId: body.searchId,
    });
    const result = await bookings.create(currentUser(res).id, body, rawBody, key, {
      requestId: requestIdOf(res),
    });
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    sendData(res, result.booking, result.status);
  });

  router.get('/', async (req, res) => {
    const { query } = validateRequest(req, { query: bookingListQuerySchema });
    sendData(res, await bookings.list(currentUser(res).id, query));
  });

  router.get('/:reference', async (req, res) => {
    const { params } = validateRequest(req, { params: bookingParamsSchema });
    sendData(res, await bookings.get(currentUser(res).id, params.reference));
  });

  router.post('/:reference/cancel', ...writes, async (req, res) => {
    const { params } = validateRequest(req, { params: bookingParamsSchema });
    sendData(
      res,
      await bookings.cancel(currentUser(res).id, params.reference, {
        requestId: requestIdOf(res),
      }),
    );
  });

  return router;
}
