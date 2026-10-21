import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Clock, RotateCw, SearchX } from 'lucide-react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { SearchServiceType } from '@wayora/contracts';
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
import { DemoBadge, PriceBlock } from '../search/cards/shared';
import { OfferDetails, offerHeading } from './OfferDetails';
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

  const notFound =
    searchId === null ||
    (offer.isError && offer.error instanceof ApiClientError && offer.error.status === 404);
  const refreshMissed =
    refresh.isError && refresh.error instanceof ApiClientError && refresh.error.status === 404;

  let body;
  if (notFound) {
    body = (
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-dashed border-line-strong bg-card">
          <EmptyState
            size="page"
            icon={<Clock />}
            title={
              refreshMissed ? 'This offer is no longer in the results' : 'This offer has expired'
            }
            description={
              refreshMissed
                ? 'We ran the search again and this offer is not part of it any more. Have a look at the current results.'
                : `Search results are kept for a few minutes, then they expire, so prices and times are never shown out of date.${canRefresh ? ' Refresh to run the same search again.' : ''}`
            }
            action={
              <div className="flex flex-col gap-3 sm:flex-row">
                {canRefresh && !refreshMissed ? (
                  <Button onClick={() => refresh.mutate()} loading={refresh.isPending}>
                    <RotateCw aria-hidden="true" />
                    Refresh this offer
                  </Button>
                ) : null}
                <Button asChild variant="secondary">
                  <Link to={resultsPath}>Back to results</Link>
                </Button>
              </div>
            }
          />
        </div>
        {refresh.isError && !refreshMissed ? (
          <Alert tone="danger" title="We couldn't refresh this offer">
            {refresh.error instanceof ApiClientError && refresh.error.code === 'SERVICE_UNAVAILABLE'
              ? refresh.error.message
              : 'Check your connection and try again.'}
          </Alert>
        ) : null}
      </div>
    );
  } else if (offer.isPending) {
    body = <OfferSkeleton />;
  } else if (offer.isError) {
    body = (
      <ErrorState
        title="We couldn't load this offer"
        description="Check your connection and try again."
        reference={
          offer.error instanceof ApiClientError ? (offer.error.requestId ?? undefined) : undefined
        }
        action={
          <Button
            variant="secondary"
            onClick={() => void offer.refetch()}
            loading={offer.isFetching}
          >
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
        }
      />
    );
  } else {
    const { result, disclaimer, expiresAt } = offer.data;
    const demo = result.source === 'demo';
    body = (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {demo ? <DemoBadge /> : null}
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
              Shown for this search until{' '}
              <time dateTime={expiresAt}>{timeFormat.format(new Date(expiresAt))}</time>.{' '}
              {demo
                ? 'Demo price: illustrative, not bookable.'
                : 'Prices can change until a booking is confirmed.'}
            </p>
            <p className="rounded-md bg-sunken px-3 py-2 text-body-sm text-ink-secondary">
              Booking isn&apos;t available on Wayora yet.
            </p>
            <Button asChild variant="secondary">
              <Link to={resultsPath}>Back to results</Link>
            </Button>
          </aside>
        </div>
      </div>
    );
  }

  return (
    <Container className="flex flex-col gap-6 py-section-sm">
      {crumbs}
      <BackToResults to={resultsPath} label={`Back to ${service.name.toLowerCase()} results`} />
      {notFound || offer.isError || offer.isPending ? (
        <h1 className="sr-only">{service.name} offer</h1>
      ) : null}
      {body}
    </Container>
  );
}
