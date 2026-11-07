import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  adminReviewListQuerySchema,
  adminReviewSubjectsQuerySchema,
  bookingParamsSchema,
  createReviewSchema,
  dismissReportsSchema,
  moderateReviewSchema,
  reportReviewSchema,
  reviewIdParamsSchema,
  reviewListQuerySchema,
  reviewMetricsQuerySchema,
  updateReviewSchema,
} from '@wayora/contracts';
import type { PrismaClient } from '@wayora/database';
import { currentUser, noStore, requireAuth, type AuthLocals } from '../../middleware/session.js';
import type { Logger } from '../../utils/logger.js';
import { sendData } from '../../utils/respond.js';
import { validateRequest } from '../../utils/validate.js';
import { adminOf, requirePermission } from '../admin/access.js';
import type { ReviewsService } from './reviews.service.js';

export interface ReviewsRouterOptions {
  service: ReviewsService;
  /** Per-user limit on writing and editing reviews. */
  writeLimiter?: RequestHandler;
  /** Per-user limit on reports. */
  reportLimiter?: RequestHandler;
  /** Per-user limit on helpful votes. */
  voteLimiter?: RequestHandler;
}

const noQuery = z.object({}).strict();
const pageQuery = z
  .object({
    page: z.coerce.number().int().min(1).max(1000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
const slugParams = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Not a valid destination.'),
});
const ctx = (res: Response) => ({
  requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined,
});
const limit = (h?: RequestHandler) => (h ? [h] : []);

/**
 * Reviews (docs/reviews.md#api). Mounted at /reviews after loadSession.
 *
 * GET    /reviews?type=&key=&sort=&rating=&page=   published reviews + summary (public)
 * GET    /reviews/mine?page=                        your reviews, any status
 * GET    /reviews/mine/:id                          one of yours (for editing)
 * GET    /reviews/bookings                          your hotel/package bookings and their review state
 * GET    /reviews/bookings/:reference               one booking's review state
 * GET    /reviews/destinations/:slug                your feedback about a destination, if any
 * POST   /reviews                                   write one (booking or destination)        201
 * PATCH  /reviews/:id                               edit yours (goes back to moderation)
 * PUT    /reviews/:id/helpful                       mark helpful
 * DELETE /reviews/:id/helpful                       take the vote back
 * POST   /reviews/:id/reports                       report it                                 201
 */
export function reviewsRouter(options: ReviewsRouterOptions): Router {
  const { service } = options;
  const router = Router();
  router.use(noStore);

  router.get('/', async (req, res) => {
    const { query } = validateRequest(req, { query: reviewListQuerySchema });
    const viewerId = (res.locals as AuthLocals).auth?.user.id ?? null;
    sendData(res, await service.list(viewerId, query));
  });

  router.get('/mine', requireAuth, async (req, res) => {
    const { query } = validateRequest(req, { query: pageQuery });
    sendData(res, await service.mine(currentUser(res).id, query.page, query.pageSize));
  });

  router.get('/mine/:id', requireAuth, async (req, res) => {
    const { params } = validateRequest(req, { params: reviewIdParamsSchema, query: noQuery });
    sendData(res, await service.own(currentUser(res).id, params.id));
  });

  router.get('/bookings', requireAuth, async (req, res) => {
    validateRequest(req, { query: noQuery });
    sendData(res, await service.reviewableBookings(currentUser(res).id));
  });

  router.get('/bookings/:reference', requireAuth, async (req, res) => {
    const { params } = validateRequest(req, { params: bookingParamsSchema, query: noQuery });
    sendData(res, await service.bookingReviewState(currentUser(res).id, params.reference));
  });

  router.get('/destinations/:slug', requireAuth, async (req, res) => {
    const { params } = validateRequest(req, { params: slugParams, query: noQuery });
    sendData(res, await service.destinationState(currentUser(res).id, params.slug));
  });

  router.post('/', requireAuth, ...limit(options.writeLimiter), async (req, res) => {
    const { body } = validateRequest(req, { query: noQuery, body: createReviewSchema });
    sendData(res, await service.create(currentUser(res).id, body, ctx(res)), 201);
  });

  router.patch('/:id', requireAuth, ...limit(options.writeLimiter), async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: reviewIdParamsSchema,
      query: noQuery,
      body: updateReviewSchema,
    });
    sendData(res, await service.update(currentUser(res).id, params.id, body, ctx(res)));
  });

  router.put('/:id/helpful', requireAuth, ...limit(options.voteLimiter), async (req, res) => {
    const { params } = validateRequest(req, { params: reviewIdParamsSchema, query: noQuery });
    sendData(res, await service.vote(currentUser(res).id, params.id, true));
  });

  router.delete('/:id/helpful', requireAuth, ...limit(options.voteLimiter), async (req, res) => {
    const { params } = validateRequest(req, { params: reviewIdParamsSchema, query: noQuery });
    sendData(res, await service.vote(currentUser(res).id, params.id, false));
  });

  router.post('/:id/reports', requireAuth, ...limit(options.reportLimiter), async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: reviewIdParamsSchema,
      query: noQuery,
      body: reportReviewSchema,
    });
    sendData(res, await service.report(currentUser(res).id, params.id, body, ctx(res)), 201);
  });

  return router;
}

/**
 * Review moderation and analytics (docs/reviews.md#moderation). Mounted at
 * /admin/reviews. Every route checks its permission on the server; removing
 * also needs admin.reviews.remove (checked in the service), and nobody
 * moderates their own review.
 *
 * GET  /admin/reviews/metrics?range                 reviews.read
 * GET  /admin/reviews/subjects?type=&page=          reviews.read
 * GET  /admin/reviews?status=&type=&reported=&…     reviews.read
 * GET  /admin/reviews/:id                           reviews.read
 * POST /admin/reviews/:id/moderate                  reviews.moderate (+ reviews.remove to remove)
 * POST /admin/reviews/:id/reports/dismiss           reviews.moderate
 */
export function adminReviewsRouter(
  service: ReviewsService,
  prisma: PrismaClient,
  logger: Logger,
): Router {
  const router = Router();
  const read = requirePermission(prisma, logger, 'admin.reviews.read');
  const moderate = requirePermission(prisma, logger, 'admin.reviews.moderate');
  const staff = (res: Response) => {
    const { user, role } = adminOf(res);
    return { id: user.id, role };
  };

  router.get('/metrics', read, async (req, res) => {
    const { query } = validateRequest(req, { query: reviewMetricsQuerySchema });
    sendData(res, await service.metrics(query.range));
  });

  router.get('/subjects', read, async (req, res) => {
    const { query } = validateRequest(req, { query: adminReviewSubjectsQuerySchema });
    sendData(res, await service.subjects(query));
  });

  router.get('/', read, async (req, res) => {
    const { query } = validateRequest(req, { query: adminReviewListQuerySchema });
    sendData(res, await service.adminList(query));
  });

  router.get('/:id', read, async (req, res) => {
    const { params } = validateRequest(req, { params: reviewIdParamsSchema, query: noQuery });
    sendData(res, await service.adminGet(staff(res), params.id));
  });

  router.post('/:id/moderate', moderate, async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: reviewIdParamsSchema,
      query: noQuery,
      body: moderateReviewSchema,
    });
    sendData(res, await service.moderate(staff(res), params.id, body, ctx(res)));
  });

  router.post('/:id/reports/dismiss', moderate, async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: reviewIdParamsSchema,
      query: noQuery,
      body: dismissReportsSchema,
    });
    sendData(res, await service.dismissReports(staff(res), params.id, body, ctx(res)));
  });

  return router;
}
