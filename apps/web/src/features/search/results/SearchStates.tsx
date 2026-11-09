import { RotateCw, SearchX, SlidersHorizontal } from 'lucide-react';
import { Alert, Button, EmptyState, ErrorState, Skeleton } from '@wayora/ui';
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

/** Wording per error code for a failed search (docs/search.md#errors). */
function searchErrorCopy(error: unknown): { title: string; description: string } {
  const api = error instanceof ApiClientError ? error : null;
  if (api?.code === 'OFFLINE') {
    return {
      title: 'You’re offline',
      description: 'Searching needs a connection. Reconnect and try again.',
    };
  }
  if (!api || api.code === 'NETWORK_ERROR' || api.code === 'TIMEOUT') {
    return {
      title: "We couldn't reach Wayora",
      description: 'Check your connection and try again.',
    };
  }
  switch (api.code) {
    case 'PROVIDER_TIMEOUT':
      return { title: 'Providers are taking too long', description: api.message };
    case 'PROVIDER_UNAVAILABLE':
      return { title: 'Providers are unavailable right now', description: api.message };
    case 'SEARCH_FAILED':
      return { title: "The search didn't complete", description: api.message };
    case 'SERVICE_UNAVAILABLE':
      return { title: 'Search is unavailable right now', description: api.message };
    case 'RATE_LIMITED':
    case 'VALIDATION_FAILED':
      return { title: "The search didn't complete", description: api.message };
    default:
      return {
        title: "The search didn't complete",
        description: 'Something went wrong on our side. Please try again.',
      };
  }
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
  const { title, description } = searchErrorCopy(error);
  return (
    <ErrorState
      title={title}
      description={description}
      reference={error instanceof ApiClientError ? (error.requestId ?? undefined) : undefined}
      action={
        <Button variant="secondary" onClick={onRetry} loading={retrying}>
          <RotateCw aria-hidden="true" />
          Try again
        </Button>
      }
    />
  );
}

/**
 * Results whose search session has expired: offers can no longer be opened
 * from them. Refreshing runs the same search again (new session).
 */
export function ExpiredResultsNotice({
  onRefresh,
  refreshing,
}: {
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <Alert
      tone="warning"
      // Appears on its own when time passes, not after an action: announce politely.
      role="status"
      title="These results have expired"
      action={
        <Button size="sm" variant="secondary" onClick={onRefresh} loading={refreshing}>
          <RotateCw aria-hidden="true" />
          Refresh results
        </Button>
      }
    >
      Prices and times may have changed since you searched. Refresh to search again with the same
      details.
    </Alert>
  );
}
