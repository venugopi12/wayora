import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  analyticsInteractionsSchema,
  type AnalyticsInteractions,
  adminContentListQuerySchema,
  analyticsEventSchema,
  contentInputSchema,
  contentSlugSchema,
  contentStatusChangeSchema,
  contentUpdateSchema,
  publicContentListQuerySchema,
} from '@wayora/contracts';
import type { PrismaClient } from '@wayora/database';
import { noStore } from '../../middleware/session.js';
import type { Logger } from '../../utils/logger.js';
import { sendData } from '../../utils/respond.js';
import { validateRequest } from '../../utils/validate.js';
import { adminOf, requirePermission } from '../admin/access.js';
import type { ContentService } from './content.service.js';

const noQuery = z.object({}).strict();
const slugParams = z.object({ slug: contentSlugSchema });
const idParams = z.object({ id: z.uuid({ error: 'Not a valid content id.' }) });
const ctx = (res: Response) => ({
  requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined,
});
/** Published content changes rarely: let browsers and CDNs keep it briefly. */
const shortCache: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  next();
};

/**
 * Published content (docs/seo.md#api). Public; drafts and archived entries
 * are never returned.
 *
 * GET /content?type=&destination=&page=     published entries (no bodies)
 * GET /content/feed                          every published entry, for the web build
 * GET /content/guides/:slug                  a guide, article or tip
 * GET /content/collections/:slug             an editorial collection
 * GET /content/explore/:slug                 a landing page
 */
export function contentRouter(service: ContentService): Router {
  const router = Router();
  router.use(shortCache);
  router.get('/', async (req, res) => {
    const { query } = validateRequest(req, { query: publicContentListQuerySchema });
    sendData(res, await service.listPublished(query));
  });
  router.get('/feed', async (req, res) => {
    validateRequest(req, { query: noQuery });
    sendData(res, await service.feed());
  });
  for (const section of ['guides', 'collections', 'explore'] as const) {
    router.get(`/${section}/:slug`, async (req, res) => {
      const { params } = validateRequest(req, { params: slugParams, query: noQuery });
      sendData(res, await service.published(section, params.slug));
    });
  }
  return router;
}

/**
 * First-party counts and what they power (docs/seo.md#analytics).
 *
 * POST /analytics/events         { event, key }  → 202 (counted or not; no personal data)
 * POST /analytics/interactions   { events: [...] } → 202 { recorded } (Phase 31, docs/analytics.md#client-events)
 * GET  /discover/popular                          destinations by page views, when there is enough data
 */
export function analyticsRouter(
  service: ContentService,
  limiter?: RequestHandler,
  interactions?: (req: Request, events: AnalyticsInteractions['events']) => Promise<number>,
): Router {
  const router = Router();
  router.use(noStore);
  router.post('/events', ...(limiter ? [limiter] : []), async (req, res) => {
    const { body } = validateRequest(req, { query: noQuery, body: analyticsEventSchema });
    sendData(res, { counted: await service.record(body) }, 202);
  });
  if (interactions) {
    router.post('/interactions', ...(limiter ? [limiter] : []), async (req, res) => {
      const { body } = validateRequest(req, {
        query: noQuery,
        body: analyticsInteractionsSchema,
      });
      sendData(res, { recorded: await interactions(req, body.events) }, 202);
    });
  }
  return router;
}

export function discoverRouter(service: ContentService): Router {
  const router = Router();
  router.use(shortCache);
  router.get('/popular', async (req, res) => {
    validateRequest(req, { query: noQuery });
    sendData(res, await service.popularDestinations());
  });
  return router;
}

/**
 * The content workspace (docs/seo.md#cms-workflow). Mounted at /admin/content.
 *
 * GET   /admin/content?status=&type=&q=&page=   content.read
 * GET   /admin/content/stats?days=              content.read
 * GET   /admin/content/:id                      content.read  (fields, problems, revisions, preview)
 * POST  /admin/content                          content.edit  (a new draft)
 * PATCH /admin/content/:id                      content.edit  (with revision)
 * POST  /admin/content/:id/status               content.publish  { action: publish|archive|restore, revision }
 */
export function adminContentRouter(
  service: ContentService,
  prisma: PrismaClient,
  logger: Logger,
): Router {
  const router = Router();
  const read = requirePermission(prisma, logger, 'admin.content.read');
  const edit = requirePermission(prisma, logger, 'admin.content.edit');
  const publish = requirePermission(prisma, logger, 'admin.content.publish');
  const staff = (res: Response) => {
    const { user, role } = adminOf(res);
    return { id: user.id, role };
  };

  router.get('/', read, async (req, res) => {
    const { query } = validateRequest(req, { query: adminContentListQuerySchema });
    sendData(res, await service.adminList(query));
  });
  router.get('/stats', read, async (req, res) => {
    const { query } = validateRequest(req, {
      query: z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }).strict(),
    });
    sendData(res, await service.stats(query.days));
  });
  router.get('/:id', read, async (req, res) => {
    const { params } = validateRequest(req, { params: idParams, query: noQuery });
    sendData(res, await service.adminGet(staff(res), params.id));
  });
  router.post('/', edit, async (req, res) => {
    const { body } = validateRequest(req, { query: noQuery, body: contentInputSchema });
    sendData(res, await service.create(staff(res), body, ctx(res)), 201);
  });
  router.patch('/:id', edit, async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: idParams,
      query: noQuery,
      body: contentUpdateSchema,
    });
    sendData(res, await service.update(staff(res), params.id, body, ctx(res)));
  });
  router.post('/:id/status', publish, async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: idParams,
      query: noQuery,
      body: contentStatusChangeSchema,
    });
    sendData(res, await service.changeStatus(staff(res), params.id, body, ctx(res)));
  });
  return router;
}
