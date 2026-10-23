import { Router } from 'express';
import {
  notificationListQuerySchema,
  notificationParamsSchema,
  updateNotificationPreferencesSchema,
} from '@wayora/contracts';
import { currentUser, noStore, requireAuth } from '../../middleware/session.js';
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
 */
export function notificationsRouter(notifications: NotificationsService): Router {
  const router = Router();
  router.use(noStore, requireAuth);

  router.get('/', async (req, res) => {
    const { query } = validateRequest(req, { query: notificationListQuerySchema });
    sendData(res, await notifications.list(currentUser(res).id, query));
  });

  router.get('/unread-count', async (_req, res) => {
    sendData(res, { unread: await notifications.unreadCount(currentUser(res).id) });
  });

  router.post('/read-all', async (_req, res) => {
    sendData(res, await notifications.markAllRead(currentUser(res).id));
  });

  router.get('/preferences', async (_req, res) => {
    sendData(res, await notifications.preferences(currentUser(res).id));
  });

  router.patch('/preferences', async (req, res) => {
    const { body } = validateRequest(req, { body: updateNotificationPreferencesSchema });
    sendData(res, await notifications.updatePreferences(currentUser(res).id, body));
  });

  router.patch('/:notificationId/read', async (req, res) => {
    const { params } = validateRequest(req, { params: notificationParamsSchema });
    sendData(res, await notifications.markRead(currentUser(res).id, params.notificationId));
  });

  return router;
}
