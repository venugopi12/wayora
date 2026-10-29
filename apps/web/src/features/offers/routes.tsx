import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Clock, RotateCw, SearchX } from 'lucide-react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { ReactNode } from 'react';
import type { SearchPrice, SearchServiceType } from '@wayora/contracts';
import {
  Alert,
  Breadcrumbs,
  Button,
  Container,
  EmptyState,
  ErrorState,
  Skeleton,
} from '@wayora/ui';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { ApiClientError } from '../../lib/api-client';
import { fetchOffer, searchTravel } from '../../services/search';
import { serviceBySlug } from '../navigation/config';
import { readSearchParams } from '../search/params';
import { PriceBlock, SourceBadge, money } from '../search/cards/shared';
import { OfferDetails, offerHeading } from './OfferDetails';
import { bookPath } from '../bookings/paths';
import { offerPath, readOfferParams, resultsPathFor } from './paths';

/*
 * /offers/:serviceType/:resultId?sid=…&from=… (docs/search.md#offer-details)
 *
 * The offer is always read from the server's stored search (`sid`), so the
 * price shown is the server's, whatever the URL says. If that search has
 * expired, the page offers to run the same search again (from `from`) and
 * find the same offer in the fresh results. Nothing here books anything.
 */

export const offerKeys = {
  offer: (type: SearchServiceType, searchId: string, resultId: string) =>
    ['offer', type, searchId, resultId] as const,
};

const timeFormat = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit' });

function OfferSkeleton() {
  return (
    <div role="status" aria-label="Loading offer" className="flex flex-col gap-6">
      <Skeleton className="h-10 w-2/3" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
        <Skeleton className="h-40 rounded-xl" />
      </div>
    </div>
  );
}

function BackToResults({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-md text-body-sm font-semibold text-brand-ink hover:underline"
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      {label}
    </Link>
  );
}

/**
 * Runs the original search again and looks for the same offer in it. Used
 * when the stored search has expired (or the link had no search id).
 */
function useRefreshOffer(serviceType: SearchServiceType, resultId: string, from: string | null) {
  const navigate = useNavigate();
  const state = from ? readSearchParams(serviceType, new URLSearchParams(from)) : null;
  const request = state?.status === 'ready' ? state.request : null;
  const refresh = useMutation({
    mutationFn: async () => {
      if (!request) throw new Error('No search to refresh');
      const search = await searchTravel(request);
      // Look the offer up in the new stored search: still never from the client.
      return fetchOffer(serviceType, search.searchId, resultId);
    },
    onSuccess: (offer) => {
      void navigate(offerPath(serviceType, resultId, offer.searchId, from ?? ''), {
        replace: true,
      });
    },
  });
  return { canRefresh: request !== null, refresh };
}

export function OfferDetailRoute() {
  const routeParams = useParams();
  const [search] = useSearchParams();
  const parsed = readOfferParams(routeParams, search);
  if (!parsed.ok) return <InvalidOfferLink />;
  return (
    <OfferPage key={`${parsed.serviceType}|${parsed.resultId}|${parsed.searchId}`} {...parsed} />
  );
}

function InvalidOfferLink() {
  useDocumentTitle('Offer not found');
  return (
    <Container size="narrow" className="py-section-sm">
      <EmptyState
        size="page"
        titleAs="h1"
        icon={<SearchX />}
        title="This offer link isn't valid"
        description="It doesn't name a travel service and offer Wayora knows. Start a new search instead."
        action={
          <Button asChild>
            <Link to="/">Back to home</Link>
          </Button>
        }
      />
    </Container>
  );
}

/** What went wrong, as the offer page explains it (one state per API error code). */
type OfferProblem =
  | { kind: 'expired' }
  | { kind: 'not-in-search' }
  | { kind: 'bad-link'; mismatch: boolean }
  | { kind: 'unavailable' }
  | { kind: 'temporary'; message: string; requestId: string | null }
  | { kind: 'failed'; requestId: string | null };

/** Codes for failures that may pass if the visitor tries again later. */
const TEMPORARY_CODES = new Set([
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'SEARCH_FAILED',
  'SERVICE_UNAVAILABLE',
  'RATE_LIMITED',
]);

function problemFor(error: unknown): OfferProblem {
  const api = error instanceof ApiClientError ? error : null;
  switch (api?.code) {
    case 'SEARCH_EXPIRED':
      return { kind: 'expired' };
    case 'OFFER_NOT_IN_SEARCH':
      return { kind: 'not-in-search' };
    case 'OFFER_NOT_FOUND':
      return { kind: 'bad-link', mismatch: false };
    case 'CATEGORY_MISMATCH':
      return { kind: 'bad-link', mismatch: true };
    case 'OFFER_UNAVAILABLE':
      return { kind: 'unavailable' };
  }
  if (api && TEMPORARY_CODES.has(api.code)) {
    return { kind: 'temporary', message: api.message, requestId: api.requestId };
  }
  return { kind: 'failed', requestId: api?.requestId ?? null };
}

const priceText = (price: SearchPrice | null) =>
  !price
    ? 'no price'
    : price.kind === 'range'
      ? `${money(price.min)} – ${money(price.max)}`
      : money(price.total);

function OfferPage({
  serviceType,
  resultId,
  searchId,
  from,
}: {
  serviceType: SearchServiceType;
  resultId: string;
  searchId: string | null;
  from: string | null;
}) {
  const service = serviceBySlug[serviceType];
  const resultsPath = resultsPathFor(serviceType, from);
  const offer = useQuery({
    queryKey: offerKeys.offer(serviceType, searchId ?? '', resultId),
    queryFn: ({ signal }) => fetchOffer(serviceType, searchId!, resultId, signal),
    enabled: searchId !== null,
    // Never retried automatically: every retry is the visitor's choice.
    retry: false,
    staleTime: 60_000,
  });
  const { canRefresh, refresh } = useRefreshOffer(serviceType, resultId, from);
  const heading = offer.data ? offerHeading(offer.data.result) : null;
  useDocumentTitle(heading ? `${heading.title} (${service.name})` : `${service.name} offer`);

  const crumbs = (
    <Breadcrumbs
      items={[
        { label: 'Home', link: <Link to="/" /> },
        { label: `${service.name} results`, link: <Link to={resultsPath} /> },
        { label: heading?.title ?? 'Offer' },
      ]}
    />
  );

  const problem: OfferProblem | null =
    searchId === null ? { kind: 'expired' } : offer.isError ? problemFor(offer.error) : null;
  const refreshProblem = refresh.isError ? problemFor(refresh.error) : null;
  // After a refresh, the new search is the one that counts.
  const refreshMissed =
    refreshProblem?.kind === 'not-in-search' || refreshProblem?.kind === 'bad-link';
  const goneAfterRefresh = refreshProblem?.kind === 'unavailable';

  const backToResults = (
    <Button asChild variant="secondary">
      <Link to={resultsPath}>Back to results</Link>
    </Button>
  );
  const refreshButton =
    canRefresh && !refreshMissed && !goneAfterRefresh ? (
      <Button onClick={() => refresh.mutate()} loading={refresh.isPending}>
        <RotateCw aria-hidden="true" />
        Refresh this offer
      </Button>
    ) : null;

  const stateCard = (icon: ReactNode, title: string, description: string, actions: ReactNode) => (
    <div className="rounded-xl border border-dashed border-line-strong bg-card">
      <EmptyState
        size="page"
        icon={icon}
        title={title}
        description={description}
        action={<div className="flex flex-col gap-3 sm:flex-row">{actions}</div>}
      />
    </div>
  );

  let body;
  if (problem && (refreshMissed || goneAfterRefresh)) {
    body = stateCard(
      <SearchX />,
      goneAfterRefresh
        ? 'This offer is no longer available'
        : 'This offer is no longer in the results',
      goneAfterRefresh
        ? 'We ran the search again and the provider says this offer is gone. Have a look at the current results.'
        : 'We ran the search again and this offer is not part of it any more. Have a look at the current results.',
      backToResults,
    );
  } else if (problem?.kind === 'expired' || problem?.kind === 'not-in-search') {
    const expired = problem.kind === 'expired';
    body = (
      <div className="flex flex-col gap-4">
        {stateCard(
          <Clock />,
          expired ? 'This offer has expired' : "This offer isn't part of that search",
          (expired
            ? 'Search results are kept for a few minutes, then they expire, so prices and times are never shown out of date.'
            : 'The link points to a search that doesn’t contain this offer (it may come from a different search).') +
            (canRefresh ? ' Refresh to run the same search again and look for it.' : ''),
          <>
            {refreshButton}
            {backToResults}
          </>,
        )}
        {refreshProblem && !refreshMissed && !goneAfterRefresh ? (
          <Alert tone="danger" title="We couldn't refresh this offer">
            {refreshProblem.kind === 'temporary'
              ? refreshProblem.message
              : refreshProblem.kind === 'expired'
                ? 'The new search expired before we could read it. Please try again.'
                : 'Check your connection and try again.'}
          </Alert>
        ) : null}
      </div>
    );
  } else if (problem?.kind === 'bad-link') {
    body = stateCard(
      <SearchX />,
      problem.mismatch ? 'This link mixes up travel types' : "This offer link doesn't work",
      problem.mismatch
        ? `It doesn't lead to an offer in ${service.name}. Start a new search instead.`
        : "It doesn't name an offer Wayora knows. Start a new search instead.",
      <Button asChild>
        <Link to={resultsPath}>Search {service.name.toLowerCase()}</Link>
      </Button>,
    );
  } else if (problem?.kind === 'unavailable') {
    body = stateCard(
      <SearchX />,
      'This offer is no longer available',
      'The provider says this offer is gone. Have a look at the current results.',
      backToResults,
    );
  } else if (problem) {
    const temporary = problem.kind === 'temporary';
    body = (
      <ErrorState
        title={temporary ? "We couldn't check this offer right now" : "We couldn't load this offer"}
        description={temporary ? problem.message : 'Check your connection and try again.'}
        reference={problem.requestId ?? undefined}
        action={
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              variant="secondary"
              onClick={() => void offer.refetch()}
              loading={offer.isFetching}
            >
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
            <Button asChild variant="ghost">
              <Link to={resultsPath}>Back to results</Link>
            </Button>
          </div>
        }
      />
    );
  } else if (!offer.data) {
    body = <OfferSkeleton />;
  } else {
    const { result, disclaimer, expiresAt, validation } = offer.data;
    const demo = result.source === 'demo';
    const until = <time dateTime={expiresAt}>{timeFormat.format(new Date(expiresAt))}</time>;
    body = (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <SourceBadge source={result.source} />
            <span className="text-caption text-ink-secondary">{service.name}</span>
          </div>
          <h1 className="text-heading-1">{heading!.title}</h1>
          <p className="text-body-lg text-ink-secondary">{heading!.subtitle}</p>
        </header>
        {disclaimer ? (
          <Alert tone="warning" role="none" title="Demo offer">
            {disclaimer}
          </Alert>
        ) : null}
        {validation.status === 'price-changed' ? (
          <Alert tone="warning" title="The price has changed">
            When you searched it was {priceText(validation.previousPrice)}. The provider now quotes{' '}
            {priceText(result.price)}.
          </Alert>
        ) : null}
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex min-w-0 flex-col gap-4">
            <OfferDetails result={result} />
          </div>
          <aside
            aria-label="Price"
            className="flex flex-col gap-4 rounded-xl border border-line bg-card p-5 shadow-xs lg:order-none"
          >
            <PriceBlock price={result.price} demo={demo} align="start" size="lg" />
            <p className="text-caption text-ink-secondary">
              {validation.status === 'session' ? (
                demo ? (
                  <>
                    Demo price: illustrative, not a supplier guarantee. Not rechecked with any
                    supplier; shown for this search until {until}.
                  </>
                ) : (
                  <>
                    Shown for this search until {until}; not rechecked with the provider yet. Prices
                    can change until a booking is confirmed.
                  </>
                )
              ) : (
                <>
                  Checked with the provider at{' '}
                  <time dateTime={validation.checkedAt!}>
                    {timeFormat.format(new Date(validation.checkedAt!))}
                  </time>
                  . Prices can change until a booking is confirmed.
                </>
              )}
            </p>
            {demo && result.price && searchId ? (
              <>
                <Button asChild size="lg">
                  <Link to={bookPath(serviceType, result.id, searchId, from ?? '')}>
                    Book this demo offer
                  </Link>
                </Button>
                <p className="text-caption text-ink-secondary">
                  A demo booking: no supplier reservation, ticket or real payment. You review
                  everything before confirming.
                </p>
              </>
            ) : (
              <p className="rounded-md bg-sunken px-3 py-2 text-body-sm text-ink-secondary">
                {demo
                  ? 'This offer has no price, so it can’t be booked.'
                  : 'Booking supplier offers on Wayora isn’t available yet: no reservation, ticket or payment can be made here. Only demo offers can be booked for now.'}
              </p>
            )}
            {backToResults}
          </aside>
        </div>
      </div>
    );
  }

  return (
    <Container className="flex flex-col gap-6 py-section-sm">
      {crumbs}
      <BackToResults to={resultsPath} label={`Back to ${service.name.toLowerCase()} results`} />
      {problem || !offer.data ? <h1 className="sr-only">{service.name} offer</h1> : null}
      {body}
    </Container>
  );
}
