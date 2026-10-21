import { Router, type RequestHandler } from 'express';
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

/**
 * POST /search/:serviceType   flights | hotels | trains | buses | metro | cabs | holidays
 *
 * The body is that category's request (docs/search.md#api); `serviceType`
 * comes from the path and may be repeated in the body only if it matches.
 * Search is public: it uses no session and returns nothing user-specific.
 */
export function searchRouter(service: SearchService, limiter?: RequestHandler): Router {
  const router = Router();
  const searchLimit: RequestHandler[] = limiter ? [limiter] : [];

  /**
   * GET /search/:serviceType/sessions/:searchId/offer?id=<resultId>
   * One result from a stored search (offer pages). Read-only and cheap, so
   * it isn't counted against the search rate limit (the general API limit
   * still applies).
   */
  router.get('/:serviceType/sessions/:searchId/offer', (req, res) => {
    const { params, query } = validateRequest(req, {
      params: offerParamsSchema,
      query: offerQuerySchema,
    });
    res.setHeader('Cache-Control', 'no-store');
    sendData(res, service.offer(params.serviceType, params.searchId, query.id));
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
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });

    let response;
    try {
      response = await service.search(request, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return; // nobody is waiting for an answer
      throw error;
    }
    res.setHeader('Cache-Control', 'no-store');
    sendData(res, response);
  });

  return router;
}
