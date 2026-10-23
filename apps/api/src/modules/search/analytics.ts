import type { ProviderStatus, SearchServiceType } from '@wayora/contracts';
import type { PrismaClient, SearchOutcome } from '@wayora/database';
import { CATEGORY } from '../../utils/categories.js';
import type { Logger } from '../../utils/logger.js';
import { errorForLog } from './errors.js';

/**
 * Search analytics (Phase 15, docs/admin.md#search-activity).
 *
 * One row per search request, recorded after it answers: category, outcome,
 * timing and which providers were called. Deliberately nothing about who
 * searched or what for: no user, IP, route, dates, names or request body.
 * Search sessions in Redis expire, so this table is the only history; it
 * starts empty when Phase 15 is deployed, and the admin views say so.
 */
export interface SearchEventRecord {
  serviceType: SearchServiceType;
  outcome: SearchOutcome;
  /** The session the results came from (links to bookings.search_id); null when it failed. */
  searchId: string | null;
  /** Matching results returned. */
  resultCount: number;
  durationMs: number;
  /** Error code when the search failed. */
  errorCode: string | null;
  /** Provider calls made for this request (none when an earlier session was reused). */
  providers: { id: string; status: string; durationMs: number }[];
}

export type SearchEventRecorder = (event: SearchEventRecord) => void;

/** Outcome of a search that answered. */
export function outcomeFor(statuses: readonly ProviderStatus[], matched: number): SearchOutcome {
  if (matched === 0) return 'EMPTY';
  const allAnswered = statuses.every((s) => s.status === 'success' || s.status === 'empty');
  return allAnswered ? 'SUCCESS' : 'PARTIAL';
}

export const providerCalls = (statuses: readonly ProviderStatus[]) =>
  statuses.map((s) => ({ id: s.providerId, status: s.status, durationMs: s.durationMs }));

/**
 * Writes events to `search_events`, best-effort and off the request path: a
 * failed write is logged and never fails or slows the search.
 */
export function prismaSearchEventRecorder(
  prisma: PrismaClient,
  logger: Logger,
  now: () => Date = () => new Date(),
): SearchEventRecorder {
  const log = logger.child({ component: 'search-analytics' });
  return (event) => {
    void prisma.searchEvent
      .create({
        data: {
          category: CATEGORY[event.serviceType],
          outcome: event.outcome,
          searchId: event.searchId,
          resultCount: Math.max(0, Math.round(event.resultCount)),
          durationMs: Math.max(0, Math.round(event.durationMs)),
          errorCode:
            event.outcome === 'FAILED' ? (event.errorCode ?? 'UNKNOWN').slice(0, 64) : null,
          providers: event.providers,
          createdAt: now(),
        },
      })
      .catch((err: unknown) =>
        log.warn({ err: errorForLog(err) }, 'Could not record a search event'),
      );
  };
}
