import { Router, type RequestHandler } from 'express';
import {
  budgetVersionQuerySchema,
  createExpenseSchema,
  createSettlementSchema,
  expenseFromBookingSchema,
  expenseListQuerySchema,
  expenseParamsSchema,
  putBudgetSchema,
  settlementParamsSchema,
  updateExpenseSchema,
  createTripInvitationSchema,
  invitationParamsSchema,
  plannerActivityQuerySchema,
  receivedInvitationsQuerySchema,
  tripInvitationParamsSchema,
  tripMemberParamsSchema,
  updateTripMemberSchema,
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
import type { PrismaClient } from '@wayora/database';
import { currentUser, noStore, requireAuth, type AuthLocals } from '../../middleware/session.js';
import type { SignalHub } from '../../services/signal-hub.js';
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
import { IDEMPOTENCY_KEY_HEADER, validateIdempotencyKey } from '../bookings/idempotency.js';
import { canView, tripAccess } from './access.js';
import type { BudgetService } from './budget.service.js';
import type { CollaborationService } from './collaboration.service.js';
import type { PlannerService } from './planner.service.js';

/** pg_notify channel announcing new plan history rows (the migration's trigger). */
export const PLANNER_EVENTS_CHANNEL = 'wayora_planner_activity';

export interface PlannerRouterOptions {
  planner: PlannerService;
  collaboration: CollaborationService;
  /** Budget, expenses and group split (Phase 20). */
  budget: BudgetService;
  prisma: PrismaClient;
  /** Live updates: announcements of new plan history rows (Phase 19). */
  hub: SignalHub;
  logger: Logger;
  /** Whether a session token still names a valid session (long-lived streams re-check). */
  sessionValid: (token: string | undefined) => Promise<boolean>;
  /** Per-user limit on planner writes (itinerary, details, membership). */
  writeLimiter?: RequestHandler;
  /** Per-user limit on sending invitations (stricter: each one looks up an account). */
  inviteLimiter?: RequestHandler;
  /** Stream timings (tests shorten them). */
  stream?: Partial<StreamTimings>;
}

/**
 * Planned trips the signed-in user owns or is a member of (docs/planner.md#api).
 * Mounted at /planner after loadSession. No route takes a user id; access is
 * resolved from the session on every request (access.ts): a plan the user
 * can't see is a 404, a change their role doesn't allow is a 403.
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
 * Collaboration (Phase 19):
 * GET    /planner/trips/:tripId/members                 owner, members, (owner) open invitations
 * POST   /planner/trips/:tripId/invitations             invite an account by email (owner)  201
 * DELETE /planner/trips/:tripId/invitations/:invitationId  revoke (owner)
 * PATCH  /planner/trips/:tripId/members/:memberId       change role (owner)
 * DELETE /planner/trips/:tripId/members/:memberId       remove (owner) or leave (self)
 * GET    /planner/trips/:tripId/activity?before=&limit= change history, newest first
 * GET    /planner/trips/:tripId/events                  live updates (Server-Sent Events)
 * GET    /planner/invitations?status=pending|all        invitations addressed to you
 * GET    /planner/invitations/:invitationId
 * POST   /planner/invitations/:invitationId/accept      join the plan
 * POST   /planner/invitations/:invitationId/decline
 *
 * Budget and expenses (Phase 20, docs/planner.md#budget):
 * GET    /planner/trips/:tripId/budget                   budget, progress, totals per currency
 * PUT    /planner/trips/:tripId/budget                   create or replace (owner, editors)
 * DELETE /planner/trips/:tripId/budget?version=          remove (owner, editors)
 * GET    /planner/trips/:tripId/expenses?filters         expenses, filtered and sorted
 * POST   /planner/trips/:tripId/expenses                 add (owner, editors; Idempotency-Key) 201
 * POST   /planner/trips/:tripId/expenses/from-booking    add the linked booking (owner; key)   201
 * GET    /planner/trips/:tripId/expenses/:expenseId
 * PUT    /planner/trips/:tripId/expenses/:expenseId      replace (owner, or the editor who added it)
 * DELETE /planner/trips/:tripId/expenses/:expenseId      delete (same)
 * GET    /planner/trips/:tripId/balances                 balances per currency + suggestions
 * POST   /planner/trips/:tripId/settlements              record a payment made outside Wayora 201
 * DELETE /planner/trips/:tripId/settlements/:settlementId
 *
 * Writes return the whole updated trip, so the client never has to merge.
 */
export function plannerRouter(options: PlannerRouterOptions): Router {
  const { planner, collaboration, budget, hub, logger } = options;
  const limit: RequestHandler[] = options.writeLimiter ? [options.writeLimiter] : [];
  const inviteLimit: RequestHandler[] = options.inviteLimiter ? [options.inviteLimiter] : [];
  const timings = { ...DEFAULT_STREAM_TIMINGS, ...options.stream };
  const openStreams = new StreamCounter(timings.maxPerUser);
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
    sendData(res, await planner.reorderDay(currentUser(res).id, params.tripId, params.day, body));
  });

  router.get('/trips/:tripId/suggestions', async (req, res) => {
    const { params, query } = validateRequest(req, {
      params: plannedTripParamsSchema,
      query: suggestionQuerySchema,
    });
    sendData(res, await planner.suggestions(currentUser(res).id, params.tripId, query.category));
  });

  // ─── Collaboration ────────────────────────────────────────────────────

  router.get('/trips/:tripId/members', async (req, res) => {
    const { params } = validateRequest(req, { params: plannedTripParamsSchema });
    sendData(res, await collaboration.members(currentUser(res).id, params.tripId));
  });

  router.post('/trips/:tripId/invitations', ...inviteLimit, ...limit, async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: plannedTripParamsSchema,
      body: createTripInvitationSchema,
    });
    sendData(res, await collaboration.invite(currentUser(res).id, params.tripId, body), 201);
  });

  router.delete('/trips/:tripId/invitations/:invitationId', ...limit, async (req, res) => {
    const { params } = validateRequest(req, { params: tripInvitationParamsSchema });
    sendData(
      res,
      await collaboration.revoke(currentUser(res).id, params.tripId, params.invitationId),
    );
  });

  router.patch('/trips/:tripId/members/:memberId', ...limit, async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: tripMemberParamsSchema,
      body: updateTripMemberSchema,
    });
    sendData(
      res,
      await collaboration.changeRole(
        currentUser(res).id,
        params.tripId,
        params.memberId,
        body.role,
      ),
    );
  });

  router.delete('/trips/:tripId/members/:memberId', ...limit, async (req, res) => {
    const { params } = validateRequest(req, { params: tripMemberParamsSchema });
    await collaboration.removeMember(currentUser(res).id, params.tripId, params.memberId);
    sendData(res, { removed: true });
  });

  // ─── Budget and expenses (Phase 20) ───────────────────────────────────

  router.get('/trips/:tripId/budget', async (req, res) => {
    const { params } = validateRequest(req, { params: plannedTripParamsSchema });
    sendData(res, await budget.overview(currentUser(res).id, params.tripId));
  });

  router.put('/trips/:tripId/budget', ...limit, async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: plannedTripParamsSchema,
      body: putBudgetSchema,
    });
    sendData(res, await budget.putBudget(currentUser(res).id, params.tripId, body));
  });

  router.delete('/trips/:tripId/budget', ...limit, async (req, res) => {
    const { params, query } = validateRequest(req, {
      params: plannedTripParamsSchema,
      query: budgetVersionQuerySchema,
    });
    sendData(res, await budget.removeBudget(currentUser(res).id, params.tripId, query.version));
  });

  router.get('/trips/:tripId/expenses', async (req, res) => {
    const { params, query } = validateRequest(req, {
      params: plannedTripParamsSchema,
      query: expenseListQuerySchema,
    });
    sendData(res, await budget.listExpenses(currentUser(res).id, params.tripId, query));
  });

  router.post('/trips/:tripId/expenses', ...limit, async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: plannedTripParamsSchema,
      body: createExpenseSchema,
    });
    const key = validateIdempotencyKey(req.get(IDEMPOTENCY_KEY_HEADER), 'expense');
    const result = await budget.createExpense(currentUser(res).id, params.tripId, body, key);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    sendData(res, result.expense, 201);
  });

  router.post('/trips/:tripId/expenses/from-booking', ...limit, async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: plannedTripParamsSchema,
      body: expenseFromBookingSchema,
    });
    const key = validateIdempotencyKey(req.get(IDEMPOTENCY_KEY_HEADER), 'expense');
    const result = await budget.addBookingExpense(
      currentUser(res).id,
      params.tripId,
      body.split,
      key,
    );
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    sendData(res, result.expense, 201);
  });

  router.get('/trips/:tripId/expenses/:expenseId', async (req, res) => {
    const { params } = validateRequest(req, { params: expenseParamsSchema });
    sendData(res, await budget.getExpense(currentUser(res).id, params.tripId, params.expenseId));
  });

  router.put('/trips/:tripId/expenses/:expenseId', ...limit, async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: expenseParamsSchema,
      body: updateExpenseSchema,
    });
    sendData(
      res,
      await budget.updateExpense(currentUser(res).id, params.tripId, params.expenseId, body),
    );
  });

  router.delete('/trips/:tripId/expenses/:expenseId', ...limit, async (req, res) => {
    const { params } = validateRequest(req, { params: expenseParamsSchema });
    await budget.deleteExpense(currentUser(res).id, params.tripId, params.expenseId);
    sendData(res, { deleted: true });
  });

  router.get('/trips/:tripId/balances', async (req, res) => {
    const { params } = validateRequest(req, { params: plannedTripParamsSchema });
    sendData(res, await budget.balances(currentUser(res).id, params.tripId));
  });

  router.post('/trips/:tripId/settlements', ...limit, async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: plannedTripParamsSchema,
      body: createSettlementSchema,
    });
    const key = validateIdempotencyKey(req.get(IDEMPOTENCY_KEY_HEADER), 'payment record');
    const result = await budget.createSettlement(currentUser(res).id, params.tripId, body, key);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    sendData(res, result.balances, 201);
  });

  router.delete('/trips/:tripId/settlements/:settlementId', ...limit, async (req, res) => {
    const { params } = validateRequest(req, { params: settlementParamsSchema });
    sendData(
      res,
      await budget.deleteSettlement(currentUser(res).id, params.tripId, params.settlementId),
    );
  });

  router.get('/trips/:tripId/activity', async (req, res) => {
    const { params, query } = validateRequest(req, {
      params: plannedTripParamsSchema,
      query: plannerActivityQuerySchema,
    });
    sendData(res, await collaboration.activity(currentUser(res).id, params.tripId, query));
  });

  router.get('/invitations', async (req, res) => {
    const { query } = validateRequest(req, { query: receivedInvitationsQuerySchema });
    sendData(res, await collaboration.received(currentUser(res).id, query.status));
  });

  router.get('/invitations/:invitationId', async (req, res) => {
    const { params } = validateRequest(req, { params: invitationParamsSchema });
    sendData(res, await collaboration.receivedOne(currentUser(res).id, params.invitationId));
  });

  for (const answer of ['accept', 'decline'] as const) {
    router.post(`/invitations/:invitationId/${answer}`, ...limit, async (req, res) => {
      const { params } = validateRequest(req, { params: invitationParamsSchema });
      sendData(res, await collaboration.respond(currentUser(res).id, params.invitationId, answer));
    });
  }

  // Live updates: "the plan changed, revision N". The browser re-reads the
  // plan through the endpoints above, so this carries no plan content.
  router.get('/trips/:tripId/events', async (req, res) => {
    const { params } = validateRequest(req, { params: plannedTripParamsSchema });
    if (Object.keys(req.query).length > 0) {
      throw new AppError('VALIDATION_FAILED', 'The request is invalid.', {
        details: [
          {
            path: 'query',
            message: 'This endpoint takes no parameters.',
            code: 'unrecognized_keys',
          },
        ],
      });
    }
    const user = currentUser(res);
    await tripAccess(options.prisma, user.id, params.tripId, 'view');
    if (!openStreams.take(user.id)) {
      throw new AppError(
        'RATE_LIMITED',
        'Too many open live-update connections. Close a tab and try again.',
      );
    }
    const token = (res.locals as AuthLocals).sessionToken;
    serveSignalStream(res, {
      hub,
      key: params.tripId,
      eventName: 'plan-changed',
      payload: (seq) => ({ revision: Number(seq), tripId: params.tripId }),
      lastEventId: req.get('Last-Event-ID'),
      latest: async () => {
        const trip = await options.prisma.plannedTrip.findUnique({
          where: { id: params.tripId },
          select: { revision: true },
        });
        return trip && trip.revision > 0 ? String(trip.revision) : null;
      },
      check: async () => {
        if (!(await options.sessionValid(token))) return 'signed-out';
        return (await canView(options.prisma, user.id, params.tripId)) ? 'ok' : 'access-ended';
      },
      // Membership can end at any moment: re-check before telling anyone anything.
      checkBeforeEachEvent: true,
      timings,
      logger,
      onClose: () => openStreams.release(user.id),
    });
  });

  return router;
}
