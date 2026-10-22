import type {
  ProviderKind,
  ProviderOperation,
  SearchPrice,
  SearchRequest,
  SearchRequestFor,
  SearchResult,
  SearchResultFor,
  SearchServiceType,
} from '@wayora/contracts';

/*
 * Provider adapter interface (docs/search.md#adapters).
 *
 * An adapter translates between Wayora's normalized contracts and one
 * supplier: it receives a validated SearchRequest and returns results in the
 * shared result shape. Supplier formats, credentials and endpoints stay inside
 * the adapter. The search service never sees them, and it re-validates every
 * result an adapter returns.
 */

export interface ProviderSearchContext {
  /** Aborted when the provider's time limit passes or the client goes away. Pass it to outbound requests. */
  signal: AbortSignal;
  /** Clock for timestamps such as `validUntil` (injectable for tests). */
  now: Date;
}

/**
 * A result as an adapter returns it: the normalized shape, plus an optional
 * key that identifies the same underlying offer across providers (e.g. a
 * flight's carrier, flight numbers and departure times). Leave it out when no
 * reliable key exists: results are then never merged.
 */
export type ProviderResult<S extends SearchServiceType = SearchServiceType> = SearchResultFor<S> & {
  dedupeKey?: string;
};

export interface ProviderSearchOutput {
  /** Typed for adapters; the search service still validates each entry at runtime. */
  results: readonly ProviderResult[];
}

export type OperationSupport = Record<ProviderOperation, 'supported' | 'unsupported'>;

/**
 * A provider's current answer for one offer (docs/search.md#provider-revalidation).
 * `price` is the price the supplier quotes now, in the offer's currency.
 */
export type RevalidationOutcome =
  { status: 'available'; price: SearchPrice | null } | { status: 'unavailable' };

export interface SearchProvider {
  /** Stable identifier, used in result ids and logs. Never change it once live. */
  readonly id: string;
  readonly name: string;
  /** `demo` adapters serve fixtures; `live` adapters call a real supplier. */
  readonly kind: ProviderKind;
  /** Bump when the adapter's mapping or data changes; part of the cache key. */
  readonly version: string;
  readonly serviceTypes: readonly SearchServiceType[];
  /**
   * What this provider can do. `revalidate` is used only when declared
   * `supported` AND `revalidate()` is implemented; booking is not part of
   * the platform yet.
   */
  readonly operations: OperationSupport;
  /** Time limit per call (each attempt), within the overall search deadline. */
  readonly timeoutMs: number;
  /** Names (never values) of the configuration this provider needs. */
  readonly requiredConfig: readonly string[];
  search(request: SearchRequest, context: ProviderSearchContext): Promise<ProviderSearchOutput>;
  /**
   * Asks the supplier for the current state of one offer it issued (by
   * `offer.offerRef`). Must be a read-only, idempotent call: it may be retried.
   * The response is validated before use. Demo adapters don't implement it.
   */
  revalidate?(offer: SearchResult, context: ProviderSearchContext): Promise<RevalidationOutcome>;
}

/**
 * Thrown by adapters for failures they understand.
 *
 * - `kind`: `unavailable` (outage, maintenance, rate-limited) or `error`.
 * - `transient`: whether trying again soon may succeed (timeouts at the
 *   supplier, 429/502/503, dropped connections). Defaults to true for
 *   `unavailable`, false for `error`. Permanent failures (bad credentials,
 *   a request the supplier rejects) must stay non-transient: they are never
 *   retried.
 *
 * The message is for server logs only (and scrubbed there): clients always
 * get Wayora's own fixed wording, never supplier text.
 */
export class ProviderError extends Error {
  readonly transient: boolean;

  constructor(
    readonly kind: 'unavailable' | 'error',
    message: string,
    options: { cause?: unknown; transient?: boolean } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.transient = options.transient ?? kind === 'unavailable';
  }
}

export const SEARCH_ONLY: OperationSupport = {
  search: 'supported',
  revalidate: 'unsupported',
  book: 'unsupported',
};

/**
 * Helper for single-category adapters: narrows the request type so the
 * adapter body works with, e.g., a flight request only.
 */
export function singleCategoryProvider<S extends SearchServiceType>(definition: {
  id: string;
  name: string;
  kind: ProviderKind;
  version: string;
  serviceType: S;
  timeoutMs: number;
  requiredConfig?: readonly string[];
  operations?: OperationSupport;
  search: (
    request: SearchRequestFor<S>,
    context: ProviderSearchContext,
  ) => Promise<readonly ProviderResult<S>[]> | readonly ProviderResult<S>[];
}): SearchProvider {
  const {
    serviceType,
    search,
    requiredConfig = [],
    operations = SEARCH_ONLY,
    ...rest
  } = definition;
  return {
    ...rest,
    serviceTypes: [serviceType],
    operations,
    requiredConfig,
    async search(request, context) {
      if (request.serviceType !== serviceType) {
        throw new ProviderError('error', 'This provider does not handle that kind of search.');
      }
      context.signal.throwIfAborted();
      return { results: await search(request as SearchRequestFor<S>, context) };
    },
  };
}
