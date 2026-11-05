import { History } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import type { SearchServiceType } from '@wayora/contracts';
import { Button } from '@wayora/ui';
import { clearRecentSearches, recentSearches, type RecentStore } from './recent';
import { summarizeSearch } from './summary';

/**
 * Searches run earlier in this browser for this category, as links that run
 * them again. Shown before a search; hidden when there are none.
 */
export function RecentSearches({
  serviceType,
  store,
}: {
  serviceType: SearchServiceType;
  /** Storage override for tests; the browser's localStorage otherwise. */
  store?: RecentStore | null;
}) {
  const options = store === undefined ? {} : { store };
  const [entries, setEntries] = useState(() => recentSearches(serviceType, options));
  const headingId = useId();
  if (entries.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 id={headingId} className="flex items-center gap-2 text-heading-3 text-ink">
            <History className="size-5 text-ink-secondary" aria-hidden="true" />
            Recent searches
          </h2>
          <p className="text-caption text-ink-secondary">
            Saved in this browser only: the route, dates and party size, nothing else.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            clearRecentSearches(serviceType, options);
            setEntries([]);
          }}
        >
          Clear recent searches
        </Button>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((entry) => {
          const { title, details } = summarizeSearch(serviceType, entry.values);
          return (
            <li key={entry.query} className="min-w-0">
              <Link
                to={{ search: `?${entry.query}` }}
                className="flex h-full min-w-0 flex-col gap-1 rounded-lg border border-line bg-card p-4 shadow-xs transition-colors hover:border-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                <span className="truncate text-body font-semibold text-ink">{title}</span>
                <span className="text-body-sm text-ink-secondary">
                  {details.filter(Boolean).join(' · ')}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
