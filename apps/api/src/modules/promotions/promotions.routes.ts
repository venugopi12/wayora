import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  adminPromotionInputSchema,
  adminPromotionListQuerySchema,
  adminPromotionStatusSchema,
  adminPromotionUpdateSchema,
  adminPromotionUsageQuerySchema,
  applyCouponSchema,
  bookingParamsSchema,
  travelCategorySlugSchema,
  type AdminPermission,
} from '@wayora/contracts';
import type { PrismaClient } from '@wayora/database';
import { currentUser, noStore, requireAuth, type AuthLocals } from '../../middleware/session.js';
import type { Logger } from '../../utils/logger.js';
import { sendData } from '../../utils/respond.js';
import { validateRequest } from '../../utils/validate.js';
import { adminOf, requirePermission } from '../admin/access.js';
import type { PromotionsService } from './promotions.service.js';

const noQuery = z.object({}).strict();
const requestIdOf = (res: Response): string | undefined =>
  typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;

/**
 * GET /promotions?category  active offers running now (listed ones, plus the
 * signed-in customer's personal ones). Public; eligibility is checked at checkout.
 */
export function promotionsRouter(promotions: PromotionsService): Router {
  const router = Router();
  router.use(noStore);
  router.get('/', async (req, res) => {
    const { query } = validateRequest(req, {
      query: z.object({ category: travelCategorySlugSchema.optional() }).strict(),
    });
    const userId = (res.locals as AuthLocals).auth?.user.id ?? null;
    sendData(res, { items: await promotions.offers(userId, query.category) });
  });
  return router;
}

/**
 * The price of one of the customer's bookings. Mounted at
 * /bookings/:reference/pricing after loadSession.
 *
 * GET    /             the authoritative breakdown (original → promotions → points → credit → payable)
 * PUT    /coupon       apply a coupon ({ code }); validated and reserved by the server
 * DELETE /coupon       remove it
 *
 * Coupon writes are rate limited per customer (guessing codes is throttled).
 */
export function bookingPricingRouter(
  promotions: PromotionsService,
  couponLimiter?: RequestHandler,
): Router {
  const router = Router({ mergeParams: true });
  router.use(noStore, requireAuth);
  const limited: RequestHandler[] = couponLimiter ? [couponLimiter] : [];

  router.get('/', async (req, res) => {
    const { params } = validateRequest(req, { params: bookingParamsSchema, query: noQuery });
    sendData(res, await promotions.pricing(currentUser(res).id, params.reference));
  });

  router.put('/coupon', ...limited, async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: bookingParamsSchema,
      query: noQuery,
      body: applyCouponSchema,
    });
    sendData(
      res,
      await promotions.applyCoupon(currentUser(res).id, params.reference, body.code, {
        requestId: requestIdOf(res),
      }),
    );
  });

  router.delete('/coupon', ...limited, async (req, res) => {
    const { params } = validateRequest(req, { params: bookingParamsSchema, query: noQuery });
    sendData(
      res,
      await promotions.removeCoupon(currentUser(res).id, params.reference, {
        requestId: requestIdOf(res),
      }),
    );
  });

  return router;
}

const idParams = z.object({ id: z.uuid({ error: 'Not a valid promotion id.' }) });

/**
 * Admin promotions (docs/promotions.md#admin). Mounted inside /admin.
 *
 * GET   /admin/promotions              list with usage counts     admin.promotions.read
 * GET   /admin/promotions/:id          one, with performance      admin.promotions.read
 * GET   /admin/promotions/:id/usage    its uses (booking refs only) admin.promotions.read
 * POST  /admin/promotions              create                     admin.promotions.manage
 * PATCH /admin/promotions/:id          edit (reason required)     admin.promotions.manage
 * POST  /admin/promotions/:id/status   activate / deactivate      admin.promotions.manage
 */
export function adminPromotionsRouter({
  prisma,
  logger,
  promotions,
}: {
  prisma: PrismaClient;
  logger: Logger;
  promotions: PromotionsService;
}): Router {
  const router = Router();
  const allow = (permission: AdminPermission): RequestHandler =>
    requirePermission(prisma, logger, permission);
  const ctx = (res: Response) => ({ requestId: requestIdOf(res) });

  router.get('/', allow('admin.promotions.read'), async (req, res) => {
    const { query } = validateRequest(req, { query: adminPromotionListQuerySchema });
    sendData(res, await promotions.adminList(query));
  });

  router.get('/:id', allow('admin.promotions.read'), async (req, res) => {
    const { params } = validateRequest(req, { params: idParams, query: noQuery });
    sendData(res, await promotions.adminGet(params.id));
  });

  router.get('/:id/usage', allow('admin.promotions.read'), async (req, res) => {
    const { params, query } = validateRequest(req, {
      params: idParams,
      query: adminPromotionUsageQuerySchema,
    });
    sendData(res, await promotions.adminUsage(params.id, query));
  });

  router.post('/', allow('admin.promotions.manage'), async (req, res) => {
    const { body } = validateRequest(req, { query: noQuery, body: adminPromotionInputSchema });
    sendData(res, await promotions.adminCreate(adminOf(res).user, body, ctx(res)), 201);
  });

  router.patch('/:id', allow('admin.promotions.manage'), async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: idParams,
      query: noQuery,
      body: adminPromotionUpdateSchema.superRefine((v, c) => {
        // The same configuration checks as on create (kind and code stay as they are).
        if (Date.parse(v.endsAt) <= Date.parse(v.startsAt)) {
          c.addIssue({ code: 'custom', path: ['endsAt'], message: 'Must be after the start.' });
        }
        if (v.discountType === 'percentage' && (v.percentBps === undefined || v.amountMinor)) {
          c.addIssue({
            code: 'custom',
            path: ['percentBps'],
            message: 'Give the percentage only.',
          });
        }
        if (
          v.discountType === 'fixed' &&
          (!v.amountMinor || v.percentBps !== undefined || v.maxDiscountMinor)
        ) {
          c.addIssue({ code: 'custom', path: ['amountMinor'], message: 'Give the amount only.' });
        }
        if (v.userId && v.listed) {
          c.addIssue({
            code: 'custom',
            path: ['listed'],
            message: 'Personal offers can’t be listed publicly.',
          });
        }
        if (v.usageLimit !== null && v.perUserLimit !== null && v.perUserLimit > v.usageLimit) {
          c.addIssue({
            code: 'custom',
            path: ['perUserLimit'],
            message: 'Can’t be more than the total limit.',
          });
        }
      }),
    });
    sendData(res, await promotions.adminUpdate(adminOf(res).user, params.id, body, ctx(res)));
  });

  router.post('/:id/status', allow('admin.promotions.manage'), async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: idParams,
      query: noQuery,
      body: adminPromotionStatusSchema,
    });
    sendData(
      res,
      await promotions.adminSetActive(
        adminOf(res).user,
        params.id,
        body.active,
        body.reason,
        ctx(res),
      ),
    );
  });

  return router;
}
