import { RotateCw, SearchX, SlidersHorizontal } from 'lucide-react';
import { Button, EmptyState, ErrorState, Skeleton } from '@wayora/ui';
import { ApiClientError } from '../../../lib/api-client';

/** Placeholder cards shaped like result cards, so nothing jumps when results arrive. */
export function SearchLoadingSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div role="status" aria-label="Searching" className="flex flex-col gap-3">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="flex flex-col gap-4 rounded-xl border border-line bg-card p-4 sm:p-5"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-5 w-24 rounded-full" />
              <Skeleton className="h-6 w-1/2" />
            </div>
            <Skeleton className="h-8 w-28" />
          </div>
          <Skeleton className="h-14 w-full" />
          <div className="flex items-center justify-between border-t border-line pt-3">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-9 w-28" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * - `none`: the search ran and nothing matched it.
 * - `filtered`: there are results, but the filters exclude all of them.
 * - `beyond`: the page number is past the last page.
 */
export function SearchEmptyState({
  reason,
  coverage,
  onClearFilters,
  onFirstPage,
}: {
  reason: 'none' | 'filtered' | 'beyond';
  coverage: string;
  onClearFilters: () => void;
  onFirstPage: () => void;
}) {
  const content = {
    none: {
      icon: <SearchX />,
      title: 'No demo results for this search',
      description: `Try other dates or a different route. ${coverage}`,
      action: undefined,
    },
    filtered: {
      icon: <SlidersHorizontal />,
      title: 'No results match these filters',
      description:
        'This search has results, but none of them fit every filter. Remove a filter or clear them all.',
      action: (
        <Button variant="secondary" onClick={onClearFilters}>
          Clear all filters
        </Button>
      ),
    },
    beyond: {
      icon: <SearchX />,
      title: 'No more results',
      description: 'This page is past the last result.',
      action: (
        <Button variant="secondary" onClick={onFirstPage}>
          Back to the first page
        </Button>
      ),
    },
  }[reason];
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-card">
      <EmptyState size="page" {...content} />
    </div>
  );
}

/** A failed search: what happened, in plain words, and a working retry. */
export function SearchErrorState({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}) {
  const api = error instanceof ApiClientError ? error : null;
  const unavailable = api?.code === 'SERVICE_UNAVAILABLE';
  const network = !api || api.code === 'NETWORK_ERROR' || api.code === 'TIMEOUT';
  return (
    <ErrorState
      title={
        unavailable
          ? 'Search is unavailable right now'
          : network
            ? "We couldn't reach Wayora"
            : "The search didn't complete"
      }
      description={
        network
          ? 'Check your connection and try again.'
          : unavailable || api.code === 'RATE_LIMITED' || api.code === 'VALIDATION_FAILED'
            ? api.message
            : 'Something went wrong on our side. Please try again.'
      }
      reference={api?.requestId ?? undefined}
      action={
        <Button variant="secondary" onClick={onRetry} loading={retrying}>
          <RotateCw aria-hidden="true" />
          Try again
        </Button>
      }
    />
  );
}
