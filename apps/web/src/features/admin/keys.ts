import { authKeys } from '../auth/AuthProvider';

/**
 * React Query keys for the admin dashboard, under `account`, so signing out
 * (or switching account) drops every cached admin response with the rest of
 * the previous user's data: one person's authorized data is never shown to
 * the next.
 */
const root = [...authKeys.account, 'admin'] as const;
export const adminKeys = {
  all: root,
  me: [...root, 'me'] as const,
  view: (name: string, ...args: unknown[]) => [...root, name, ...args] as const,
};
