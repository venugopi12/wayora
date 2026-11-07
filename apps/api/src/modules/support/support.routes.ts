import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  adminSupportAssignSchema,
  adminSupportEscalateSchema,
  adminSupportListQuerySchema,
  adminSupportPrioritySchema,
  adminSupportReplySchema,
  adminSupportStatusSchema,
  closeSupportTicketSchema,
  createSupportTicketSchema,
  hasPermission,
  supportAiRequestSchema,
  supportListQuerySchema,
  supportMessageInputSchema,
  supportMessagesQuerySchema,
  supportMetricsQuerySchema,
  supportParamsSchema,
  type AdminPermission,
  type UserRole,
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
import { toUserRole } from '../auth/safe-user.js';
import { adminOf, requirePermission } from '../admin/access.js';
import type { SupportService, StaffUser } from './support.service.js';

/** pg_notify channels (see the migration): everything, and customer-visible entries only. */
export const SUPPORT_STAFF_CHANNEL = 'wayora_support_staff';
export const SUPPORT_CUSTOMER_CHANNEL = 'wayora_support_customer';

export interface SupportRouterOptions {
  service: SupportService;
  prisma: PrismaClient;
  logger: Logger;
  /** Live updates (customer-visible announcements / all announcements). */
  customerHub: SignalHub;
  staffHub: SignalHub;
  sessionValid: (token: string | undefined) => Promise<boolean>;
  /** Per-customer limit on new tickets. */
  ticketLimiter?: RequestHandler;
  /** Per-user limit on messages (customers and staff). */
  messageLimiter?: RequestHandler;
  /** Per-staff limit on AI suggestions. */
  aiLimiter?: RequestHandler;
  stream?: Partial<StreamTimings>;
}

const noQuery = z.object({}).strict();
const readSchema = z.object({ seq: z.number().int().min(0) }).strict();
const requestIdOf = (res: Response) =>
  typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;

const refuseQuery = (query: object) => {
  if (Object.keys(query).length > 0) {
    throw new AppError('VALIDATION_FAILED', 'The request is invalid.', {
      details: [
        { path: 'query', message: 'This endpoint takes no parameters.', code: 'unrecognized_keys' },
      ],
    });
  }
};

/**
 * The signed-in customer's own tickets (docs/support.md#api). Mounted at
 * /support after loadSession. No route takes a user id: ownership comes from
 * the session, and another customer's ticket is a 404.
 *
 * GET  /support/tickets?view=&booking=&page=          list
 * POST /support/tickets                               open one (clientKey: retries are safe)  201
 * GET  /support/tickets/:reference                    ticket, booking context, status history
 * GET  /support/tickets/:reference/messages?before=   conversation (public messages only)
 * POST /support/tickets/:reference/messages           reply (clientKey)
 * POST /support/tickets/:reference/read               { seq }: mark support replies read
 * POST /support/tickets/:reference/close              close it ("I no longer need help")
 * GET  /support/tickets/:reference/events             live updates (Server-Sent Events)
 */
export function supportRouter(options: SupportRouterOptions): Router {
  const { service, customerHub, logger } = options;
  const timings = { ...DEFAULT_STREAM_TIMINGS, ...options.stream };
  const openStreams = new StreamCounter(timings.maxPerUser);
  const ticketLimit = options.ticketLimiter ? [options.ticketLimiter] : [];
  const messageLimit = options.messageLimiter ? [options.messageLimiter] : [];
  const router = Router();
  router.use(noStore, requireAuth);
  const ctx = (res: Response) => ({ requestId: requestIdOf(res) });

  router.get('/tickets', async (req, res) => {
    const { query } = validateRequest(req, { query: supportListQuerySchema });
    sendData(res, await service.list(currentUser(res).id, query));
  });

  router.post('/tickets', ...ticketLimit, async (req, res) => {
    const { body } = validateRequest(req, { query: noQuery, body: createSupportTicketSchema });
    const user = currentUser(res);
    sendData(res, await service.create({ id: user.id }, body, ctx(res)), 201);
  });

  router.get('/tickets/:reference', async (req, res) => {
    const { params } = validateRequest(req, { params: supportParamsSchema, query: noQuery });
    sendData(res, await service.get(currentUser(res).id, params.reference));
  });

  router.get('/tickets/:reference/messages', async (req, res) => {
    const { params, query } = validateRequest(req, {
      params: supportParamsSchema,
      query: supportMessagesQuerySchema,
    });
    sendData(res, await service.messages(currentUser(res).id, params.reference, query));
  });

  router.post('/tickets/:reference/messages', ...messageLimit, async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: supportParamsSchema,
      query: noQuery,
      body: supportMessageInputSchema,
    });
    sendData(res, await service.reply(currentUser(res), params.reference, body, ctx(res)));
  });

  router.post('/tickets/:reference/read', async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: supportParamsSchema,
      query: noQuery,
      body: readSchema,
    });
    sendData(res, await service.markRead(currentUser(res).id, params.reference, body.seq));
  });

  router.post('/tickets/:reference/close', async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: supportParamsSchema,
      query: noQuery,
      body: closeSupportTicketSchema,
    });
    sendData(res, await service.close(currentUser(res), params.reference, body.reason, ctx(res)));
  });

  // Live updates: "the ticket changed, sequence N" (customer-visible changes only).
  router.get('/tickets/:reference/events', async (req, res) => {
    const { params } = validateRequest(req, { params: supportParamsSchema });
    refuseQuery(req.query);
    const user = currentUser(res);
    const ticket = await options.prisma.supportTicket.findFirst({
      where: { reference: params.reference, userId: user.id },
      select: { id: true },
    });
    if (!ticket) throw new AppError('NOT_FOUND', "We couldn't find that ticket.");
    if (!openStreams.take(user.id)) {
      throw new AppError(
        'RATE_LIMITED',
        'Too many open live-update connections. Close a tab and try again.',
      );
    }
    const token = (res.locals as AuthLocals).sessionToken;
    serveSignalStream(res, {
      hub: customerHub,
      key: ticket.id,
      eventName: 'ticket-changed',
      payload: (seq) => ({ seq: Number(seq), reference: params.reference }),
      lastEventId: req.get('Last-Event-ID'),
      latest: async () => {
        const last = await options.prisma.supportTicketEvent.findFirst({
          where: { ticketId: ticket.id, internal: false },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        });
        return last ? String(last.seq) : null;
      },
      check: async () => ((await options.sessionValid(token)) ? 'ok' : 'signed-out'),
      timings,
      logger,
      onClose: () => openStreams.release(user.id),
    });
  });

  return router;
}

/**
 * The support workspace (docs/support.md#agent-workspace). Mounted at
 * /admin/support. Every route checks its permission on the server.
 *
 * GET  /admin/support/metrics?range                    support.read
 * GET  /admin/support/staff                            support.read   (assignable people; names only)
 * GET  /admin/support/tickets?view=&status=&…          support.read   (server-side filters, pagination)
 * GET  /admin/support/tickets/:reference               support.read   (audited view)
 * GET  /admin/support/tickets/:reference/messages      support.read   (includes internal notes)
 * POST /admin/support/tickets/:reference/messages      support.manage (reply or internal note)
 * POST /admin/support/tickets/:reference/status        support.manage
 * POST /admin/support/tickets/:reference/assign        support.manage (others: support.supervise)
 * POST /admin/support/tickets/:reference/escalate      support.manage (de-escalate: support.supervise)
 * POST /admin/support/tickets/:reference/priority      support.manage
 * POST /admin/support/tickets/:reference/read          support.read
 * POST /admin/support/tickets/:reference/ai            support.manage (a suggestion; nothing is sent)
 * GET  /admin/support/tickets/:reference/events        support.read   (live updates)
 */
export function adminSupportRouter(options: SupportRouterOptions): Router {
  const { service, prisma, logger, staffHub } = options;
  const timings = { ...DEFAULT_STREAM_TIMINGS, ...options.stream };
  const openStreams = new StreamCounter(timings.maxPerUser);
  const messageLimit = options.messageLimiter ? [options.messageLimiter] : [];
  const aiLimit = options.aiLimiter ? [options.aiLimiter] : [];
  const router = Router();
  const allow = (permission: AdminPermission): RequestHandler =>
    requirePermission(prisma, logger, permission);
  const ctx = (res: Response) => ({ requestId: requestIdOf(res) });
  const staff = (res: Response): StaffUser => {
    const { user, role } = adminOf(res);
    return { id: user.id, role, name: user.displayName ?? '' };
  };

  router.get('/metrics', allow('admin.support.read'), async (req, res) => {
    const { query } = validateRequest(req, { query: supportMetricsQuerySchema });
    sendData(res, await service.metrics(query.range));
  });

  router.get('/staff', allow('admin.support.read'), async (req, res) => {
    validateRequest(req, { query: noQuery });
    sendData(res, { items: await service.staff() });
  });

  router.get('/tickets', allow('admin.support.read'), async (req, res) => {
    const { query } = validateRequest(req, { query: adminSupportListQuerySchema });
    sendData(res, await service.adminList(staff(res), query));
  });

  router.get('/tickets/:reference', allow('admin.support.read'), async (req, res) => {
    const { params } = validateRequest(req, { params: supportParamsSchema, query: noQuery });
    sendData(res, await service.adminGet(staff(res), params.reference, ctx(res)));
  });

  router.get('/tickets/:reference/messages', allow('admin.support.read'), async (req, res) => {
    const { params, query } = validateRequest(req, {
      params: supportParamsSchema,
      query: supportMessagesQuerySchema,
    });
    sendData(res, await service.adminMessages(params.reference, query));
  });

  router.post(
    '/tickets/:reference/messages',
    allow('admin.support.manage'),
    ...messageLimit,
    async (req, res) => {
      const { params, body } = validateRequest(req, {
        params: supportParamsSchema,
        query: noQuery,
        body: adminSupportReplySchema,
      });
      sendData(res, await service.adminReply(staff(res), params.reference, body, ctx(res)));
    },
  );

  router.post('/tickets/:reference/status', allow('admin.support.manage'), async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: supportParamsSchema,
      query: noQuery,
      body: adminSupportStatusSchema,
    });
    sendData(res, await service.adminStatus(staff(res), params.reference, body, ctx(res)));
  });

  router.post('/tickets/:reference/assign', allow('admin.support.manage'), async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: supportParamsSchema,
      query: noQuery,
      body: adminSupportAssignSchema,
    });
    sendData(res, await service.adminAssign(staff(res), params.reference, body, ctx(res)));
  });

  router.post('/tickets/:reference/escalate', allow('admin.support.manage'), async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: supportParamsSchema,
      query: noQuery,
      body: adminSupportEscalateSchema,
    });
    sendData(res, await service.adminEscalate(staff(res), params.reference, body, ctx(res)));
  });

  router.post('/tickets/:reference/priority', allow('admin.support.manage'), async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: supportParamsSchema,
      query: noQuery,
      body: adminSupportPrioritySchema,
    });
    sendData(res, await service.adminPriority(staff(res), params.reference, body, ctx(res)));
  });

  router.post('/tickets/:reference/read', allow('admin.support.read'), async (req, res) => {
    const { params, body } = validateRequest(req, {
      params: supportParamsSchema,
      query: noQuery,
      body: readSchema,
    });
    await service.adminMarkRead(params.reference, body.seq);
    sendData(res, { ok: true });
  });

  router.post(
    '/tickets/:reference/ai',
    allow('admin.support.manage'),
    ...aiLimit,
    async (req, res) => {
      const { params, body } = validateRequest(req, {
        params: supportParamsSchema,
        query: noQuery,
        body: supportAiRequestSchema,
      });
      sendData(res, await service.aiSuggestion(staff(res), params.reference, body.kind, ctx(res)));
    },
  );

  router.get('/tickets/:reference/events', allow('admin.support.read'), async (req, res) => {
    const { params } = validateRequest(req, { params: supportParamsSchema });
    refuseQuery(req.query);
    const viewer = staff(res);
    const ticket = await prisma.supportTicket.findUnique({
      where: { reference: params.reference },
      select: { id: true },
    });
    if (!ticket) throw new AppError('NOT_FOUND', "We couldn't find that ticket.");
    if (!openStreams.take(viewer.id)) {
      throw new AppError(
        'RATE_LIMITED',
        'Too many open live-update connections. Close a tab and try again.',
      );
    }
    const token = (res.locals as AuthLocals).sessionToken;
    serveSignalStream(res, {
      hub: staffHub,
      key: ticket.id,
      eventName: 'ticket-changed',
      payload: (seq) => ({ seq: Number(seq), reference: params.reference }),
      lastEventId: req.get('Last-Event-ID'),
      latest: async () => {
        const t = await prisma.supportTicket.findUnique({
          where: { id: ticket.id },
          select: { revision: true },
        });
        return t && t.revision > 0 ? String(t.revision) : null;
      },
      // Staff access can be withdrawn at any time: the role is re-read from the database.
      check: async () => {
        if (!(await options.sessionValid(token))) return 'signed-out';
        const u = await prisma.user.findUnique({
          where: { id: viewer.id },
          select: { role: true, status: true },
        });
        const role: UserRole = u ? toUserRole(u.role) : 'user';
        return u?.status === 'ACTIVE' && hasPermission(role, 'admin.support.read')
          ? 'ok'
          : 'access-ended';
      },
      checkBeforeEachEvent: true,
      timings,
      logger,
      onClose: () => openStreams.release(viewer.id),
    });
  });

  return router;
}
