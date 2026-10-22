import { Router, type Request, type RequestHandler, type Response } from 'express';
import {
  bookingParamsSchema,
  createPaymentRequestSchema,
  paymentParamsSchema,
} from '@wayora/contracts';
import { currentUser, noStore, requireAuth } from '../../middleware/session.js';
import { AppError } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import { sendData } from '../../utils/respond.js';
import { validateRequest } from '../../utils/validate.js';
import { IDEMPOTENCY_KEY_HEADER, validateIdempotencyKey } from '../bookings/idempotency.js';
import { errorForLog } from '../search/errors.js';
import type { PaymentsService } from './payments.service.js';
import { WebhookVerificationError, providerPaymentEventSchema } from './providers/types.js';

const requestIdOf = (res: Response): string | undefined =>
  typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;

/**
 * Payments of one booking (docs/payments.md#api). Mounted at
 * /bookings/:reference/payments after loadSession.
 *
 * POST /bookings/:reference/payments   start a payment attempt (Idempotency-Key)  201
 * GET  /bookings/:reference/payments   its attempts, newest first
 */
export function bookingPaymentsRouter(
  payments: PaymentsService,
  writeLimiter?: RequestHandler,
): Router {
  const router = Router({ mergeParams: true });
  router.use(noStore, requireAuth);
  const writes: RequestHandler[] = writeLimiter ? [writeLimiter] : [];

  router.post('/', ...writes, async (req, res) => {
    const key = validateIdempotencyKey(req.get(IDEMPOTENCY_KEY_HEADER), 'payment');
    const rawBody: unknown = req.body;
    const { params, body } = validateRequest(req, {
      params: bookingParamsSchema,
      body: createPaymentRequestSchema,
    });
    const result = await payments.create(
      currentUser(res).id,
      params.reference,
      body,
      rawBody,
      key,
      {
        requestId: requestIdOf(res),
      },
    );
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    sendData(res, result.payment, result.status);
  });

  router.get('/', async (req, res) => {
    const { params } = validateRequest(req, { params: bookingParamsSchema });
    sendData(res, await payments.listForBooking(currentUser(res).id, params.reference));
  });

  return router;
}

/**
 * One payment (docs/payments.md#api). Mounted at /payments after loadSession.
 *
 * GET  /payments/:paymentId          status (reconciled with the provider if in progress)
 * POST /payments/:paymentId/cancel   cancel an attempt still in progress
 */
export function paymentsRouter(payments: PaymentsService, writeLimiter?: RequestHandler): Router {
  const router = Router();
  router.use(noStore, requireAuth);
  const writes: RequestHandler[] = writeLimiter ? [writeLimiter] : [];

  router.get('/:paymentId', async (req, res) => {
    const { params } = validateRequest(req, { params: paymentParamsSchema });
    sendData(
      res,
      await payments.get(currentUser(res).id, params.paymentId, { requestId: requestIdOf(res) }),
    );
  });

  router.post('/:paymentId/cancel', ...writes, async (req, res) => {
    const { params } = validateRequest(req, { params: paymentParamsSchema });
    sendData(
      res,
      await payments.cancel(currentUser(res).id, params.paymentId, { requestId: requestIdOf(res) }),
    );
  });

  return router;
}

/** Raw request bodies kept for signature checks (set by the JSON parser in app.ts). */
export type RequestWithRawBody = Request & { rawBody?: Buffer };
export const PAYMENT_EVENTS_PATH = '/api/v1/payment-events/';

/**
 * Inbound provider webhooks (docs/payments.md#events): POST /payment-events/:providerId.
 *
 * Only providers that verify signatures (capabilities.webhooks + verifyEvent)
 * get a route; any other id, including the demo provider, is a 404, so no
 * unauthenticated request can ever report a payment as successful. No session
 * or Origin is involved: the signature over the raw body is the only proof,
 * and an event that fails it is refused before anything is stored.
 */
export function paymentEventsRouter(payments: PaymentsService, logger: Logger): Router {
  const router = Router();
  router.post('/:providerId', async (req: RequestWithRawBody, res) => {
    const provider = payments.providerFor(String(req.params.providerId));
    if (!provider?.capabilities.webhooks || !provider.verifyEvent) {
      throw new AppError('NOT_FOUND', 'The requested resource was not found.');
    }
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      headers[name] = Array.isArray(value) ? value.join(',') : value;
    }
    let events;
    try {
      if (!req.rawBody) throw new WebhookVerificationError('No body.');
      events = provider
        .verifyEvent(req.rawBody, headers)
        .map((e) => providerPaymentEventSchema.parse(e));
    } catch (error) {
      // Never echo which check failed; never log the signature or body.
      logger.warn(
        { providerId: provider.id, err: { name: errorForLog(error).name } },
        'Payment webhook refused',
      );
      throw new AppError('BAD_REQUEST', 'The event could not be verified.');
    }
    const outcomes = [];
    for (const event of events)
      outcomes.push(await payments.events.handle(provider, event, 'webhook'));
    // 200 for everything accepted (applied, duplicate, ignored), so providers stop resending.
    sendData(res, { received: events.length, outcomes });
  });
  return router;
}
