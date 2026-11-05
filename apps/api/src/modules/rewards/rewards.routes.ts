import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  adminCreateRulesSchema,
  adminIssueCreditSchema,
  adminPointsAdjustmentSchema,
  adminRevokeCreditSchema,
  adminRewardTransactionsQuerySchema,
  applyBookingRewardsSchema,
  bookingParamsSchema,
  rewardTransactionsQuerySchema,
  type AdminPermission,
} from '@wayora/contracts';
import type { PrismaClient } from '@wayora/database';
import { currentUser, noStore, requireAuth } from '../../middleware/session.js';
import type { Logger } from '../../utils/logger.js';
import { sendData } from '../../utils/respond.js';
import { validateRequest } from '../../utils/validate.js';
import { adminOf, auditView, requirePermission } from '../admin/access.js';
import type { RewardsService } from './rewards.service.js';

const noQuery = z.object({}).strict();
const requestIdOf = (res: Response): string | undefined =>
  typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;

/**
 * The signed-in user's rewards (docs/rewards.md#api). Mounted at /rewards after loadSession.
 *
 * GET /rewards                points, tier, credits, expiries, rules
 * GET /rewards/transactions   the ledger, newest first (paginated)
 *
 * Read-only: no request can change a balance. Everything is the caller's own.
 */
export function rewardsRouter(rewards: RewardsService): Router {
  const router = Router();
  router.use(noStore, requireAuth);

  router.get('/', async (req, res) => {
    validateRequest(req, { query: noQuery });
    sendData(res, await rewards.summary(currentUser(res).id));
  });

  router.get('/transactions', async (req, res) => {
    const { query } = validateRequest(req, { query: rewardTransactionsQuerySchema });
    sendData(res, await rewards.transactions(currentUser(res).id, query));
  });

  return router;
}

/**
 * Rewards on one of the user's bookings, at checkout. Mounted at
 * /bookings/:reference/rewards after loadSession.
 *
 * GET    what the booking can take and what is applied, with the amount left to pay
 * PUT    apply points and/or credit ({ points, creditAmountMinor, confirm: true });
 *        the server recalculates every limit and amount
 * DELETE give applied rewards back
 */
export function bookingRewardsRouter(
  rewards: RewardsService,
  writeLimiter?: RequestHandler,
): Router {
  const router = Router({ mergeParams: true });
  router.use(noStore, requireAuth);
  const writes: RequestHandler[] = writeLimiter ? [writeLimiter] : [];

  router.get('/', async (req, res) => {
    const { params } = validateRequest(req, { params: bookingParamsSchema, query: noQuery });
    sendData(res, await rewards.bookingRewards(currentUser(res).id, params.reference));
  });

  router.put('/', ...writes, async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: bookingParamsSchema,
      query: noQuery,
      body: applyBookingRewardsSchema,
    });
    sendData(
      res,
      await rewards.applyToBooking(currentUser(res).id, params.reference, body, {
        requestId: requestIdOf(res),
      }),
    );
  });

  router.delete('/', ...writes, async (req, res) => {
    const { params } = validateRequest(req, { params: bookingParamsSchema, query: noQuery });
    sendData(
      res,
      await rewards.removeFromBooking(currentUser(res).id, params.reference, {
        requestId: requestIdOf(res),
      }),
    );
  });

  return router;
}

const userParams = z.object({ userId: z.uuid({ error: 'Not a valid user id.' }) });
const creditParams = z.object({
  reference: z.string().regex(/^WYC-[A-Z0-9]{4}-[A-Z0-9]{4}$/i, 'Not a valid credit reference.'),
});

/**
 * Admin rewards (docs/rewards.md#admin). Mounted inside /admin (after its noStore).
 *
 * GET  /admin/rewards/transactions                 ledger, filtered    admin.rewards.read
 * GET  /admin/rewards/users/:userId                one user's rewards  admin.rewards.read
 * GET  /admin/rewards/rules                        active + history    admin.rewards.read
 * POST /admin/rewards/users/:userId/adjustments    manual points       admin.rewards.manage
 * POST /admin/rewards/users/:userId/credits        issue credit        admin.rewards.manage
 * POST /admin/rewards/credits/:reference/revoke    withdraw credit     admin.rewards.manage
 * POST /admin/rewards/rules                        new rule version    admin.rewards.manage
 *
 * Permissions are checked on the server for every route; every write needs
 * a reason and is audited; nothing here can change a booking or payment.
 */
export function adminRewardsRouter({
  prisma,
  logger,
  rewards,
}: {
  prisma: PrismaClient;
  logger: Logger;
  rewards: RewardsService;
}): Router {
  const router = Router();
  const allow = (permission: AdminPermission): RequestHandler =>
    requirePermission(prisma, logger, permission);
  const ctx = (res: Response) => ({ requestId: requestIdOf(res) });

  router.get('/transactions', allow('admin.rewards.read'), async (req, res) => {
    const { query } = validateRequest(req, { query: adminRewardTransactionsQuerySchema });
    sendData(res, await rewards.adminTransactions(query));
  });

  router.get('/users/:userId', allow('admin.rewards.read'), async (req, res) => {
    const { params } = validateRequest(req, { params: userParams, query: noQuery });
    const view = await rewards.adminUser(params.userId);
    await auditView(prisma, res, 'loyalty_user', params.userId);
    sendData(res, view);
  });

  router.get('/rules', allow('admin.rewards.read'), async (req, res) => {
    validateRequest(req, { query: noQuery });
    sendData(res, await rewards.adminRules());
  });

  router.post('/users/:userId/adjustments', allow('admin.rewards.manage'), async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: userParams,
      query: noQuery,
      body: adminPointsAdjustmentSchema,
    });
    sendData(
      res,
      await rewards.adjustPoints(adminOf(res).user, params.userId, body, ctx(res)),
      201,
    );
  });

  router.post('/users/:userId/credits', allow('admin.rewards.manage'), async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: userParams,
      query: noQuery,
      body: adminIssueCreditSchema,
    });
    sendData(res, await rewards.issueCredit(adminOf(res).user, params.userId, body, ctx(res)), 201);
  });

  router.post('/credits/:reference/revoke', allow('admin.rewards.manage'), async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: creditParams,
      query: noQuery,
      body: adminRevokeCreditSchema,
    });
    sendData(
      res,
      await rewards.revokeCredit(adminOf(res).user, params.reference, body.reason, ctx(res)),
    );
  });

  router.post('/rules', allow('admin.rewards.manage'), async (req, res) => {
    const { body } = validateRequest(req, { query: noQuery, body: adminCreateRulesSchema });
    sendData(res, await rewards.createRules(adminOf(res).user, body, ctx(res)), 201);
  });

  return router;
}
