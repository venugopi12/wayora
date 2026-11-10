import {
  DEFAULT_SORT,
  type ProviderStatus,
  type SearchRequest,
  type SearchServiceType,
} from '@wayora/contracts';
import type { PrismaClient, SearchOutcome } from '@wayora/database';
import { CATEGORY } from '../../utils/categories.js';
import type { Logger } from '../../utils/logger.js';
import { errorForLog } from './errors.js';

/**
 * Search analytics (Phase 15, docs/admin.md#search-activity; extended in
 * Phase 31, docs/analytics.md#search-events).
 *
 * One row per search request, recorded after it answers: category, outcome,
 * timing and which providers were called, and since Phase 31 the catalogue
 * places searched (airports, stations, cities: never an address), the month
 * of travel (never the date), and the names of the filters and sort used
 * (never their values). Deliberately nothing about who searched: no user,
 * IP, travellers, names or request body. Search sessions in Redis expire,
 * so this table is the only history; reports say where it begins.
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
  providers: { id: string; status: string; durationMs: number; attempts?: number }[];
  /** What was searched, coarsely (Phase 31). */
  details?: SearchDetails;
}

export interface SearchDetails {
  originPlace: string | null;
  destinationPlace: string | null;
  /** YYYY-MM-01 of the travel date. */
  travelMonth: string | null;
  filterKeys: string[];
  /** The sort, only when it isn't the category's default. */
  sort: string | null;
  reused: boolean;
}

/** The coarse, non-identifying details of a search request (docs/analytics.md#search-events). */
export function searchDetails(request: SearchRequest, reused: boolean): SearchDetails {
  const r = request as Record<string, unknown>;
  const place = (k: string) => (typeof r[k] === 'string' ? (r[k] as string).slice(0, 80) : null);
  const dateField = ['departureDate', 'checkIn', 'pickupAt'].find((k) => typeof r[k] === 'string');
  const date = dateField ? (r[dateField] as string) : null;
  const filters = (r.filters ?? {}) as Record<string, unknown>;
  const sortBy = typeof r.sortBy === 'string' ? r.sortBy : null;
  return {
    originPlace: place('origin') ?? place('pickup'),
    destinationPlace: place('destination') ?? place('dropoff'),
    travelMonth: date && /^\d{4}-\d{2}/.test(date) ? `${date.slice(0, 7)}-01` : null,
    filterKeys: Object.entries(filters)
      .filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0))
      .map(([k]) => k.slice(0, 40))
      .sort()
      .slice(0, 20),
    sort: sortBy && sortBy !== DEFAULT_SORT[request.serviceType] ? sortBy.slice(0, 40) : null,
    reused,
  };
}

export type SearchEventRecorder = (event: SearchEventRecord) => void;

/** Outcome of a search that answered. */
export function outcomeFor(statuses: readonly ProviderStatus[], matched: number): SearchOutcome {
  if (matched === 0) return 'EMPTY';
  const allAnswered = statuses.every((s) => s.status === 'success' || s.status === 'empty');
  return allAnswered ? 'SUCCESS' : 'PARTIAL';
}

/** Per-provider call records: id, normalized outcome, duration and attempts (no payloads). */
export const providerCalls = (
  statuses: readonly ProviderStatus[],
  attempts: ReadonlyMap<string, number> = new Map(),
) =>
  statuses.map((s) => ({
    id: s.providerId,
    status: s.status,
    durationMs: s.durationMs,
    ...(attempts.has(s.providerId) ? { attempts: attempts.get(s.providerId)! } : {}),
  }));

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
          ...(event.details
            ? {
                originPlace: event.details.originPlace,
                destinationPlace: event.details.destinationPlace,
                travelMonth: event.details.travelMonth
                  ? new Date(`${event.details.travelMonth}T00:00:00Z`)
                  : null,
                filterKeys: event.details.filterKeys,
                sort: event.details.sort,
                reused: event.details.reused,
              }
            : {}),
          createdAt: now(),
        },
      })
      .catch((err: unknown) =>
        log.warn({ err: errorForLog(err) }, 'Could not record a search event'),
      );
  };
}
