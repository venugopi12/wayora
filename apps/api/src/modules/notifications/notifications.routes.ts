import { Router, type RequestHandler } from 'express';
import {
  notificationListQuerySchema,
  notificationParamsSchema,
  pushSubscriptionInputSchema,
  pushUnsubscribeSchema,
  updateNotificationPreferencesSchema,
} from '@wayora/contracts';
import { currentUser, noStore, requireAuth, type AuthLocals } from '../../middleware/session.js';
import { sendData } from '../../utils/respond.js';
import { validateRequest } from '../../utils/validate.js';
import type { NotificationsService } from './notifications.service.js';

/**
 * The signed-in user's notifications (docs/notifications.md#api). Mounted at
 * /notifications after loadSession. The recipient is always the session's
 * user; no route takes a user id.
 *
 * GET   /notifications?page=&pageSize=&unread=   newest first, with the unread count
 * GET   /notifications/unread-count
 * PATCH /notifications/:notificationId/read
 * POST  /notifications/read-all
 * GET   /notifications/preferences
 * PATCH /notifications/preferences
 * POST  /notifications/push/subscriptions     this browser turns push on (Phase 30)
 * DELETE /notifications/push/subscriptions    { endpoint } this browser turns push off
 */
export function notificationsRouter(
  notifications: NotificationsService,
  /** Per-user limit on writes (mark read, read all, preferences). */
  writeLimiter?: RequestHandler,
  /** Per-user limit on push subscription changes. */
  pushLimiter?: RequestHandler,
): Router {
  const pushLimit: RequestHandler[] = pushLimiter ? [pushLimiter] : [];
  const limit: RequestHandler[] = writeLimiter ? [writeLimiter] : [];
  const router = Router();
  router.use(noStore, requireAuth);

  router.get('/', async (req, res) => {
    const { query } = validateRequest(req, { query: notificationListQuerySchema });
    sendData(res, await notifications.list(currentUser(res).id, query));
  });

  router.get('/unread-count', async (_req, res) => {
    sendData(res, { unread: await notifications.unreadCount(currentUser(res).id) });
  });

  router.post('/read-all', ...limit, async (_req, res) => {
    sendData(res, await notifications.markAllRead(currentUser(res).id));
  });

  router.get('/preferences', async (_req, res) => {
    sendData(res, await notifications.preferences(currentUser(res).id));
  });

  router.patch('/preferences', ...limit, async (req, res) => {
    const { body } = validateRequest(req, { body: updateNotificationPreferencesSchema });
    sendData(res, await notifications.updatePreferences(currentUser(res).id, body));
  });

  router.post('/push/subscriptions', ...pushLimit, async (req, res) => {
    const { body } = validateRequest(req, { body: pushSubscriptionInputSchema });
    const auth = (res.locals as AuthLocals).auth!;
    sendData(res, await notifications.subscribePush(auth.user.id, auth.session.id, body), 201);
  });

  router.delete('/push/subscriptions', ...pushLimit, async (req, res) => {
    const { body } = validateRequest(req, { body: pushUnsubscribeSchema });
    sendData(res, await notifications.unsubscribePush(currentUser(res).id, body.endpoint));
  });

  router.patch('/:notificationId/read', ...limit, async (req, res) => {
    const { params } = validateRequest(req, { params: notificationParamsSchema });
    sendData(res, await notifications.markRead(currentUser(res).id, params.notificationId));
  });

  return router;
}
