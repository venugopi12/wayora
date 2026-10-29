import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { searchRequestSchemas, searchServiceTypeSchema } from '@wayora/contracts';
import { AppError } from '../../utils/errors.js';
import { sendData } from '../../utils/respond.js';
import { validateRequest } from '../../utils/validate.js';
import type { SearchService } from './search.service.js';

const offerParamsSchema = z.object({
  serviceType: searchServiceTypeSchema,
  searchId: z.uuid({ error: 'Not a valid search id.' }),
});
const offerQuerySchema = z
  .object({
    /** Result id as returned by the search (`<providerId>:<offerRef>`). */
    id: z
      .string({ error: 'Name the offer.' })
      .min(1)
      .max(200)
      .regex(/^[\x21-\x7e]+$/, 'Not a valid offer id.'),
  })
  .strict();

/** Aborts when the client disconnects before the response is sent. */
function abortOnClose(res: Response): AbortController {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller;
}

const requestIdOf = (res: Response): string | undefined =>
  typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;

/**
 * POST /search/:serviceType   flights | hotels | trains | buses | metro | cabs | holidays
 *
 * The body is that category's request (docs/search.md#api); `serviceType`
 * comes from the path and may be repeated in the body only if it matches.
 * Search is public: it uses no session and returns nothing user-specific.
 */
/** How an offer can be booked now (Phase 23): demo booking, supplier reservation, or not at all. */
export type BookingAvailability = (result: { source: string; providerId: string }) => {
  available: boolean;
  kind: 'demo' | 'supplier';
  reason: string | null;
};

/** Without a booking service: demo offers only (the Phase 12–22 behaviour). */
const demoOnly: BookingAvailability = (result) =>
  result.source === 'demo'
    ? { available: true, kind: 'demo', reason: null }
    : {
        available: false,
        kind: 'supplier',
        reason: 'Booking supplier offers on Wayora isn’t available for this supplier.',
      };

export function searchRouter(
  service: SearchService,
  limiter?: RequestHandler,
  bookingAvailability: BookingAvailability = demoOnly,
): Router {
  const router = Router();
  const searchLimit: RequestHandler[] = limiter ? [limiter] : [];

  /**
   * GET /search/:serviceType/sessions/:searchId/offer?id=<resultId>
   * One result from a stored search (offer pages). Read-only and cheap, so
   * it isn't counted against the search rate limit (the general API limit
   * still applies).
   */
  router.get('/:serviceType/sessions/:searchId/offer', async (req, res) => {
    // Strict query: the client names the offer and nothing else. Prices,
    // currencies or provider references in the URL are rejected, never used.
    const { params, query } = validateRequest(req, {
      params: offerParamsSchema,
      query: offerQuerySchema,
    });
    const controller = abortOnClose(res);
    let offer;
    try {
      offer = await service.offer(params.serviceType, params.searchId, query.id, {
        signal: controller.signal,
        requestId: requestIdOf(res),
      });
    } catch (error) {
      if (controller.signal.aborted) return; // nobody is waiting for an answer
      throw error;
    }
    res.setHeader('Cache-Control', 'no-store');
    sendData(res, { ...offer, booking: bookingAvailability(offer.result) });
  });

  router.post('/:serviceType', ...searchLimit, async (req, res) => {
    const serviceType = searchServiceTypeSchema.safeParse(req.params.serviceType);
    if (!serviceType.success) {
      throw new AppError(
        'NOT_FOUND',
        `There is no "${String(req.params.serviceType).slice(0, 40)}" search.`,
      );
    }
    const body: unknown = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new AppError('BAD_REQUEST', 'Send the search as a JSON object.');
    }
    const claimed = (body as { serviceType?: unknown }).serviceType;
    if (claimed !== undefined && claimed !== serviceType.data) {
      throw new AppError('VALIDATION_FAILED', 'The request is invalid.', {
        details: [
          {
            path: 'body.serviceType',
            message: `This endpoint searches ${serviceType.data}.`,
            code: 'invalid_value',
          },
        ],
      });
    }
    req.body = { ...body, serviceType: serviceType.data };
    const { body: request } = validateRequest(req, {
      body: searchRequestSchemas[serviceType.data],
    });

    // Stop provider work if the client goes away (e.g. a newer search replaced this one).
    const controller = abortOnClose(res);

    let response;
    try {
      response = await service.search(request, {
        signal: controller.signal,
        requestId: requestIdOf(res),
      });
    } catch (error) {
      if (controller.signal.aborted) return; // nobody is waiting for an answer
      throw error;
    }
    res.setHeader('Cache-Control', 'no-store');
    sendData(res, response);
  });

  return router;
}
