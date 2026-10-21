import type { Ref } from 'react';
import type { SearchRequestInput, SearchServiceType } from '@wayora/contracts';
import { cn } from '@wayora/ui';
import { ResultCard } from '../cards';
import { SEARCH_CONFIG } from '../config';
import { PAGE_PARAM, SORT_PARAM, activeFilterChips, clearAllFilters, readSort } from '../filters';
import { useSearchResults } from '../useSearchResults';
import { offerPath } from '../../offers/paths';
import { ActiveFilterChips } from './ActiveFilterChips';
import { FilterPanel, activeFilterCount, type ParamUpdate } from './FilterPanel';
import { MobileFilterDrawer } from './MobileFilterDrawer';
import { ProviderStatusNotice } from './ProviderStatusNotice';
import { SearchPagination } from './SearchPagination';
import { SearchEmptyState, SearchErrorState, SearchLoadingSkeleton } from './SearchStates';
import { SortControl } from './SortControl';

export interface ParamOptions {
  /** Add a history entry (pages) instead of replacing the current one (filters, sort). */
  push?: boolean;
}

/**
 * Results for one valid search: filters (sidebar on desktop, sheet on
 * small screens), header with count and sort, active-filter chips, provider
 * status, the category's result cards, pagination, and every non-result
 * state. Filter, sort and page live in the URL (`params`); changing them
 * keeps the current results on screen until the new ones arrive.
 */
export function SearchResultsLayout({
  serviceType,
  request,
  params,
  onParams,
  headingRef,
}: {
  serviceType: SearchServiceType;
  request: SearchRequestInput;
  params: URLSearchParams;
  onParams: (updates: ParamUpdate, options?: ParamOptions) => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const config = SEARCH_CONFIG[serviceType];
  const search = useSearchResults(request);
  const response = search.data;
  const currency = request.currency ?? 'INR';
  const chips = activeFilterChips(serviceType, params, {
    currency,
    ...(response ? { facets: response.facets } : {}),
  });
  const clearFilters = () => onParams(clearAllFilters(serviceType));
  const updating = search.isFetching && search.isPlaceholderData;
  const [one, many] = config.noun;

  let status = '';
  if (search.isPending) status = 'Searching demo data…';
  else if (updating) status = 'Updating results…';
  else if (response) {
    const { page, pageSize, totalResults } = response.pagination;
    const first = (page - 1) * pageSize + 1;
    const last = first + response.results.length - 1;
    status =
      totalResults === 0
        ? `No ${many}`
        : response.results.length === totalResults
          ? `${totalResults} ${totalResults === 1 ? one : many}`
          : `${first}–${last} of ${totalResults} ${many}`;
    if (chips.length > 0 && totalResults > 0) status += ' matching your filters';
  }

  const filterPanel = response ? (
    <FilterPanel
      serviceType={serviceType}
      params={params}
      facets={response.facets}
      currency={currency}
      onChange={onParams}
    />
  ) : null;

  let body;
  if (search.isPending) {
    body = <SearchLoadingSkeleton />;
  } else if (search.isError && !search.isPlaceholderData) {
    body = (
      <SearchErrorState
        error={search.error}
        onRetry={() => void search.refetch()}
        retrying={search.isFetching}
      />
    );
  } else if (response) {
    const { page, totalPages, totalResults } = response.pagination;
    body = (
      <div className="flex flex-col gap-4">
        <ProviderStatusNotice
          response={response}
          onRetry={() => void search.refetch()}
          retrying={search.isFetching}
        />
        {response.warnings
          .filter((w) => w.code !== 'DEMO_DATA' && w.code !== 'PARTIAL_RESULTS')
          .map((w) => (
            <p
              key={w.code}
              className="rounded-lg bg-info-soft px-4 py-3 text-body-sm text-ink-secondary"
            >
              {w.message}
            </p>
          ))}
        {response.results.length === 0 ? (
          <SearchEmptyState
            reason={totalResults > 0 ? 'beyond' : chips.length > 0 ? 'filtered' : 'none'}
            coverage={config.coverage}
            onClearFilters={clearFilters}
            onFirstPage={() => onParams({ [PAGE_PARAM]: null }, { push: true })}
          />
        ) : (
          <ol
            aria-label="Search results"
            aria-busy={updating || undefined}
            className={cn(
              'flex flex-col gap-3 transition-opacity duration-(--duration-base)',
              updating && 'opacity-60',
            )}
          >
            {response.results.map((result) => (
              <li key={result.id}>
                <ResultCard
                  result={result}
                  href={offerPath(serviceType, result.id, response.searchId, params.toString())}
                />
              </li>
            ))}
          </ol>
        )}
        <SearchPagination
          page={page}
          totalPages={totalPages}
          onPage={(next) =>
            onParams({ [PAGE_PARAM]: next > 1 ? String(next) : null }, { push: true })
          }
        />
      </div>
    );
  }

  const sort = readSort(serviceType, params).sort;
  const filterCount = activeFilterCount(serviceType, params);

  return (
    <section
      aria-labelledby="results-title"
      className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)] lg:gap-10"
    >
      {/* A region, not <aside>: complementary landmarks must be top-level, and
          this sits inside the results section. */}
      <section aria-label="Filters" className="hidden lg:block">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-title">Filters</h2>
            {filterCount > 0 ? (
              <button
                type="button"
                onClick={clearFilters}
                className="min-h-9 rounded-sm px-2 text-body-sm font-semibold text-brand-ink hover:bg-brand-soft"
              >
                Clear all
              </button>
            ) : null}
          </div>
          {filterPanel}
        </div>
      </section>

      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex flex-col gap-1">
            <h2
              id="results-title"
              ref={headingRef}
              tabIndex={-1}
              className="text-heading-3 focus:outline-none"
            >
              Results
            </h2>
            <p aria-live="polite" aria-atomic="true" className="text-body-sm text-ink-secondary">
              {status}
            </p>
          </div>
          <div className="grid gap-3 sm:flex sm:items-end">
            {filterPanel ? (
              <MobileFilterDrawer
                activeCount={filterCount}
                resultLabel={
                  response && !updating
                    ? `Show ${response.pagination.totalResults} result${response.pagination.totalResults === 1 ? '' : 's'}`
                    : 'Show results'
                }
                onClearAll={clearFilters}
              >
                {filterPanel}
              </MobileFilterDrawer>
            ) : null}
            <SortControl
              value={sort}
              options={config.sorts}
              onChange={(value) =>
                onParams({ [SORT_PARAM]: value === config.sorts[0]!.value ? null : value })
              }
            />
          </div>
        </div>
        <ActiveFilterChips chips={chips} onChange={onParams} onClearAll={clearFilters} />
        {body}
      </div>
    </section>
  );
}
