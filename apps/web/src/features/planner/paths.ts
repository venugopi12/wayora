import { ACCOUNT_PATHS } from '../navigation/config';

/** Trip planner pages (Phase 18). */
export const PLANS_PATH = ACCOUNT_PATHS.plans;
export const NEW_PLAN_PATH = `${ACCOUNT_PATHS.plans}/new`;
export const planPath = (id: string) => `${ACCOUNT_PATHS.plans}/${encodeURIComponent(id)}`;
/** Start a new plan, optionally with a sample destination chosen. */
export const newPlanPath = (destinationId?: string) =>
  destinationId
    ? `${NEW_PLAN_PATH}?destination=${encodeURIComponent(destinationId)}`
    : NEW_PLAN_PATH;
