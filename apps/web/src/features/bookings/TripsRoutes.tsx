import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Luggage,
  RotateCw,
  SearchX,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router';
import {
  DEMO_BOOKING_NOTICE,
  bookingReferenceSchema,
  bookingViewSchema,
  type Booking,
  type BookingSummary,
  type BookingView,
} from '@wayora/contracts';
import {
  Alert,
  Badge,
  Breadcrumbs,
  Button,
  Container,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  ErrorState,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
  useToast,
} from '@wayora/ui';
import { Reveal, RevealGroup, RevealItem } from '@wayora/ui/motion';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { ApiClientError } from '../../lib/api-client';
import { cancelBooking, getBooking, listBookings } from '../../services/bookings';
import { listBookingPayments } from '../../services/payments';
import { AccountShell, Panel } from '../account/AccountShell';
import { serviceBySlug } from '../navigation/config';
import { OfferDetails, offerHeading } from '../offers/OfferDetails';
import { DemoBadge, money } from '../search/cards/shared';
import { BookingPriceSummary } from './BookingPriceSummary';
import { BookingStatusPanel, ReservationAlert, SupplierBookingBadge } from './BookingStatus';
import {
  DisruptionsPanel,
  TravelStatusPanel,
  TripTimelinePanel,
  useTripLiveUpdates,
  useTripStatus,
} from './TripTracking';
import {
  OPEN_RESERVATION,
  bookingStatusLabel,
  formatMoment,
  partyText,
  paymentStatusLabel,
  travelDates,
} from './format';
import { notificationKeys } from '../notifications/keys';
import { bookingKeys, paymentKeys } from './keys';
import { payPath, paymentPath, tripPath } from './paths';
import { BookingSupportPanel } from '../support/BookingSupportPanel';

/*
 * /trips, /trips/:reference and /trips/:reference/confirmation
 * (docs/bookings.md#web). Signed-in only; the API returns only this
 * account's bookings. These are demo bookings stored by Wayora. Travel
 * status and disruptions (TripTracking.tsx, Phase 17) come only from the
 * configured status provider, today a simulated one, and say so.
 */

const PAGE_SIZE = 10;
const VIEW_LABEL: Record<BookingView, string> = {
  upcoming: 'Upcoming',
  past: 'Past',
  cancelled: 'Cancelled',
};
const EMPTY: Record<BookingView, { title: string; description: string }> = {
  upcoming: {
    title: 'No upcoming trips',
    description: 'Search any service, open an offer and choose “Book this demo offer”.',
  },
  past: {
    title: 'No past trips',
    description: 'Demo bookings move here after their travel dates.',
  },
  cancelled: {
    title: 'No cancelled bookings',
    description: 'Bookings you cancel, and unpaid ones that expire, are kept here.',
  },
};

export function StatusBadge({ booking }: { booking: Pick<BookingSummary, 'status' | 'payment'> }) {
  const { label, tone } = bookingStatusLabel(booking);
  return (
    <Badge size="sm" tone={tone}>
      {label}
    </Badge>
  );
}

function priceText(booking: BookingSummary): string {
  const p = booking.price;
  if (!p) return 'No price';
  const fmt = (m: { amountMinor: string; currency: string }) =>
    new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: m.currency,
      maximumFractionDigits: 0,
    }).format(Number(BigInt(m.amountMinor) / 100n));
  return p.kind === 'range' ? `${fmt(p.min)} – ${fmt(p.max)} (estimate)` : fmt(p.total);
}

// ─── /trips ───────────────────────────────────────────────────────────────

export function TripsRoute() {
  useDocumentTitle('My trips');
  const [params, setParams] = useSearchParams();
  const parsedView = bookingViewSchema.safeParse(params.get('view') ?? 'upcoming');
  const view: BookingView = parsedView.success ? parsedView.data : 'upcoming';
  const pageParam = Number(params.get('page') ?? '1');
  const page = Number.isInteger(pageParam) && pageParam >= 1 && pageParam <= 1000 ? pageParam : 1;
  const list = useQuery({
    queryKey: bookingKeys.list(view, page),
    queryFn: ({ signal }) => listBookings({ view, page, pageSize: PAGE_SIZE }, signal),
    placeholderData: (previous) => (previous?.view === view ? previous : undefined),
  });
  const setView = (next: string) =>
    setParams(next === 'upcoming' ? {} : { view: next }, { replace: false });
  const setPage = (next: number) =>
    setParams((current) => {
      const q = new URLSearchParams(current);
      if (next === 1) q.delete('page');
      else q.set('page', String(next));
      return q;
    });
  const counts = list.data?.counts;

  let body: ReactNode;
  if (list.isPending) {
    body = (
      <div role="status" aria-label="Loading your trips" className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
    );
  } else if (list.isError) {
    body = (
      <ErrorState
        title="We couldn't load your trips"
        description="Check your connection, then try again."
        reference={
          list.error instanceof ApiClientError ? (list.error.requestId ?? undefined) : undefined
        }
        action={
          <Button variant="secondary" onClick={() => void list.refetch()} loading={list.isFetching}>
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
        }
      />
    );
  } else if (list.data.items.length === 0) {
    body = (
      <div className="rounded-xl border border-dashed border-line-strong bg-card">
        <EmptyState
          size="page"
          icon={<Luggage />}
          title={EMPTY[view].title}
          description={EMPTY[view].description}
          action={
            view === 'upcoming' ? (
              <Button asChild>
                <Link to="/flights">Search travel</Link>
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  } else {
    const { totalPages } = list.data.pagination;
    body = (
      <div className="flex flex-col gap-4">
        <RevealGroup
          as="ul"
          trigger="mount"
          stagger="tight"
          aria-label={`${VIEW_LABEL[view]} trips`}
          aria-busy={list.isPlaceholderData || undefined}
          className={cn('flex flex-col gap-3', list.isPlaceholderData && 'opacity-60')}
        >
          {list.data.items.map((booking) => (
            <RevealItem as="li" key={booking.reference} distance="sm">
              <TripCard booking={booking} />
            </RevealItem>
          ))}
        </RevealGroup>
        {totalPages > 1 ? (
          <nav aria-label="Pages" className="flex items-center justify-between gap-3">
            <Button
              variant="ghost"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft aria-hidden="true" />
              Previous
            </Button>
            <p className="text-body-sm text-ink-secondary" aria-live="polite">
              Page {page} of {totalPages}
            </p>
            <Button
              variant="ghost"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
            >
              Next
              <ChevronRight aria-hidden="true" />
            </Button>
          </nav>
        ) : null}
      </div>
    );
  }

  return (
    <AccountShell
      title="My trips"
      description="Your demo bookings. Wayora keeps them for you, but none is a supplier reservation or ticket, and demo payments charge no real money."
    >
      <Tabs value={view} onValueChange={setView}>
        <TabsList label="Trips" className="self-start rounded-lg bg-sunken p-1">
          {(['upcoming', 'past', 'cancelled'] as const).map((v) => (
            <TabsTrigger key={v} value={v}>
              {VIEW_LABEL[v]}
              {counts ? (
                <span className="numeric ml-1.5 text-ink-secondary">{counts[v]}</span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        {/* Only the selected panel is mounted (and fetched). */}
        {(['upcoming', 'past', 'cancelled'] as const).map((v) => (
          <TabsContent key={v} value={v} className="pt-4">
            {v === view ? body : null}
          </TabsContent>
        ))}
      </Tabs>
    </AccountShell>
  );
}

function TripCard({ booking }: { booking: BookingSummary }) {
  const service = serviceBySlug[booking.serviceType];
  const Icon = service.icon;
  const heading = offerHeading(booking.offer);
  return (
    <Link
      to={tripPath(booking.reference)}
      className="group flex flex-col gap-4 rounded-xl border border-line bg-card p-4 shadow-xs transition-colors hover:border-line-strong sm:flex-row sm:items-center sm:p-5"
    >
      <span
        aria-hidden="true"
        className="grid size-11 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand-ink [&_svg]:size-5"
      >
        <Icon strokeWidth={1.75} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <StatusBadge booking={booking} />
          <span className="text-caption text-ink-secondary">{service.name}</span>
        </span>
        <span className="text-title group-hover:underline">{heading.title}</span>
        <span className="text-body-sm text-ink-secondary">
          {travelDates(booking)} · {partyText(booking)}
        </span>
      </span>
      <span className="flex flex-row items-baseline justify-between gap-3 sm:flex-col sm:items-end">
        <span className="numeric text-title">{priceText(booking)}</span>
        <span className="font-mono text-caption text-ink-secondary">{booking.reference}</span>
      </span>
    </Link>
  );
}

// ─── Shared loading for one booking ──────────────────────────────────────

export function useBooking(reference: string | null) {
  return useQuery({
    queryKey: bookingKeys.detail(reference ?? ''),
    queryFn: ({ signal }) => getBooking(reference!, signal),
    enabled: reference !== null,
    retry: false,
    // A supplier reservation still settling is read again (the API checks
    // with the supplier on its own schedule; reading never resends anything).
    refetchInterval: (query) => {
      const r = query.state.data?.reservation;
      return r?.kind === 'supplier' && r.state && OPEN_RESERVATION.includes(r.state)
        ? 15_000
        : false;
    },
  });
}

export function BookingNotFound() {
  useDocumentTitle('Booking not found');
  return (
    <Container size="narrow" className="py-section-sm">
      <div className="rounded-xl border border-dashed border-line-strong bg-card">
        <EmptyState
          size="page"
          titleAs="h1"
          icon={<SearchX />}
          title="We couldn't find that booking"
          description="Check the reference. You can only see bookings made with this account."
          action={
            <Button asChild>
              <Link to="/trips">Go to My trips</Link>
            </Button>
          }
        />
      </div>
    </Container>
  );
}

export function BookingLoadState({ query }: { query: ReturnType<typeof useBooking> }) {
  if (query.isError) {
    const api = query.error instanceof ApiClientError ? query.error : null;
    if (api?.status === 404 || api?.code === 'VALIDATION_FAILED') return <BookingNotFound />;
    return (
      <Container size="narrow" className="py-section-sm">
        <h1 className="sr-only">Booking</h1>
        <ErrorState
          title="We couldn't load this booking"
          description="Check your connection, then try again."
          reference={api?.requestId ?? undefined}
          action={
            <Button
              variant="secondary"
              onClick={() => void query.refetch()}
              loading={query.isFetching}
            >
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          }
        />
      </Container>
    );
  }
  return (
    <Container className="py-section-sm">
      <h1 className="sr-only">Booking</h1>
      <div role="status" aria-label="Loading the booking" className="flex flex-col gap-4">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    </Container>
  );
}

export function referenceParam(value: string | undefined): string | null {
  const parsed = bookingReferenceSchema.safeParse(value ?? '');
  return parsed.success ? parsed.data : null;
}

// ─── /trips/:reference/confirmation ──────────────────────────────────────

export function ConfirmationRoute() {
  const reference = referenceParam(useParams().reference);
  const booking = useBooking(reference);
  useDocumentTitle(
    booking.data
      ? `${booking.data.demo ? 'Demo booking' : 'Booking'} ${booking.data.reference}`
      : 'Booking',
  );
  if (reference === null) return <BookingNotFound />;
  if (!booking.data) return <BookingLoadState query={booking} />;
  const b = booking.data;
  // Not confirmed yet: it is waiting for its demo payment. Decide on fresh
  // data only (a cached copy may predate the payment that confirmed it).
  if (b.status === 'pending' && b.payment.mode === 'demo' && booking.isFetching) {
    return <BookingLoadState query={booking} />;
  }
  if (b.status === 'pending' && b.payment.mode === 'demo') {
    return (
      <Navigate
        to={
          b.payment.activePaymentId
            ? paymentPath(b.reference, b.payment.activePaymentId)
            : payPath(b.reference)
        }
        replace
      />
    );
  }
  const heading = offerHeading(b.offer);
  const service = serviceBySlug[b.serviceType];
  if (b.reservation.kind === 'supplier') return <SupplierConfirmation booking={b} />;
  return (
    <Container size="narrow" className="flex flex-col gap-6 py-section-sm">
      <Reveal
        trigger="mount"
        preset="fadeUp"
        className="flex flex-col items-center gap-4 text-center"
      >
        <span
          aria-hidden="true"
          className="grid size-14 place-items-center rounded-full bg-success-soft text-success [&_svg]:size-7"
        >
          <CheckCircle2 />
        </span>
        <div className="flex flex-col gap-2">
          <h1 className="text-heading-1">Your demo booking is saved</h1>
          <p className="text-body-lg text-ink-secondary">
            {service.name}: {heading.title}
          </p>
        </div>
        <div className="flex flex-col items-center gap-1 rounded-xl border border-line bg-card px-6 py-4 shadow-xs">
          <p className="text-caption text-ink-secondary">Wayora demo reference</p>
          <p className="font-mono text-heading-2 tracking-wider">{b.reference}</p>
          <p className="text-caption text-ink-secondary">
            Internal to Wayora: not a supplier, airline or hotel reference.
          </p>
        </div>
        <StatusBadge booking={b} />
      </Reveal>

      {b.payment.state === 'paid' ? (
        <Alert tone="warning" role="none" title="No supplier reservation or ticket">
          Paid with a demo payment: no real money was charged. Wayora saved the booking, but no
          supplier reservation or ticket exists.
        </Alert>
      ) : (
        <Alert tone="warning" role="none" title="No supplier reservation, ticket or payment">
          {DEMO_BOOKING_NOTICE}
        </Alert>
      )}

      <Panel title="What you booked">
        <dl className="grid gap-x-8 gap-y-3 text-body-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="text-ink-secondary">Service</dt>
          <dd>
            {heading.title}
            <span className="block text-ink-secondary">{heading.subtitle}</span>
          </dd>
          <dt className="text-ink-secondary">Travel dates</dt>
          <dd>{travelDates(b)}</dd>
          <dt className="text-ink-secondary">For</dt>
          <dd>{partyText(b)}</dd>
          <dt className="text-ink-secondary">Provider</dt>
          <dd>{b.providerName}</dd>
        </dl>
      </Panel>
      <BookingPriceSummary price={b.price} partyLabel={partyText(b)} demo={b.demo} />

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
        <Button asChild size="lg">
          <Link to={tripPath(b.reference)}>View booking details</Link>
        </Button>
        <Button asChild size="lg" variant="secondary">
          <Link to="/trips">Go to My trips</Link>
        </Button>
      </div>
    </Container>
  );
}

/**
 * After a supplier booking request (Phase 23): what the supplier has said
 * so far, never more. "Confirmed" only when it confirmed.
 */
function SupplierConfirmation({ booking: b }: { booking: Booking }) {
  const heading = offerHeading(b.offer);
  const service = serviceBySlug[b.serviceType];
  const confirmed = b.status === 'confirmed';
  const failed = b.status === 'failed';
  const title = confirmed
    ? `${b.providerName} confirmed your booking`
    : failed
      ? 'Your booking wasn’t confirmed'
      : 'Your booking request was sent';
  useDocumentTitle(title);
  return (
    <Container size="narrow" className="flex flex-col gap-6 py-section-sm">
      <Reveal
        trigger="mount"
        preset="fadeUp"
        className="flex flex-col items-center gap-4 text-center"
      >
        <span
          aria-hidden="true"
          className={cn(
            'grid size-14 place-items-center rounded-full [&_svg]:size-7',
            confirmed
              ? 'bg-success-soft text-success'
              : failed
                ? 'bg-danger-soft text-danger'
                : 'bg-warning-soft text-warning',
          )}
        >
          {confirmed ? <CheckCircle2 /> : failed ? <SearchX /> : <Clock />}
        </span>
        <div className="flex flex-col gap-2">
          <h1 className="text-heading-1">{title}</h1>
          <p className="text-body-lg text-ink-secondary">
            {service.name}: {heading.title}
          </p>
        </div>
        <div className="flex flex-col items-center gap-1 rounded-xl border border-line bg-card px-6 py-4 shadow-xs">
          <p className="text-caption text-ink-secondary">Wayora reference</p>
          <p className="font-mono text-heading-2 tracking-wider">{b.reference}</p>
          {b.reservation.supplierReference ? (
            <p className="text-body-sm">
              {b.providerName} reference{' '}
              <span className="font-mono">{b.reservation.supplierReference}</span>
            </p>
          ) : (
            <p className="text-caption text-ink-secondary">
              Wayora’s own reference, not the supplier’s.
            </p>
          )}
        </div>
        <StatusBadge booking={b} />
      </Reveal>
      <Alert
        tone={confirmed ? 'success' : failed ? 'danger' : 'info'}
        role="none"
        title="Supplier reservation"
      >
        {b.reservation.explanation}
      </Alert>
      <Panel title="What you booked">
        <dl className="grid gap-x-8 gap-y-3 text-body-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="text-ink-secondary">Service</dt>
          <dd>
            {heading.title}
            <span className="block text-ink-secondary">{heading.subtitle}</span>
          </dd>
          <dt className="text-ink-secondary">Travel dates</dt>
          <dd>{travelDates(b)}</dd>
          <dt className="text-ink-secondary">For</dt>
          <dd>{partyText(b)}</dd>
          <dt className="text-ink-secondary">Supplier</dt>
          <dd>{b.providerName}</dd>
          <dt className="text-ink-secondary">Tickets and vouchers</dt>
          <dd>{b.documents.explanation}</dd>
          <dt className="text-ink-secondary">Payment</dt>
          <dd>Wayora took no payment: you pay {b.providerName} under its own terms.</dd>
        </dl>
      </Panel>
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
        <Button asChild size="lg">
          <Link to={tripPath(b.reference)}>View booking details</Link>
        </Button>
        <Button asChild size="lg" variant="secondary">
          <Link to="/trips">Go to My trips</Link>
        </Button>
      </div>
    </Container>
  );
}

// ─── /trips/:reference ───────────────────────────────────────────────────

export function TripDetailRoute() {
  const reference = referenceParam(useParams().reference);
  const booking = useBooking(reference);
  useDocumentTitle(booking.data ? `Booking ${booking.data.reference}` : 'Booking');
  if (reference === null) return <BookingNotFound />;
  if (!booking.data) return <BookingLoadState query={booking} />;
  return <TripDetail booking={booking.data} />;
}

function TripDetail({ booking }: { booking: Booking }) {
  const heading = offerHeading(booking.offer);
  const service = serviceBySlug[booking.serviceType];
  const [cancelledNow, setCancelledNow] = useState(false);
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState(false);
  const checkAgain = () => {
    setChecking(true);
    void queryClient
      .refetchQueries({ queryKey: bookingKeys.detail(booking.reference), exact: true })
      .finally(() => setChecking(false));
  };
  const supplier = booking.reservation.kind === 'supplier';
  // Updates matter only while the booking can still change.
  const live = useTripLiveUpdates(
    booking.reference,
    booking.status === 'pending' || booking.status === 'confirmed',
  );
  const status = useTripStatus(booking.reference);
  return (
    <Container className="flex flex-col gap-6 py-section-sm">
      <Breadcrumbs
        items={[
          { label: 'Home', link: <Link to="/" /> },
          { label: 'My trips', link: <Link to="/trips" /> },
          { label: booking.reference },
        ]}
      />
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge booking={booking} />
          {booking.demo ? <DemoBadge /> : <SupplierBookingBadge />}
          <span className="text-caption text-ink-secondary">{service.name}</span>
        </div>
        <h1 className="text-heading-1">{heading.title}</h1>
        <p className="text-body-lg text-ink-secondary">{heading.subtitle}</p>
        <p className="text-body-sm text-ink-secondary">
          {supplier ? 'Wayora reference' : 'Demo reference'}{' '}
          <span className="font-mono text-ink">{booking.reference}</span> · booked{' '}
          {formatMoment(booking.createdAt)}
        </p>
      </header>
      {cancelledNow && !supplier ? (
        <Alert tone="success" title="Booking cancelled">
          {booking.payment.state === 'refund-required'
            ? 'Only its status changed. No supplier was contacted. Its demo payment would be owed back, but the demo provider can’t refund; no real money was charged.'
            : 'Only its status changed. No supplier was contacted, and nothing is refunded because nothing was paid.'}
        </Alert>
      ) : null}
      {cancelledNow && supplier && booking.status === 'cancelled' ? (
        <Alert tone="success" title="Booking cancelled">
          {booking.cancellation.explanation}
        </Alert>
      ) : null}
      {supplier ? (
        <ReservationAlert booking={booking} />
      ) : (
        <Alert tone="warning" role="none" title="Demo booking">
          {DEMO_BOOKING_NOTICE}
        </Alert>
      )}

      <DisruptionsPanel reference={booking.reference} />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-10">
        <div className="flex min-w-0 flex-col gap-6">
          <BookingStatusPanel booking={booking} onCheck={checkAgain} checking={checking} />
          <TravelStatusPanel reference={booking.reference} query={status} live={live} />
          <Panel title="Trip">
            <dl className="grid gap-x-8 gap-y-3 text-body-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
              <dt className="text-ink-secondary">Travel dates</dt>
              <dd>{travelDates(booking)}</dd>
              <dt className="text-ink-secondary">For</dt>
              <dd>{partyText(booking)}</dd>
              <dt className="text-ink-secondary">Provider</dt>
              <dd>{booking.providerName}</dd>
            </dl>
          </Panel>
          <OfferDetails result={booking.offer} />
          <Panel title={booking.travellers.length > 0 ? 'Travellers' : 'Passengers'}>
            {booking.travellers.length > 0 ? (
              <ul className="flex flex-col gap-1.5 text-body-sm">
                {booking.travellers.map((t, i) => (
                  <li key={i} className="flex flex-wrap justify-between gap-x-4">
                    <span>
                      {t.firstName} {t.lastName}
                    </span>
                    {t.type ? (
                      <span className="text-ink-secondary capitalize">{t.type}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-body-sm text-ink-secondary">
                {partyText(booking)}; this booking needed no names.
              </p>
            )}
            {booking.contactPhone ? (
              <p className="mt-3 flex flex-wrap justify-between gap-x-4 text-body-sm">
                <span className="text-ink-secondary">Mobile number</span>
                <span>{booking.contactPhone}</span>
              </p>
            ) : null}
          </Panel>
          <TripTimelinePanel reference={booking.reference} />
        </div>
        <aside
          aria-label="Price and cancellation"
          className="flex flex-col gap-4 lg:sticky lg:top-[calc(var(--header-offset,5rem)+1rem)]"
        >
          <BookingPriceSummary
            price={booking.price}
            partyLabel={partyText(booking)}
            demo={booking.demo}
          />
          <PaymentPanel booking={booking} />
          <CancelPanel booking={booking} onCancelled={() => setCancelledNow(true)} />
          <BookingSupportPanel reference={booking.reference} />
        </aside>
      </div>
    </Container>
  );
}

const POLICY_TEXT = (policy: NonNullable<Booking['cancellation']['policy']>) =>
  policy.type === 'non-refundable'
    ? 'Non-refundable, under the supplier’s terms.'
    : `Free cancellation until ${formatMoment(policy.until)}, under the supplier’s terms.`;

function CancelPanel({ booking, onCancelled }: { booking: Booking; onCancelled: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const supplier = booking.reservation.kind === 'supplier';
  const cancel = useMutation({
    mutationFn: () => cancelBooking(booking.reference),
    retry: false,
    onSuccess: (updated) => {
      queryClient.setQueryData(bookingKeys.detail(updated.reference), updated);
      void queryClient.invalidateQueries({ queryKey: bookingKeys.lists });
      void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
      setOpen(false);
      onCancelled();
      toast({
        tone: 'success',
        title: !supplier
          ? 'Demo booking cancelled'
          : updated.status === 'cancelled'
            ? 'Booking cancelled'
            : 'Cancellation requested',
      });
    },
    // A refused cancellation leaves the booking as it was: show its current state.
    onError: () =>
      void queryClient.invalidateQueries({ queryKey: bookingKeys.detail(booking.reference) }),
  });
  const cancelError =
    cancel.error instanceof ApiClientError ? cancel.error : cancel.isError ? null : undefined;

  return (
    <section
      aria-labelledby="cancel-heading"
      className="flex flex-col gap-3 rounded-xl border border-line bg-card p-5 shadow-xs"
    >
      <h2 id="cancel-heading" className="text-title">
        Cancellation
      </h2>
      {booking.cancellation.policy ? (
        <p className="text-body-sm">{POLICY_TEXT(booking.cancellation.policy)}</p>
      ) : null}
      {booking.cancellable ? (
        <>
          <p className="text-body-sm text-ink-secondary">
            {supplier ? (
              booking.cancellation.explanation
            ) : (
              <>
                You can cancel this demo booking until the travel date. This offer includes no
                cancellation terms; cancelling only changes the booking&apos;s status.
              </>
            )}
          </p>
          <Dialog open={open} onOpenChange={(next) => !cancel.isPending && setOpen(next)}>
            <Button variant="secondary" onClick={() => setOpen(true)}>
              {supplier ? 'Request cancellation' : 'Cancel demo booking'}
            </Button>
            <DialogContent
              title={supplier ? 'Ask the supplier to cancel?' : 'Cancel this demo booking?'}
              description={
                supplier
                  ? `Wayora asks ${booking.providerName} to cancel it. It is cancelled only when ${booking.providerName} confirms; until then it stays confirmed. Any refund of what you paid follows ${booking.providerName}’s terms.`
                  : booking.payment.state === 'paid'
                    ? 'Its status changes to cancelled. No supplier is contacted. Its demo payment would be owed back, but the demo provider can’t refund; no real money was charged. This can’t be undone.'
                    : booking.payment.state === 'processing'
                      ? 'Its status changes to cancelled, and the demo payment in progress is cancelled too. No supplier is contacted. This can’t be undone.'
                      : 'Its status changes to cancelled. No supplier is contacted, and nothing is refunded because nothing was paid. This can’t be undone.'
              }
              footer={
                <>
                  <DialogClose asChild>
                    <Button variant="ghost" disabled={cancel.isPending}>
                      Keep booking
                    </Button>
                  </DialogClose>
                  <Button
                    variant="destructive"
                    loading={cancel.isPending}
                    onClick={() => cancel.mutate()}
                  >
                    {supplier ? 'Request cancellation' : 'Cancel booking'}
                  </Button>
                </>
              }
            >
              {cancel.isError ? (
                <Alert tone="danger" title="We couldn't cancel it">
                  {cancelError?.code === 'BOOKING_NOT_CANCELLABLE'
                    ? cancelError.message
                    : 'Check your connection and try again.'}
                </Alert>
              ) : (
                <p className="text-body-sm text-ink-secondary">
                  Booking <span className="font-mono">{booking.reference}</span>
                </p>
              )}
            </DialogContent>
          </Dialog>
        </>
      ) : supplier ? (
        <p className="text-body-sm text-ink-secondary">{booking.cancellation.explanation}</p>
      ) : (
        <p className="text-body-sm text-ink-secondary">
          {booking.status === 'cancelled'
            ? 'This booking is cancelled. It stays here, unchanged, for your records.'
            : booking.status === 'expired'
              ? 'This booking expired before it was paid. Nothing was charged.'
              : booking.status === 'failed'
                ? 'This booking failed, so there is nothing to cancel.'
                : 'This trip has started or ended, so it can’t be cancelled.'}
        </p>
      )}
    </section>
  );
}

// ─── Payment panel (Phase 13) ────────────────────────────────────────────

function PaymentPanel({ booking }: { booking: Booking }) {
  const { payment } = booking;
  const attempts = useQuery({
    queryKey: paymentKeys.forBooking(booking.reference),
    queryFn: ({ signal }) => listBookingPayments(booking.reference, signal),
    enabled: payment.mode === 'demo',
  });
  const timeFormat = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit' });
  return (
    <section
      aria-labelledby="payment-heading"
      className="flex flex-col gap-3 rounded-xl border border-line bg-card p-5 shadow-xs"
    >
      <h2 id="payment-heading" className="text-title">
        Payment
      </h2>
      {payment.mode === 'none' ? (
        <p className="text-body-sm text-ink-secondary">
          No payment is taken on Wayora for this booking
          {booking.price?.kind === 'range' ? ' (the fare is an estimate)' : ''}.
        </p>
      ) : (
        <>
          <p className="text-body-sm text-ink-secondary">
            {payment.state === 'paid'
              ? 'Paid with a demo payment. No real money was charged.'
              : payment.state === 'processing'
                ? 'A demo payment is in progress.'
                : payment.state === 'unpaid'
                  ? 'Waiting for a demo payment. It is confirmed once the payment succeeds.'
                  : payment.state === 'refund-required'
                    ? 'Paid with a demo payment, and the booking is now closed. A refund would be owed, but the demo provider can’t refund; no real money was charged.'
                    : 'Not paid. This booking can no longer be paid; nothing was charged.'}
          </p>
          {payment.state === 'unpaid' && payment.dueAt ? (
            <p className="text-body-sm text-ink-secondary">
              Pay by{' '}
              <time dateTime={payment.dueAt}>{timeFormat.format(new Date(payment.dueAt))}</time> or
              it expires.
            </p>
          ) : null}
          {payment.canPay && payment.amount ? (
            <Button asChild>
              <Link to={payPath(booking.reference)}>Pay {money(payment.amount)} (demo)</Link>
            </Button>
          ) : null}
          {payment.activePaymentId ? (
            <Button asChild variant="secondary">
              <Link to={paymentPath(booking.reference, payment.activePaymentId)}>
                View payment in progress
              </Link>
            </Button>
          ) : null}
          {attempts.data && attempts.data.items.length > 0 ? (
            <ol
              aria-label="Payment attempts"
              className="flex flex-col gap-2 border-t border-line pt-3"
            >
              {attempts.data.items.map((a) => {
                const status = paymentStatusLabel(a.status, a.demo);
                return (
                  <li
                    key={a.id}
                    className="flex flex-wrap items-center justify-between gap-2 text-body-sm"
                  >
                    <Link to={paymentPath(booking.reference, a.id)} className="underline">
                      Attempt {a.attempt}
                    </Link>
                    <span className="flex items-center gap-2">
                      <span className="numeric">{money(a.amount)}</span>
                      <Badge size="sm" tone={status.tone}>
                        {status.label}
                      </Badge>
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : null}
        </>
      )}
    </section>
  );
}
