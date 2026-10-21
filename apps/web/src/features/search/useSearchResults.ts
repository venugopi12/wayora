import { useQuery } from '@tanstack/react-query';
import type { SearchRequestInput } from '@wayora/contracts';
import { searchTravel } from '../../services/search';

export const searchKeys = {
  all: ['search'] as const,
  search: (request: SearchRequestInput) => ['search', request.serviceType, request] as const,
};

/** The request without its refinements: what providers are asked. */
function core(request: SearchRequestInput): string {
  const {
    filters: _filters,
    sortBy: _sort,
    page: _page,
    pageSize: _size,
    ...rest
  } = request as SearchRequestInput & Record<string, unknown>;
  return JSON.stringify(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)));
}

/** Two requests differ only in filters, sort or page. */
export function sameSearch(a: SearchRequestInput, b: SearchRequestInput): boolean {
  return a.serviceType === b.serviceType && core(a) === core(b);
}

/**
 * Results for one search request (docs/search.md#web).
 *
 * - Keyed by the full request: a response can only ever land on the request
 *   that asked for it, so an older answer never replaces a newer one, and a
 *   replaced request is aborted through `signal`.
 * - While filters, sort or page change, the previous results stay on screen
 *   (`isPlaceholderData`) instead of a skeleton; a different search (new
 *   route, dates…) shows the loading state. Within a search's lifetime the
 *   API answers these from its stored provider round, without calling
 *   providers again.
 */
export function useSearchResults(request: SearchRequestInput) {
  return useQuery({
    queryKey: searchKeys.search(request),
    queryFn: ({ signal }) => searchTravel(request, signal),
    staleTime: 60_000,
    retry: false,
    placeholderData: (previous, previousQuery) => {
      const previousRequest = previousQuery?.queryKey[2] as SearchRequestInput | undefined;
      return previous && previousRequest && sameSearch(previousRequest, request)
        ? previous
        : undefined;
    },
  });
}
