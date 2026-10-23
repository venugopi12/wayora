import { Router, type RequestHandler } from 'express';
import {
  createItineraryItemSchema,
  createPlannedTripSchema,
  duplicateItineraryItemSchema,
  itineraryDayParamsSchema,
  itineraryItemParamsSchema,
  plannedTripListQuerySchema,
  plannedTripParamsSchema,
  reorderItineraryDaySchema,
  suggestionQuerySchema,
  updateItineraryItemSchema,
  updatePlannedTripSchema,
} from '@wayora/contracts';
import { currentUser, noStore, requireAuth } from '../../middleware/session.js';
import { sendData } from '../../utils/respond.js';
import { validateRequest } from '../../utils/validate.js';
import { IDEMPOTENCY_KEY_HEADER, validateIdempotencyKey } from '../bookings/idempotency.js';
import type { PlannerService } from './planner.service.js';

/**
 * The signed-in user's planned trips (docs/planner.md#api). Mounted at
 * /planner after loadSession. Every route acts on the session's own trips;
 * no route takes a user id, and another user's trip is a 404.
 *
 * GET    /planner/destinations                          curated sample destinations
 * GET    /planner/trips?page=&pageSize=                 list (by start date)
 * POST   /planner/trips                                 create (Idempotency-Key)        201
 * GET    /planner/trips/:tripId                         trip, itinerary and warnings
 * PATCH  /planner/trips/:tripId                         trip details (with `version`)
 * DELETE /planner/trips/:tripId                         { deleted: true }
 * POST   /planner/trips/:tripId/items                   add an activity (Idempotency-Key) 201
 * PATCH  /planner/trips/:tripId/items/:itemId           edit / move to another day or position
 * DELETE /planner/trips/:tripId/items/:itemId
 * POST   /planner/trips/:tripId/items/:itemId/duplicate copy (Idempotency-Key)           201
 * PUT    /planner/trips/:tripId/days/:day/order         set one day's order
 * GET    /planner/trips/:tripId/suggestions?category=   curated sample suggestions
 *
 * Writes return the whole updated trip, so the client never has to merge.
 */
export function plannerRouter(
  planner: PlannerService,
  /** Per-user limit on planner writes. */
  writeLimiter?: RequestHandler,
): Router {
  const limit: RequestHandler[] = writeLimiter ? [writeLimiter] : [];
  const router = Router();
  router.use(noStore, requireAuth);

  router.get('/destinations', (_req, res) => {
    sendData(res, { items: planner.destinations(), sample: true });
  });

  router.get('/trips', async (req, res) => {
    const { query } = validateRequest(req, { query: plannedTripListQuerySchema });
    sendData(res, await planner.list(currentUser(res).id, query));
  });

  router.post('/trips', ...limit, async (req, res) => {
    const { body } = validateRequest(req, { body: createPlannedTripSchema });
    const key = validateIdempotencyKey(req.get(IDEMPOTENCY_KEY_HEADER), 'trip');
    const result = await planner.create(currentUser(res).id, body, key);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    sendData(res, result.trip, 201);
  });

  router.get('/trips/:tripId', async (req, res) => {
    const { params } = validateRequest(req, { params: plannedTripParamsSchema });
    sendData(res, await planner.get(currentUser(res).id, params.tripId));
  });

  router.patch('/trips/:tripId', ...limit, async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: plannedTripParamsSchema,
      body: updatePlannedTripSchema,
    });
    sendData(res, await planner.update(currentUser(res).id, params.tripId, body));
  });

  router.delete('/trips/:tripId', ...limit, async (req, res) => {
    const { params } = validateRequest(req, { params: plannedTripParamsSchema });
    await planner.remove(currentUser(res).id, params.tripId);
    sendData(res, { deleted: true });
  });

  router.post('/trips/:tripId/items', ...limit, async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: plannedTripParamsSchema,
      body: createItineraryItemSchema,
    });
    const key = validateIdempotencyKey(req.get(IDEMPOTENCY_KEY_HEADER), 'activity');
    const result = await planner.addItem(currentUser(res).id, params.tripId, body, key);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    sendData(res, result.trip, 201);
  });

  router.patch('/trips/:tripId/items/:itemId', ...limit, async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: itineraryItemParamsSchema,
      body: updateItineraryItemSchema,
    });
    sendData(
      res,
      await planner.updateItem(currentUser(res).id, params.tripId, params.itemId, body),
    );
  });

  router.delete('/trips/:tripId/items/:itemId', ...limit, async (req, res) => {
    const { params } = validateRequest(req, { params: itineraryItemParamsSchema });
    sendData(res, await planner.deleteItem(currentUser(res).id, params.tripId, params.itemId));
  });

  router.post('/trips/:tripId/items/:itemId/duplicate', ...limit, async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: itineraryItemParamsSchema,
      body: duplicateItineraryItemSchema,
    });
    const key = validateIdempotencyKey(req.get(IDEMPOTENCY_KEY_HEADER), 'activity');
    const result = await planner.duplicateItem(
      currentUser(res).id,
      params.tripId,
      params.itemId,
      body,
      key,
    );
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    sendData(res, result.trip, 201);
  });

  router.put('/trips/:tripId/days/:day/order', ...limit, async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: itineraryDayParamsSchema,
      body: reorderItineraryDaySchema,
    });
    sendData(
      res,
      await planner.reorderDay(currentUser(res).id, params.tripId, params.day, body.itemIds),
    );
  });

  router.get('/trips/:tripId/suggestions', async (req, res) => {
    const { params, query } = validateRequest(req, {
      params: plannedTripParamsSchema,
      query: suggestionQuerySchema,
    });
    sendData(res, await planner.suggestions(currentUser(res).id, params.tripId, query.category));
  });

  return router;
}
