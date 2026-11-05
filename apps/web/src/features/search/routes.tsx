import { ArrowLeft, FlaskConical } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { SEARCH_PLACES, type TravelCategorySlug } from '@wayora/contracts';
import { Alert, Badge, Container } from '@wayora/ui';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { destinationPath } from '../discover/paths';
import { findDestination } from '../discover/search';
import { serviceBySlug } from '../navigation/config';
import { useDisplayCurrency } from '../preferences/currency';
import { SEARCH_CONFIG } from './config';
import { RecentSearches } from './RecentSearches';
import { rememberSearch } from './recent';
import { readSearchParams, searchParamsFor, validate, withParams, type FormValues } from './params';
import type { ParamUpdate } from './results/FilterPanel';
import { SearchResultsLayout, type ParamOptions } from './results/SearchResultsLayout';
import { SearchSummary } from './results/SearchSummary';
import { SearchForm } from './SearchForm';

/*
 * /flights, /hotels, … /holidays: search and results for one category
 * (docs/search.md#web).
 *
 * The URL is the source of truth: the form writes the search (a new history
 * entry), filters and sort refine it (replacing the entry), pages add
 * entries. Results are fetched for whatever valid search the URL describes.
 */

/** Router state set when invalid refinements were removed from the URL. */
interface SearchLocationState {
  tidied?: boolean;
}

/**
 * `?to=<destination slug>` from Discover (e.g. /hotels?to=goa): prefill the
 * matching place for this category, if the demo covers it, and offer a way back.
 */
function discoverContext(slug: TravelCategorySlug, to: string | null) {
  if (!to || to.includes(':')) return null;
  const destination = findDestination(to);
  if (!destination) return { destination: undefined, placeId: undefined };
  const field = SEARCH_CONFIG[slug].fields.find((f) => f.param === 'to');
  const place =
    field?.kind === 'place'
      ? SEARCH_PLACES.find(
          (p) => p.cityId === destination.slug && field.placeKinds.includes(p.kind),
        )
      : undefined;
  return { destination, placeId: place?.id };
}

export function ServiceSearchRoute({ slug }: { slug: TravelCategorySlug }) {
  const service = serviceBySlug[slug];
  const Icon = service.icon;
  const config = SEARCH_CONFIG[slug];
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { currency } = useDisplayCurrency();
  const paramsKey = params.toString();
  const to = params.get('to');
  const discover = useMemo(() => discoverContext(slug, to), [slug, to]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusResultsAfterSearch = useRef(false);

  const state = useMemo(() => {
    const p = new URLSearchParams(paramsKey);
    if (discover) {
      // A Discover link names a destination, not a full search: prefill only.
      p.delete('to');
      const read = readSearchParams(slug, p);
      const values: FormValues = {
        ...read.values,
        ...(discover.placeId ? { to: discover.placeId } : {}),
      };
      return { status: 'idle' as const, values };
    }
    return readSearchParams(slug, p);
  }, [slug, paramsKey, discover]);

  // The form is open until a search runs; "Edit search" reopens it for the
  // search it was opened on (a new search closes it again).
  const searchKey = state.status === 'ready' ? JSON.stringify(state.values) : null;
  const [editingFor, setEditingFor] = useState<string | null>(null);
  const [focusEdit, setFocusEdit] = useState(false);
  const formOpen = state.status !== 'ready' || editingFor === searchKey;

  // Remember each valid search that runs, in this browser only (recent.ts).
  useEffect(() => {
    if (searchKey !== null) rememberSearch(slug, JSON.parse(searchKey) as FormValues);
  }, [slug, searchKey]);

  // Invalid filters, sort or page in a link are ignored; tidy them out of the URL.
  const droppedKey = state.status === 'ready' ? state.dropped.join(',') : '';
  useEffect(() => {
    if (droppedKey === '') return;
    const next = new URLSearchParams(paramsKey);
    for (const param of droppedKey.split(',')) next.delete(param);
    void navigate(
      { search: next.toString() ? `?${next.toString()}` : '' },
      { replace: true, state: { tidied: true } satisfies SearchLocationState },
    );
  }, [droppedKey, paramsKey, navigate]);
  const tidied = (location.state as SearchLocationState | null)?.tidied === true;

  // After a search from the form, move focus to the results heading (the
  // form closes, so the Search button disappears).
  useEffect(() => {
    if (state.status === 'ready' && focusResultsAfterSearch.current) {
      focusResultsAfterSearch.current = false;
      headingRef.current?.focus();
    }
  }, [state.status, paramsKey]);

  const runSearch = useCallback(
    (values: FormValues) => {
      const next = searchParamsFor(slug, values, new URLSearchParams(paramsKey), currency.code);
      const result = validate(slug, values, next);
      if (!result.ok) return result.issues;
      focusResultsAfterSearch.current = true;
      setEditingFor(null);
      void navigate({ search: `?${next.toString()}` });
      return [];
    },
    [slug, paramsKey, currency.code, navigate],
  );

  const updateParams = useCallback(
    (updates: ParamUpdate, { push = false }: ParamOptions = {}) =>
      setParams(withParams(new URLSearchParams(paramsKey), updates), { replace: !push }),
    [paramsKey, setParams],
  );

  useDocumentTitle(state.status === 'ready' ? `${service.name} search` : service.name);

  return (
    <Container className="flex flex-col gap-6 py-section-sm">
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <span
            aria-hidden="true"
            className="grid size-11 place-items-center rounded-lg bg-brand-soft text-brand-ink [&_svg]:size-6"
          >
            <Icon strokeWidth={1.75} />
          </span>
          <h1 className="text-heading-1">{service.name}</h1>
          <Badge tone="warning" icon={<FlaskConical />}>
            Demo search
          </Badge>
        </div>
        <Alert tone="warning" role="none" title="Demo data only">
          Results come from Wayora&apos;s built-in sample data, not from airlines, hotels or other
          travel providers. Prices, times and services are illustrative, availability isn&apos;t
          checked, and bookings are demo bookings: no real reservation, ticket or payment.
        </Alert>
        {discover?.destination ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm text-ink-secondary">
            {discover.placeId
              ? `Planning a trip to ${discover.destination.name}: we've filled it in below.`
              : `The demo doesn't cover ${service.name.toLowerCase()} for ${discover.destination.name} yet.`}
            <Link
              to={destinationPath(discover.destination.slug)}
              className="inline-flex items-center gap-1 font-semibold text-brand-ink hover:underline"
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
              Back to {discover.destination.name}
            </Link>
          </p>
        ) : null}
      </header>

      {formOpen ? (
        <SearchForm
          serviceType={slug}
          initialValues={state.values}
          issues={state.status === 'invalid' ? state.issues : []}
          onSearch={runSearch}
          {...(state.status === 'ready'
            ? {
                onCancel: () => {
                  setFocusEdit(true);
                  setEditingFor(null);
                },
                autoFocusFirstField: true,
              }
            : {})}
        />
      ) : (
        <SearchSummary
          serviceType={slug}
          values={state.values}
          onEdit={() => {
            setFocusEdit(false);
            setEditingFor(searchKey);
          }}
          focusOnMount={focusEdit}
        />
      )}

      {state.status === 'invalid' ? (
        <Alert tone="danger" title="This search link isn't valid">
          Fix the highlighted fields above and search again.
        </Alert>
      ) : null}
      {state.status === 'ready' && tidied ? (
        <Alert tone="info" role="status">
          Some filters or settings in this link weren&apos;t valid, so they were removed.
        </Alert>
      ) : null}

      {state.status === 'ready' ? (
        <SearchResultsLayout
          serviceType={slug}
          request={state.request}
          params={new URLSearchParams(paramsKey)}
          onParams={updateParams}
          headingRef={headingRef}
        />
      ) : (
        <>
          <p className="text-body-sm text-ink-secondary">
            {config.coverage} Fill in the form to see demo {service.name.toLowerCase()}.
          </p>
          {state.status === 'idle' ? <RecentSearches key={slug} serviceType={slug} /> : null}
        </>
      )}
    </Container>
  );
}
