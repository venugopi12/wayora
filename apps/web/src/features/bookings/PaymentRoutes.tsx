import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, RotateCw, SearchX, XCircle } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import {
  PAYMENT_IN_PROGRESS_STATUSES,
  paymentIdSchema,
  type Booking,
  type CreatePaymentRequest,
  type DemoPaymentScenario,
  type Payment,
} from '@wayora/contracts';
import {
  Alert,
  Badge,
  Breadcrumbs,
  Button,
  Container,
  EmptyState,
  ErrorState,
  Radio,
  RadioGroup,
  Skeleton,
  Spinner,
} from '@wayora/ui';
import { Reveal } from '@wayora/ui/motion';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { ApiClientError } from '../../lib/api-client';
import { cancelPayment, createPayment, getPayment } from '../../services/payments';
import { Panel } from '../account/AccountShell';
import { serviceBySlug } from '../navigation/config';
import { offerHeading } from '../offers/OfferDetails';
import { money } from '../search/cards/shared';
import { BookingPriceSummary } from './BookingPriceSummary';
import { CheckoutRewards } from '../rewards/CheckoutRewards';
import { CheckoutPromotions, PriceBreakdown } from '../promotions/CheckoutPromotions';
import { formatMoment, partyText, paymentStatusLabel, travelDates } from './format';
import { notificationKeys } from '../notifications/keys';
import { bookingKeys, paymentKeys } from './keys';
import { confirmationPath, payPath, paymentPath, tripPath } from './paths';
import { BookingLoadState, BookingNotFound, referenceParam, useBooking } from './TripsRoutes';
import { useOffline } from '../../pwa/online';
import { OfflineDataNote } from '../../pwa/PwaNotices';

/*
 * Demo payments (docs/payments.md#web):
 *   /trips/:reference/pay                    review the amount and start a payment
 *   /trips/:reference/payments/:paymentId    follow it until it completes
 *
 * The server is the only source of truth: the amount comes from the booking,
 * the outcome from the provider, and this page only shows what the API says.
 * There is no card form: the demo provider takes no payment details, and a
 * real gateway would collect them on its own hosted page.
 */

const timeFormat = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit' });
/** How often an in-progress payment is checked, and for how long. */
const POLL_MS = 2_000;
const MAX_POLLS = 45;
const IN_PROGRESS_RETRIES = 3;
const IN_PROGRESS_DELAY_MS = 1_500;

const SCENARIOS: { value: DemoPaymentScenario; label: string; description: string }[] = [
  { value: 'succeed', label: 'Approve', description: 'The simulator approves it at once.' },
  { value: 'decline', label: 'Decline', description: 'The simulator declines it at once.' },
  {
    value: 'pending',
    label: 'Pending, then approve',
    description: 'Stays pending for a few seconds, then approved.',
  },
  {
    value: 'pending-decline',
    label: 'Pending, then decline',
    description: 'Stays pending for a few seconds, then declined.',
  },
];

const codeOf = (error: unknown) => (error instanceof ApiClientError ? error.code : null);

/** A whole-page message (the page's one h1). */
function Message({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action: ReactNode;
}) {
  useDocumentTitle(title);
  return (
    <Container size="narrow" className="py-section-sm">
      <div className="rounded-xl border border-dashed border-line-strong bg-card">
        <EmptyState
          size="page"
          titleAs="h1"
          icon={icon}
          title={title}
          description={description}
          action={<div className="flex flex-col gap-3 sm:flex-row">{action}</div>}
        />
      </div>
    </Container>
  );
}

function BookingLinks({ reference }: { reference: string }) {
  return (
    <>
      <Button asChild>
        <Link to={tripPath(reference)}>View booking</Link>
      </Button>
      <Button asChild variant="secondary">
        <Link to="/trips">Go to My trips</Link>
      </Button>
    </>
  );
}

// ─── /trips/:reference/pay ────────────────────────────────────────────────

export function PayRoute() {
  const reference = referenceParam(useParams().reference);
  const booking = useBooking(reference);
  if (reference === null) return <BookingNotFound />;
  if (!booking.data) return <BookingLoadState query={booking} />;
  const b = booking.data;
  // Redirect only on fresh data: a cached copy may still name a payment that
  // has since completed (e.g. "Try again" after a cancelled payment).
  if (booking.isFetching && (b.payment.activePaymentId || !b.payment.canPay)) {
    return <BookingLoadState query={booking} />;
  }
  // A payment already running: follow it instead of starting another.
  if (b.payment.activePaymentId) {
    return <Navigate to={paymentPath(b.reference, b.payment.activePaymentId)} replace />;
  }
  if (!b.payment.canPay) return <NotPayable booking={b} />;
  return <PayReview booking={b} />;
}

function NotPayable({ booking }: { booking: Booking }) {
  const { state } = booking.payment;
  const [title, description] =
    state === 'paid'
      ? ['This booking is already paid', 'Its demo payment succeeded. No real money was charged.']
      : state === 'not-required'
        ? [
            'This booking needs no payment',
            'Nothing is paid on Wayora for this booking (for example, an estimated fare).',
          ]
        : state === 'refund-required'
          ? [
              'This booking can’t be paid',
              'It was closed after a payment completed; see the booking for details.',
            ]
          : booking.status === 'expired'
            ? [
                'This booking expired before it was paid',
                'Nothing was charged. Search again to make a new booking.',
              ]
            : booking.status === 'cancelled'
              ? [
                  'This booking is cancelled',
                  'A cancelled booking can’t be paid. Nothing was charged.',
                ]
              : ['This booking can’t be paid now', 'Check the booking for its current status.'];
  return (
    <Message
      icon={<Clock />}
      title={title}
      description={description}
      action={<BookingLinks reference={booking.reference} />}
    />
  );
}

function PayReview({ booking }: { booking: Booking }) {
  useDocumentTitle('Pay for your demo booking');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const heading = offerHeading(booking.offer);
  const service = serviceBySlug[booking.serviceType];
  const amount = booking.payment.amount!;
  const scenarios = booking.payment.demoScenarios;
  const [scenario, setScenario] = useState<DemoPaymentScenario>('succeed');

  // One idempotency key per distinct request: retries reuse it, so the
  // server starts at most one payment for them; a changed request gets a new one.
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const keyFor = (body: CreatePaymentRequest) => {
    const serialized = JSON.stringify(body);
    if (attempt.current?.body !== serialized) {
      attempt.current = { body: serialized, key: crypto.randomUUID() };
    }
    return attempt.current.key;
  };
  // Set synchronously: a second click in the same tick sends nothing.
  const inFlight = useRef(false);
  const inProgressRetries = useRef(0);
  const [waiting, setWaiting] = useState(false);

  const pay = useMutation({
    mutationFn: (vars: { body: CreatePaymentRequest; key: string }) =>
      createPayment(booking.reference, vars.body, vars.key),
    retry: false,
    onSuccess: (payment) => {
      queryClient.setQueryData(paymentKeys.detail(payment.id), payment);
      void queryClient.invalidateQueries({ queryKey: bookingKeys.detail(booking.reference) });
      void queryClient.invalidateQueries({ queryKey: bookingKeys.lists });
      void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
      void navigate(paymentPath(booking.reference, payment.id), { replace: true });
    },
    onError: (error, vars) => {
      const code = codeOf(error);
      if (code === 'IDEMPOTENCY_IN_PROGRESS' && inProgressRetries.current < IN_PROGRESS_RETRIES) {
        inProgressRetries.current += 1;
        setWaiting(true);
        setTimeout(() => {
          setWaiting(false);
          pay.mutate(vars);
        }, IN_PROGRESS_DELAY_MS);
        return;
      }
      inFlight.current = false;
      if (code === 'IDEMPOTENCY_KEY_REUSED') attempt.current = null;
      if (code === 'PAYMENT_NOT_ALLOWED' || code === 'PAYMENT_AMOUNT_MISMATCH') {
        // The booking changed (paid, expired, a payment started elsewhere…): show its state.
        void queryClient.invalidateQueries({ queryKey: bookingKeys.detail(booking.reference) });
      }
    },
  });

  const start = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    inProgressRetries.current = 0;
    const body: CreatePaymentRequest = {
      amount,
      ...(scenarios ? { demoScenario: scenario } : {}),
    };
    pay.mutate({ body, key: keyFor(body) });
  };
  const busy = pay.isPending || waiting;
  // Payments are never attempted or queued offline.
  const offline = useOffline();
  const code = pay.isError ? codeOf(pay.error) : null;
  const api = pay.error instanceof ApiClientError ? pay.error : null;

  return (
    <Container className="flex flex-col gap-6 py-section-sm">
      <Breadcrumbs
        items={[
          { label: 'Home', link: <Link to="/" /> },
          { label: 'My trips', link: <Link to="/trips" /> },
          { label: booking.reference, link: <Link to={tripPath(booking.reference)} /> },
          { label: 'Pay' },
        ]}
      />
      <header className="flex flex-col gap-1">
        <p className="text-caption font-semibold tracking-wide text-brand-ink uppercase">
          Demo payment · {service.name}
        </p>
        <h1 className="text-heading-1">Pay for your demo booking</h1>
        <p className="text-body-lg text-ink-secondary">{heading.title}</p>
      </header>
      <Alert tone="warning" role="none" title="This is a demo payment">
        No card or bank details are asked for, and no real money is charged. Wayora&apos;s payment
        simulator decides the outcome; nothing reaches a bank or a travel supplier.
      </Alert>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-10">
        <div className="flex min-w-0 flex-col gap-6">
          <Panel title="Booking">
            <dl className="grid gap-x-8 gap-y-3 text-body-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
              <dt className="text-ink-secondary">Reference</dt>
              <dd className="font-mono">{booking.reference}</dd>
              <dt className="text-ink-secondary">Service</dt>
              <dd>
                {heading.title}
                <span className="block text-ink-secondary">{heading.subtitle}</span>
              </dd>
              <dt className="text-ink-secondary">Travel dates</dt>
              <dd>{travelDates(booking)}</dd>
              <dt className="text-ink-secondary">For</dt>
              <dd>{partyText(booking)}</dd>
            </dl>
          </Panel>
          <CheckoutPromotions booking={booking} />
          <CheckoutRewards booking={booking} />
          <Panel title="Payment method">
            <div className="flex flex-col gap-4">
              <p className="flex flex-wrap items-center gap-2 text-body-sm">
                <span className="font-semibold">Wayora demo payments</span>
                <Badge size="sm" tone="warning">
                  Simulated
                </Badge>
              </p>
              <p className="text-body-sm text-ink-secondary">
                A real payment gateway would open its own secure page for card details. Wayora never
                asks for them.
              </p>
              {scenarios ? (
                <RadioGroup
                  legend="Demo outcome (for testing)"
                  hint="Available on demo servers only. The simulator follows this choice; real payments have no such control."
                >
                  {SCENARIOS.filter((s) => scenarios.includes(s.value)).map((s) => (
                    <Radio
                      key={s.value}
                      value={s.value}
                      label={s.label}
                      description={s.description}
                      checked={scenario === s.value}
                      disabled={busy}
                      onChange={() => setScenario(s.value)}
                    />
                  ))}
                </RadioGroup>
              ) : null}
            </div>
          </Panel>
        </div>
        <aside
          aria-label="Amount and payment"
          className="flex flex-col gap-4 lg:sticky lg:top-[calc(var(--header-offset,5rem)+1rem)]"
        >
          <BookingPriceSummary
            price={booking.price}
            partyLabel={partyText(booking)}
            demo={booking.demo}
            title="Amount to pay"
          />
          <PriceBreakdown
            reference={booking.reference}
            fallback={
              booking.payment.rewards ? (
                <dl
                  aria-label="Rewards and amount to pay"
                  className="flex flex-col gap-2 rounded-xl border border-line bg-card p-5 text-body-sm shadow-xs"
                >
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-ink-secondary">Rewards applied</dt>
                    <dd className="numeric text-success-ink">
                      −{money(booking.payment.rewards.amount)}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-4 border-t border-line pt-2">
                    <dt className="font-semibold">To pay</dt>
                    <dd className="numeric text-heading-3">{money(amount)}</dd>
                  </div>
                </dl>
              ) : null
            }
          />
          {booking.payment.dueAt ? (
            <p className="text-body-sm text-ink-secondary">
              Pay by{' '}
              <time dateTime={booking.payment.dueAt}>
                {timeFormat.format(new Date(booking.payment.dueAt))}
              </time>{' '}
              or the booking expires (nothing is charged if it does).
            </p>
          ) : null}
          {code === 'OFFLINE' ? (
            <Alert tone="warning" title="You’re offline: nothing was sent">
              No payment was started. Reconnect, then try again.
            </Alert>
          ) : code === 'PAYMENT_AMOUNT_MISMATCH' ? (
            <Alert tone="danger" title="The amount doesn’t match">
              {api?.message}
            </Alert>
          ) : code === 'PAYMENT_NOT_ALLOWED' ? (
            <Alert tone="danger" title="This booking can’t be paid now">
              {api?.message}
            </Alert>
          ) : code === 'RATE_LIMITED' ? (
            <Alert tone="danger" title="Too many attempts">
              {api?.message}
            </Alert>
          ) : pay.isError && code !== 'IDEMPOTENCY_IN_PROGRESS' ? (
            <Alert tone="danger" title="We couldn’t confirm whether your payment started">
              Try again: the same payment is never started twice.
              {api?.requestId ? ` Reference: ${api.requestId}.` : ''}
            </Alert>
          ) : null}
          <Button
            size="lg"
            fullWidth
            loading={busy}
            disabled={busy || offline}
            onClick={start}
            aria-describedby="pay-note"
          >
            Pay {money(amount)} (demo)
          </Button>
          <p id="pay-note" aria-live="polite" className="text-caption text-ink-secondary">
            {offline
              ? 'You’re offline. Reconnect to pay: nothing is sent until then.'
              : waiting
                ? 'Still starting your payment…'
                : 'Demo payment: no real money will be charged.'}
          </p>
        </aside>
      </div>
    </Container>
  );
}

// ─── /trips/:reference/payments/:paymentId ───────────────────────────────

export function PaymentStatusRoute() {
  const params = useParams();
  const reference = referenceParam(params.reference);
  const parsedId = paymentIdSchema.safeParse(params.paymentId ?? '');
  if (reference === null || !parsedId.success) return <PaymentNotFound />;
  return <PaymentStatus key={parsedId.data} reference={reference} paymentId={parsedId.data} />;
}

function PaymentNotFound() {
  return (
    <Message
      icon={<SearchX />}
      title="We couldn't find that payment"
      description="You can only see payments made with this account."
      action={
        <Button asChild>
          <Link to="/trips">Go to My trips</Link>
        </Button>
      }
    />
  );
}

const isInProgress = (status: Payment['status'] | undefined) =>
  status !== undefined && PAYMENT_IN_PROGRESS_STATUSES.includes(status);

function PaymentStatus({ reference, paymentId }: { reference: string; paymentId: string }) {
  const queryClient = useQueryClient();
  const polls = useRef(0);
  const [pollingStopped, setPollingStopped] = useState(false);
  const payment = useQuery({
    queryKey: paymentKeys.detail(paymentId),
    queryFn: async ({ signal }) => {
      polls.current += 1;
      const result = await getPayment(paymentId, signal);
      if (isInProgress(result.status) && polls.current >= MAX_POLLS) setPollingStopped(true);
      return result;
    },
    // Network and server errors get two more tries; "not found" and other answers don't.
    retry: (count, error) =>
      count < 2 &&
      (!(error instanceof ApiClientError) || error.status === null || error.status >= 500),
    refetchInterval: (query) =>
      isInProgress(query.state.data?.status) && !pollingStopped ? POLL_MS : false,
  });
  const status = payment.data?.status;

  // When it completes, the booking has changed too (confirmed, or still payable).
  const previous = useRef(status);
  useEffect(() => {
    if (previous.current !== status && status && !isInProgress(status)) {
      void queryClient.invalidateQueries({ queryKey: bookingKeys.detail(reference) });
      void queryClient.invalidateQueries({ queryKey: bookingKeys.lists });
      void queryClient.invalidateQueries({ queryKey: paymentKeys.forBooking(reference) });
      void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    }
    previous.current = status;
  }, [status, queryClient, reference]);

  const cancel = useMutation({
    mutationFn: () => cancelPayment(paymentId),
    retry: false,
    onSuccess: (updated) => queryClient.setQueryData(paymentKeys.detail(paymentId), updated),
    onError: () => void payment.refetch(),
  });

  if (payment.isError) {
    const api = payment.error instanceof ApiClientError ? payment.error : null;
    if (api?.status === 404 || api?.status === 400) return <PaymentNotFound />;
    return (
      <Container size="narrow" className="py-section-sm">
        <h1 className="sr-only">Payment status</h1>
        <ErrorState
          title="We couldn't check this payment"
          description="Checking again is safe: it never starts or repeats a payment."
          reference={api?.requestId ?? undefined}
          action={
            <Button
              variant="secondary"
              onClick={() => void payment.refetch()}
              loading={payment.isFetching}
            >
              <RotateCw aria-hidden="true" />
              Check again
            </Button>
          }
        />
      </Container>
    );
  }
  if (!payment.data) {
    return (
      <Container size="narrow" className="py-section-sm">
        <h1 className="sr-only">Payment status</h1>
        <div role="status" aria-label="Loading the payment" className="flex flex-col gap-4">
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      </Container>
    );
  }
  const p = payment.data;
  if (p.bookingReference !== reference) return <PaymentNotFound />;
  return (
    <PaymentStatusView
      loadedAt={payment.dataUpdatedAt}
      payment={p}
      pollingStopped={pollingStopped}
      onCheckAgain={() => {
        polls.current = 0;
        setPollingStopped(false);
        void payment.refetch();
      }}
      cancel={{
        run: () => cancel.mutate(),
        pending: cancel.isPending,
        error: cancel.isError
          ? cancel.error instanceof ApiClientError
            ? cancel.error.message
            : 'Check your connection and try again.'
          : null,
      }}
    />
  );
}

function PaymentStatusView({
  loadedAt,
  payment,
  pollingStopped,
  onCheckAgain,
  cancel,
}: {
  loadedAt: number;
  payment: Payment;
  pollingStopped: boolean;
  onCheckAgain: () => void;
  cancel: { run: () => void; pending: boolean; error: string | null };
}) {
  const { label, tone } = paymentStatusLabel(payment.status, payment.demo);
  const inProgress = isInProgress(payment.status);
  const succeeded = payment.status === 'succeeded';
  const title = inProgress
    ? payment.demo
      ? 'Processing your demo payment'
      : 'Processing your payment'
    : succeeded
      ? payment.demo
        ? 'Demo payment successful'
        : 'Payment successful'
      : payment.status === 'failed'
        ? payment.failure?.code === 'demo_declined'
          ? 'Demo payment declined'
          : 'The payment didn’t go through'
        : payment.status === 'cancelled'
          ? 'Payment cancelled'
          : label;
  useDocumentTitle(title);
  const icon = inProgress ? (
    <Spinner size="lg" label="" />
  ) : succeeded ? (
    <CheckCircle2 />
  ) : (
    <XCircle />
  );
  const iconTone = inProgress
    ? 'bg-sunken text-ink-secondary'
    : succeeded
      ? 'bg-success-soft text-success'
      : 'bg-sunken text-ink-secondary';

  return (
    <Container size="narrow" className="flex flex-col gap-6 py-section-sm">
      <Breadcrumbs
        items={[
          { label: 'Home', link: <Link to="/" /> },
          { label: 'My trips', link: <Link to="/trips" /> },
          {
            label: payment.bookingReference,
            link: <Link to={tripPath(payment.bookingReference)} />,
          },
          { label: 'Payment' },
        ]}
      />
      <OfflineDataNote updatedAt={loadedAt} what="This payment’s status is shown" />
      <Reveal
        key={payment.status}
        trigger="mount"
        preset="fadeUp"
        distance="sm"
        className="flex flex-col items-center gap-4 text-center"
      >
        <span
          aria-hidden="true"
          className={`grid size-14 place-items-center rounded-full [&_svg]:size-7 ${iconTone}`}
        >
          {icon}
        </span>
        <h1 className="text-heading-1">{title}</h1>
        <Badge tone={tone}>{label}</Badge>
      </Reveal>
      {/* Announced when it changes (the page keeps checking while in progress). */}
      <p role="status" aria-live="polite" className="sr-only">
        {`Payment status: ${label}.`}
      </p>

      {payment.notice && (succeeded || payment.status === 'refunded') ? (
        <Alert tone="success" role="none" title={payment.notice}>
          The demo simulator approved it. Your booking has a demo confirmation; no supplier was
          contacted and no ticket was issued.
        </Alert>
      ) : payment.notice ? (
        <Alert tone="warning" role="none" title="Demo payment">
          Simulated by Wayora: no card or bank was involved, and no real money is charged.
        </Alert>
      ) : null}

      {payment.refund.required ? (
        <Alert tone="warning" title="Your booking was closed before this payment completed">
          It was cancelled or expired first, so it stays closed and wasn&apos;t confirmed. A refund
          would be owed;{' '}
          {payment.refund.supported
            ? 'it will be processed by the payment provider.'
            : 'the demo provider can’t process refunds. No real money was charged.'}
        </Alert>
      ) : null}

      {inProgress ? (
        <p className="text-center text-body text-ink-secondary">
          {pollingStopped
            ? 'It’s taking longer than usual. You can leave this page: the booking updates when the payment completes.'
            : 'This usually takes a few seconds. You can leave this page: the booking updates when the payment completes.'}
        </p>
      ) : null}
      {payment.failure ? (
        <p className="text-center text-body text-ink-secondary">{payment.failure.message}</p>
      ) : null}

      <Panel title="Payment">
        <dl className="grid gap-x-8 gap-y-3 text-body-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="text-ink-secondary">Booking</dt>
          <dd className="font-mono">{payment.bookingReference}</dd>
          <dt className="text-ink-secondary">Amount</dt>
          <dd className="numeric">{money(payment.amount)}</dd>
          <dt className="text-ink-secondary">Method</dt>
          <dd>{payment.providerName}</dd>
          <dt className="text-ink-secondary">Attempt</dt>
          <dd>{payment.attempt}</dd>
          <dt className="text-ink-secondary">Started</dt>
          <dd>
            <time dateTime={payment.createdAt}>{formatMoment(payment.createdAt)}</time>
          </dd>
          {payment.completedAt ? (
            <>
              <dt className="text-ink-secondary">Completed</dt>
              <dd>
                <time dateTime={payment.completedAt}>{formatMoment(payment.completedAt)}</time>
              </dd>
            </>
          ) : null}
        </dl>
      </Panel>

      {cancel.error ? (
        <Alert tone="danger" title="We couldn’t cancel the payment">
          {cancel.error}
        </Alert>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
        {inProgress ? (
          <>
            {pollingStopped ? (
              <Button onClick={onCheckAgain}>
                <RotateCw aria-hidden="true" />
                Check again
              </Button>
            ) : null}
            {payment.cancellable ? (
              <Button variant="secondary" loading={cancel.pending} onClick={cancel.run}>
                Cancel payment
              </Button>
            ) : null}
            <Button asChild variant="ghost">
              <Link to={tripPath(payment.bookingReference)}>View booking</Link>
            </Button>
          </>
        ) : succeeded && !payment.refund.required ? (
          <>
            <Button asChild size="lg">
              <Link to={confirmationPath(payment.bookingReference)}>View confirmation</Link>
            </Button>
            <Button asChild size="lg" variant="secondary">
              <Link to={tripPath(payment.bookingReference)}>View booking</Link>
            </Button>
          </>
        ) : payment.status === 'failed' || payment.status === 'cancelled' ? (
          <>
            <Button asChild size="lg">
              <Link to={payPath(payment.bookingReference)}>Try again</Link>
            </Button>
            <Button asChild size="lg" variant="secondary">
              <Link to={tripPath(payment.bookingReference)}>View booking</Link>
            </Button>
          </>
        ) : (
          <BookingLinks reference={payment.bookingReference} />
        )}
      </div>
    </Container>
  );
}
