import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { findMood, findRegion } from './data';
import type { DestinationFilters } from './search';

const MAX_QUERY = 80;

/** Reads filters from the URL. Unknown moods/regions are ignored, not errors. */
export function parseFilters(params: URLSearchParams): DestinationFilters {
  return {
    query: (params.get('q') ?? '').trim().slice(0, MAX_QUERY),
    mood: findMood(params.get('mood'))?.slug,
    region: findRegion(params.get('region'))?.slug,
  };
}

/**
 * Discover's filter state lives in the URL (?q=&mood=&region=), so a filtered
 * view can be shared, bookmarked and survives a refresh. Toggling filters
 * replaces the history entry and keeps the scroll position; a submitted
 * search adds an entry, so Back returns to the previous results.
 */
export function useDiscoverFilters() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(params), [params]);

  const setFilters = useCallback(
    (next: Partial<DestinationFilters>, { push = false }: { push?: boolean } = {}) => {
      setParams(
        (prev) => {
          const merged = { ...parseFilters(prev), ...next };
          const out = new URLSearchParams();
          if (merged.query?.trim()) out.set('q', merged.query.trim().slice(0, MAX_QUERY));
          if (merged.mood) out.set('mood', merged.mood);
          if (merged.region) out.set('region', merged.region);
          return out;
        },
        { replace: !push, preventScrollReset: true },
      );
    },
    [setParams],
  );

  const clearFilters = useCallback(
    () => setFilters({ query: '', mood: undefined, region: undefined }),
    [setFilters],
  );

  return { filters, setFilters, clearFilters };
}

/** Smoothly brings the results into view and moves focus to their heading. */
export function focusResults(headingId: string) {
  const heading = document.getElementById(headingId);
  if (!heading) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  heading
    .closest('section')
    ?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  heading.focus({ preventScroll: true });
}
