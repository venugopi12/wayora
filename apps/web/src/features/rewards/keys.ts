import { authKeys } from '../auth/AuthProvider';

/** Rewards (Phase 25). Under `account`, so signing out drops them with the rest. */
export const rewardKeys = {
  all: [...authKeys.account, 'rewards'] as const,
  summary: [...authKeys.account, 'rewards', 'summary'] as const,
  history: (kind: string, page: number) =>
    [...authKeys.account, 'rewards', 'history', kind, page] as const,
  booking: (reference: string) => [...authKeys.account, 'rewards', 'booking', reference] as const,
};
