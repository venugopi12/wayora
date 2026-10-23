import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  adminAuditListQuerySchema,
  adminBookingListQuerySchema,
  adminPaymentListQuerySchema,
  adminUserListQuerySchema,
  bookingReferenceSchema,
  paymentIdSchema,
  rangeQuerySchema,
  type AdminPermission,
} from '@wayora/contracts';
import type { PrismaClient } from '@wayora/database';
import { noStore } from '../../middleware/session.js';
import { sendData } from '../../utils/respond.js';
import { validateRequest } from '../../utils/validate.js';
import type { Logger } from '../../utils/logger.js';
import { adminOf, auditView, requirePermission } from './access.js';
import type { AdminService } from './admin.service.js';
import type { PlatformHealth } from './platform-health.js';

export interface AdminRouterOptions {
  prisma: PrismaClient;
  service: AdminService;
  health: PlatformHealth;
  logger: Logger;
}

const noQuery = z.object({}).strict();
const userParams = z.object({ userId: z.uuid({ error: 'Not a valid user id.' }) });
const bookingParams = z.object({ reference: bookingReferenceSchema });
const paymentParams = z.object({ paymentId: paymentIdSchema });

/**
 * GET /admin/me                    role and permissions of the signed-in staff member
 * GET /admin/overview?range        platform metrics for a UTC window
 * GET /admin/users[/:userId]       accounts (paginated) and one account
 * GET /admin/bookings[/:reference] bookings (paginated) and one booking
 * GET /admin/payments[/:paymentId] payment attempts (paginated) and one attempt
 * GET /admin/search-analytics      recorded search activity
 * GET /admin/notifications         notification and delivery health
 * GET /admin/audit-logs            audit trail (admins only)
 * GET /admin/health                platform health (worker, queue, outbox)
 *
 * Read-only by design: there are no admin writes (docs/admin.md#scope). Every
 * route checks its permission on the server, answers no-store, and validates
 * its query strictly (unknown parameters are rejected).
 */
export function adminRouter({ prisma, service, health, logger }: AdminRouterOptions): Router {
  const router = Router();
  router.use(noStore);
  const allow = (permission: AdminPermission): RequestHandler =>
    requirePermission(prisma, logger, permission);

  router.get('/me', allow('admin.overview.read'), (req, res) => {
    validateRequest(req, { query: noQuery });
    sendData(res, service.me(adminOf(res).role));
  });

  router.get('/overview', allow('admin.overview.read'), async (req, res) => {
    const { query } = validateRequest(req, { query: rangeQuerySchema });
    sendData(res, await service.overview(query.range));
  });

  router.get('/users', allow('admin.users.read'), async (req, res) => {
    const { query } = validateRequest(req, { query: adminUserListQuerySchema });
    sendData(res, await service.users(query));
  });

  router.get('/users/:userId', allow('admin.users.read'), async (req, res) => {
    const { params } = validateRequest(req, { params: userParams, query: noQuery });
    const user = await service.user(params.userId);
    await auditView(prisma, res, 'user', user.id);
    sendData(res, user);
  });

  router.get('/bookings', allow('admin.bookings.read'), async (req, res) => {
    const { query } = validateRequest(req, { query: adminBookingListQuerySchema });
    sendData(res, await service.bookings(query));
  });

  router.get('/bookings/:reference', allow('admin.bookings.read'), async (req, res) => {
    const { params } = validateRequest(req, { params: bookingParams, query: noQuery });
    const booking = await service.booking(params.reference);
    await auditView(prisma, res, 'booking', booking.reference);
    sendData(res, booking);
  });

  router.get('/payments', allow('admin.payments.read'), async (req, res) => {
    const { query } = validateRequest(req, { query: adminPaymentListQuerySchema });
    sendData(res, await service.payments(query));
  });

  router.get('/payments/:paymentId', allow('admin.payments.read'), async (req, res) => {
    const { params } = validateRequest(req, { params: paymentParams, query: noQuery });
    const payment = await service.payment(params.paymentId);
    await auditView(prisma, res, 'payment', payment.id);
    sendData(res, payment);
  });

  router.get('/search-analytics', allow('admin.search.read'), async (req, res) => {
    const { query } = validateRequest(req, { query: rangeQuerySchema });
    sendData(res, await service.searchAnalytics(query.range));
  });

  router.get('/notifications', allow('admin.notifications.read'), async (req, res) => {
    const { query } = validateRequest(req, { query: rangeQuerySchema });
    sendData(res, await service.notificationHealth(query.range));
  });

  router.get('/audit-logs', allow('admin.audit.read'), async (req, res) => {
    const { query } = validateRequest(req, { query: adminAuditListQuerySchema });
    sendData(res, await service.auditLogs(query));
  });

  router.get('/health', allow('admin.health.read'), async (req, res) => {
    validateRequest(req, { query: noQuery });
    sendData(res, await health.report());
  });

  return router;
}
