import { authKeys } from '../auth/AuthProvider';

/** Support queries live under `account`: signing out drops them with the rest. */
const root = [...authKeys.account, 'support'] as const;
export const supportKeys = {
  all: root,
  list: (params: object) => [...root, 'list', params] as const,
  lists: [...root, 'list'] as const,
  ticket: (reference: string) => [...root, 'ticket', reference] as const,
  messages: (reference: string) => [...root, 'messages', reference] as const,
};
