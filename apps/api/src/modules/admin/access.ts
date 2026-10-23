import type { RequestHandler, Response } from 'express';
import { hasPermission, type AdminPermission, type UserRole } from '@wayora/contracts';
import type { PrismaClient, UserModel as User } from '@wayora/database';
import type { AuthLocals } from '../../middleware/session.js';
import { AppError } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import { toUserRole } from '../auth/safe-user.js';

/*
 * Admin authorization (docs/admin.md#roles-and-permissions).
 *
 * The role comes only from the user row the session middleware loaded from
 * the database on this request (sessions.resolve: active, unexpired,
 * unrevoked, user ACTIVE). Nothing in the request — body, query, headers or
 * client state — can name a role, user id or permission. Every admin route
 * goes through `requirePermission`; hiding links in the web app is
 * presentation only.
 */

export interface AdminLocals extends AuthLocals {
  admin?: { user: User; role: UserRole };
}

export const FORBIDDEN_MESSAGE = 'You don’t have access to this.';

/** The authorized staff member. Only call after `requirePermission`. */
export function adminOf(res: Response): { user: User; role: UserRole } {
  const admin = (res.locals as AdminLocals).admin;
  if (!admin) throw new AppError('FORBIDDEN', FORBIDDEN_MESSAGE);
  return admin;
}

const requestIdOf = (res: Response) =>
  typeof res.locals.requestId === 'string' ? res.locals.requestId : null;

/**
 * 401 without a session; 403 (audited as `admin.access_denied`) when the
 * signed-in user's role lacks the permission.
 */
export function requirePermission(
  prisma: PrismaClient,
  logger: Logger,
  permission: AdminPermission,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const locals = res.locals as AdminLocals;
      const user = locals.auth?.user;
      if (!user) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
      const role = toUserRole(user.role);
      if (user.status !== 'ACTIVE' || !hasPermission(role, permission)) {
        await prisma.auditLog
          .create({
            data: {
              actorType: role === 'user' ? 'USER' : 'ADMIN',
              actorId: user.id,
              action: 'admin.access_denied',
              entityType: 'admin_permission',
              entityId: permission,
              requestId: requestIdOf(res),
              // The route pattern, never the query string (it may hold search text).
              metadata: {
                method: req.method,
                path: req.baseUrl + (req.route?.path ?? req.path),
                role,
              },
            },
          })
          .catch((err: unknown) =>
            logger.warn({ err: { message: (err as Error).message } }, 'Could not audit a denial'),
          );
        throw new AppError('FORBIDDEN', FORBIDDEN_MESSAGE);
      }
      locals.admin = { user, role };
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Records a staff read of one customer record (`admin.<entity>_viewed`). */
export async function auditView(
  prisma: PrismaClient,
  res: Response,
  entity: 'user' | 'booking' | 'payment',
  entityId: string,
): Promise<void> {
  const { user, role } = adminOf(res);
  await prisma.auditLog.create({
    data: {
      actorType: 'ADMIN',
      actorId: user.id,
      action: `admin.${entity}_viewed`,
      entityType: entity,
      entityId,
      requestId: requestIdOf(res),
      metadata: { role },
    },
  });
}
