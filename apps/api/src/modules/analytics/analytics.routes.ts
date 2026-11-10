import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  ANALYTICS_REPORT_SCHEMAS,
  analyticsQuerySchema,
  analyticsReportSchema,
  hasPermission,
  type AnalyticsReport,
  type AdminPermission,
  type UserRole,
} from '@wayora/contracts';
import type { PrismaClient } from '@wayora/database';
import { noStore } from '../../middleware/session.js';
import { AppError } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import { sendData } from '../../utils/respond.js';
import { validateRequest } from '../../utils/validate.js';
import { adminOf, requirePermission } from '../admin/access.js';
import type { AnalyticsScope, AnalyticsService } from './analytics.service.js';
import { toCsv } from './csv.js';

/*
 * Staff analytics (docs/analytics.md#api). Mounted at /admin/analytics.
 *
 * GET /admin/analytics/:report?preset=&from=&to=&granularity=        analytics.read
 * GET /admin/analytics/:report/export?…                               analytics.export (audited)
 *
 * `revenue` also needs analytics.financial. Other reports leave out what the
 * viewer's role may not see (money without analytics.financial, support
 * figures without support.read, review figures without reviews.read). The
 * role comes from the session on the server, never from the request.
 */

const reportParams = z.object({ report: analyticsReportSchema });

/** Reports that are only money (need analytics.financial as a whole). */
const FINANCIAL_REPORTS: readonly AnalyticsReport[] = ['revenue'];

export function scopeFor(role: UserRole): AnalyticsScope {
  return {
    financial: hasPermission(role, 'admin.analytics.financial'),
    support: hasPermission(role, 'admin.support.read'),
    reviews: hasPermission(role, 'admin.reviews.read'),
  };
}

const requestIdOf = (res: Response) =>
  typeof res.locals.requestId === 'string' ? res.locals.requestId : null;

export function adminAnalyticsRouter(
  service: AnalyticsService,
  prisma: PrismaClient,
  logger: Logger,
): Router {
  const router = Router();
  router.use(noStore);
  const allow = (permission: AdminPermission): RequestHandler =>
    requirePermission(prisma, logger, permission);

  /** 403 (audited like any denial) when a money-only report is asked for without access. */
  const financialGate: RequestHandler = (req, res, next) => {
    const parsed = reportParams.safeParse(req.params);
    if (parsed.success && FINANCIAL_REPORTS.includes(parsed.data.report)) {
      return allow('admin.analytics.financial')(req, res, next);
    }
    next();
  };

  router.get('/:report', allow('admin.analytics.read'), financialGate, async (req, res) => {
    const { params, query } = validateRequest(req, {
      params: reportParams,
      query: analyticsQuerySchema,
    });
    const { role } = adminOf(res);
    const data = await service.report(params.report, query, scopeFor(role));
    sendData(res, ANALYTICS_REPORT_SCHEMAS[params.report].parse(data));
  });

  router.get(
    '/:report/export',
    allow('admin.analytics.read'),
    allow('admin.analytics.export'),
    financialGate,
    async (req, res) => {
      const { params, query } = validateRequest(req, {
        params: reportParams,
        query: analyticsQuerySchema,
      });
      const { user, role } = adminOf(res);
      const data = await service.report(params.report, query, scopeFor(role));
      const csv = toCsv(params.report, data);
      const meta = data as { period: { from: string; to: string } };
      // Exports are audited: who, which report, which period and filters. No figures.
      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: user.id,
          action: 'admin.analytics_exported',
          entityType: 'analytics_report',
          entityId: params.report,
          requestId: requestIdOf(res),
          metadata: {
            role,
            preset: query.preset ?? 'last_30_days',
            from: meta.period.from,
            to: meta.period.to,
            granularity: query.granularity ?? null,
            timezone: service.timezone,
          },
        },
      });
      const name = `wayora-${params.report}-${meta.period.from}-to-${meta.period.to}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      res.status(200).send(csv);
    },
  );

  router.use((_req, _res, next) => next(new AppError('NOT_FOUND', 'There is no such report.')));
  return router;
}
