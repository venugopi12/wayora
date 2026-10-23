import {
  markAllReadResponseSchema,
  notificationListResponseSchema,
  notificationPreferencesSchema,
  notificationSchema,
  unreadCountResponseSchema,
  type MarkAllReadResponse,
  type Notification,
  type NotificationListResponse,
  type NotificationPreferences,
  type UpdateNotificationPreferences,
} from '@wayora/contracts';
import { api } from './api';

/*
 * Notifications (docs/notifications.md#api). The recipient is the signed-in
 * user (session cookie); nothing here sends a user id.
 */

export function listNotifications(
  query: { page: number; pageSize: number },
  signal?: AbortSignal,
): Promise<NotificationListResponse> {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  return api.request(`/notifications?${params.toString()}`, {
    schema: notificationListResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

export async function getUnreadCount(signal?: AbortSignal): Promise<number> {
  const { unread } = await api.request('/notifications/unread-count', {
    schema: unreadCountResponseSchema,
    ...(signal ? { signal } : {}),
  });
  return unread;
}

export function markNotificationRead(id: string): Promise<Notification> {
  return api.request(`/notifications/${encodeURIComponent(id)}/read`, {
    method: 'PATCH',
    schema: notificationSchema,
  });
}

export function markAllNotificationsRead(): Promise<MarkAllReadResponse> {
  return api.request('/notifications/read-all', {
    method: 'POST',
    schema: markAllReadResponseSchema,
  });
}

export function getNotificationPreferences(signal?: AbortSignal): Promise<NotificationPreferences> {
  return api.request('/notifications/preferences', {
    schema: notificationPreferencesSchema,
    ...(signal ? { signal } : {}),
  });
}

export function updateNotificationPreferences(
  body: UpdateNotificationPreferences,
): Promise<NotificationPreferences> {
  return api.request('/notifications/preferences', {
    method: 'PATCH',
    body,
    schema: notificationPreferencesSchema,
  });
}
