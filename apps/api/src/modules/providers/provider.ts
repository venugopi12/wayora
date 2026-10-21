import type {
  ProviderKind,
  ProviderOperation,
  SearchRequest,
  SearchRequestFor,
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
   * What this provider can do. Only `search` is used today; revalidation and
   * booking are declared `unsupported` until an adapter implements them.
   */
  readonly operations: OperationSupport;
  /** Per-search time limit. */
  readonly timeoutMs: number;
  /** Names (never values) of the configuration this provider needs. */
  readonly requiredConfig: readonly string[];
  search(request: SearchRequest, context: ProviderSearchContext): Promise<ProviderSearchOutput>;
}

/** Thrown by adapters for failures they understand; the message is shown to users as-is. */
export class ProviderError extends Error {
  constructor(
    readonly kind: 'unavailable' | 'error',
    readonly safeMessage: string,
    options: { cause?: unknown } = {},
  ) {
    super(safeMessage, options);
    this.name = 'ProviderError';
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
