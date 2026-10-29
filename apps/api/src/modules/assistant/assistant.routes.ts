import { Router, type RequestHandler } from 'express';
import {
  applyAssistantProposalSchema,
  assistantConversationListQuerySchema,
  assistantConversationParamsSchema,
  assistantMessageParamsSchema,
  assistantMessagesQuerySchema,
  checkAssistantItinerarySchema,
  createAssistantConversationSchema,
  plannedTripParamsSchema,
  sendAssistantMessageSchema,
} from '@wayora/contracts';
import { currentUser, noStore, requireAuth } from '../../middleware/session.js';
import { sendData } from '../../utils/respond.js';
import { validateRequest } from '../../utils/validate.js';
import { IDEMPOTENCY_KEY_HEADER, validateIdempotencyKey } from '../bookings/idempotency.js';
import type { AssistantService } from './assistant.service.js';

/*
 * Travel assistant API (docs/assistant.md#api). Signed-in users only; every
 * response is no-store. Replies are not streamed.
 *
 * GET    /assistant/status                                       provider, limits, today's usage
 * GET    /assistant/conversations?page=&pageSize=                your conversations
 * POST   /assistant/conversations                                { tripId? } (Idempotency-Key)
 * GET    /assistant/conversations/:id?before=                    messages, newest page
 * DELETE /assistant/conversations/:id
 * POST   /assistant/conversations/:id/messages                   { text, intent? } (Idempotency-Key; AI limits)
 * POST   /assistant/conversations/:id/messages/:mid/check        itinerary vs a plan (read-only)
 * POST   /assistant/conversations/:id/messages/:mid/apply        a confirmed proposal (Idempotency-Key)
 * GET    /assistant/trips/:tripId/context                        what the assistant can see of a plan
 */

export interface AssistantRouterOptions {
  service: AssistantService;
  /** Per-user limit on assistant requests (AI_RATE_LIMIT_MAX per minute). */
  messageLimiter?: RequestHandler;
  /** Per-user limit on writes (conversations, applying proposals). */
  writeLimiter?: RequestHandler;
}

export function assistantRouter({
  service,
  messageLimiter,
  writeLimiter,
}: AssistantRouterOptions): Router {
  const ask = messageLimiter ? [messageLimiter] : [];
  const write = writeLimiter ? [writeLimiter] : [];
  const router = Router();
  router.use(noStore, requireAuth);

  router.get('/status', async (_req, res) => {
    sendData(res, await service.status(currentUser(res).id));
  });

  router.get('/conversations', async (req, res) => {
    const { query } = validateRequest(req, { query: assistantConversationListQuerySchema });
    sendData(res, await service.list(currentUser(res).id, query));
  });

  router.post('/conversations', ...write, async (req, res) => {
    const { body } = validateRequest(req, { body: createAssistantConversationSchema });
    const key = validateIdempotencyKey(req.get(IDEMPOTENCY_KEY_HEADER), 'conversation');
    const result = await service.create(currentUser(res).id, body, key);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    sendData(res, result.conversation, 201);
  });

  router.get('/conversations/:conversationId', async (req, res) => {
    const { params, query } = validateRequest(req, {
      params: assistantConversationParamsSchema,
      query: assistantMessagesQuerySchema,
    });
    sendData(res, await service.get(currentUser(res).id, params.conversationId, query.before));
  });

  router.delete('/conversations/:conversationId', ...write, async (req, res) => {
    const { params } = validateRequest(req, { params: assistantConversationParamsSchema });
    await service.remove(currentUser(res).id, params.conversationId);
    sendData(res, { deleted: true });
  });

  router.post('/conversations/:conversationId/messages', ...ask, async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: assistantConversationParamsSchema,
      body: sendAssistantMessageSchema,
    });
    const key = validateIdempotencyKey(req.get(IDEMPOTENCY_KEY_HEADER), 'message');
    const result = await service.send(currentUser(res).id, params.conversationId, body, key);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    sendData(res, result.exchange, 201);
  });

  router.post('/conversations/:conversationId/messages/:messageId/check', async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: assistantMessageParamsSchema,
      body: checkAssistantItinerarySchema,
    });
    sendData(
      res,
      await service.checkItinerary(
        currentUser(res).id,
        params.conversationId,
        params.messageId,
        body,
      ),
    );
  });

  router.post(
    '/conversations/:conversationId/messages/:messageId/apply',
    ...write,
    async (req, res) => {
      const { params, body } = validateRequest(req, {
        params: assistantMessageParamsSchema,
        body: applyAssistantProposalSchema,
      });
      const key = validateIdempotencyKey(req.get(IDEMPOTENCY_KEY_HEADER), 'change');
      sendData(
        res,
        await service.apply(
          currentUser(res).id,
          params.conversationId,
          params.messageId,
          body,
          key,
        ),
      );
    },
  );

  router.get('/trips/:tripId/context', async (req, res) => {
    const { params } = validateRequest(req, { params: plannedTripParamsSchema });
    sendData(res, await service.tripContext(currentUser(res).id, params.tripId));
  });

  return router;
}
