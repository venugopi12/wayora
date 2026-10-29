import type { PlannerInterest } from '@wayora/contracts';
import { authKeys } from '../auth/AuthProvider';

/**
 * React Query keys for the trip planner, under `account` so signing out drops
 * every cached plan with the rest of the previous user's data.
 */
export const plannerKeys = {
  all: [...authKeys.account, 'planner'] as const,
  destinations: [...authKeys.account, 'planner', 'destinations'] as const,
  lists: [...authKeys.account, 'planner', 'list'] as const,
  list: (page: number) => [...authKeys.account, 'planner', 'list', page] as const,
  detail: (id: string) => [...authKeys.account, 'planner', 'trip', id] as const,
  suggestions: (id: string) => [...authKeys.account, 'planner', 'suggestions', id] as const,
  suggestionsFor: (id: string, category: PlannerInterest | null) =>
    [...authKeys.account, 'planner', 'suggestions', id, category ?? 'all'] as const,
  /** Collaboration (Phase 19). */
  members: (id: string) => [...authKeys.account, 'planner', 'members', id] as const,
  activity: (id: string) => [...authKeys.account, 'planner', 'activity', id] as const,
  invitations: [...authKeys.account, 'planner', 'invitations'] as const,
  invitation: (id: string) => [...authKeys.account, 'planner', 'invitations', id] as const,
};
