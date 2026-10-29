import { authKeys } from '../auth/AuthProvider';

/** React Query keys for the travel assistant, under `account` (dropped on sign-out). */
export const assistantKeys = {
  all: [...authKeys.account, 'assistant'] as const,
  status: [...authKeys.account, 'assistant', 'status'] as const,
  lists: [...authKeys.account, 'assistant', 'list'] as const,
  conversation: (id: string) => [...authKeys.account, 'assistant', 'conversation', id] as const,
  tripContext: (tripId: string) => [...authKeys.account, 'assistant', 'context', tripId] as const,
};
