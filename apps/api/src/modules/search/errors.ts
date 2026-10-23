import type { ProviderOutcome, ProviderStatus } from '@wayora/contracts';
import { AppError } from '../../utils/errors.js';
import { ProviderError } from '../providers/provider.js';
import { TimeoutError } from './concurrency.js';
import { CircuitOpenError } from './resilience.js';

/*
 * The single place where provider and storage failures become what clients
 * see (docs/search.md#errors). Clients get stable codes and Wayora's own
 * wording; supplier messages, response bodies, URLs, credentials and
 * Redis/database details stay on the server, and even there they are
 * scrubbed before logging.
 */

type FailedOutcome = Exclude<ProviderOutcome, 'success' | 'empty'>;

/** Fixed, user-facing text per provider outcome (shown in provider statuses). */
export const PROVIDER_STATUS_MESSAGES: Record<FailedOutcome | 'invalid', string> = {
  timeout: 'This provider took too long to answer.',
  unavailable: 'This provider is unavailable right now.',
  error: 'This provider could not complete the search.',
  invalid: 'This provider returned results Wayora could not use.',
};

/** How a failed provider call is reported. */
export function outcomeOf(error: unknown): FailedOutcome {
  if (error instanceof TimeoutError) return 'timeout';
  if (error instanceof CircuitOpenError) return 'unavailable';
  if (error instanceof ProviderError) return error.kind;
  return 'error';
}

/** The error for a search where no provider answered, by what went wrong. */
export function searchFailedError(
  categoryName: string,
  statuses: readonly ProviderStatus[],
): AppError {
  const outcomes = new Set(statuses.map((s) => s.status));
  const lower = categoryName.toLowerCase();
  if (outcomes.size === 1 && outcomes.has('timeout')) {
    return new AppError(
      'PROVIDER_TIMEOUT',
      `${categoryName} providers took too long to answer. Please try again.`,
    );
  }
  if (outcomes.size === 1 && outcomes.has('unavailable')) {
    return new AppError(
      'PROVIDER_UNAVAILABLE',
      `${categoryName} providers are unavailable right now. Please try again in a few minutes.`,
    );
  }
  return new AppError(
    'SEARCH_FAILED',
    `We couldn't search ${lower} right now. Please try again in a moment.`,
  );
}

/** The error for an offer check (revalidation) that failed. */
export function revalidationFailedError(outcome: FailedOutcome | 'invalid'): AppError {
  if (outcome === 'timeout') {
    return new AppError(
      'PROVIDER_TIMEOUT',
      "The provider didn't confirm this offer in time. Please try again.",
    );
  }
  return new AppError(
    'PROVIDER_UNAVAILABLE',
    "We couldn't check this offer with the provider right now. Please try again in a few minutes.",
  );
}

export const STORE_UNAVAILABLE_MESSAGE =
  'Search is temporarily unavailable. Please try again in a moment.';

// Log scrubbing lives in utils/log-safety.ts (shared by every module).
export { errorForLog, scrub } from '../../utils/log-safety.js';
