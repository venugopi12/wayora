import { ACCOUNT_PATHS } from '../navigation/config';

/** The travel assistant (Phase 21): new conversation, or one conversation. */
export const ASSISTANT_PATH = ACCOUNT_PATHS.assistant;
export const assistantPath = (conversationId: string) =>
  `${ACCOUNT_PATHS.assistant}/${encodeURIComponent(conversationId)}`;
/** A new conversation about one plan. */
export const assistantForPlanPath = (tripId: string) =>
  `${ACCOUNT_PATHS.assistant}?trip=${encodeURIComponent(tripId)}`;
