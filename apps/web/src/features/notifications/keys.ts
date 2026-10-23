import { authKeys } from '../auth/AuthProvider';

/**
 * React Query keys for notifications, under `account`, so signing out drops
 * them with the rest of the previous user's data.
 */
export const notificationKeys = {
  all: [...authKeys.account, 'notifications'] as const,
  unread: [...authKeys.account, 'notifications', 'unread'] as const,
  lists: [...authKeys.account, 'notifications', 'list'] as const,
  list: (page: number, pageSize: number) =>
    [...authKeys.account, 'notifications', 'list', page, pageSize] as const,
  preferences: [...authKeys.account, 'notifications', 'preferences'] as const,
};
