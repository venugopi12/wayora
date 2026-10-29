import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Clock, Info, RotateCw, SearchX, Store } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { useForm, useWatch, type UseFormReturn } from 'react-hook-form';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { z } from 'zod';
import {
  DEMO_BOOKING_NOTICE,
  SUPPLIER_BOOKING_NOTICE,
  bookingRequirementsFor,
  bookingTravellerInputSchema,
  offerTravelDates,
  phoneE164Schema,
  type BookingRequirements,
  type CreateBookingRequest,
  type OfferResponse,
  type SearchServiceType,
  type Traveller,
} from '@wayora/contracts';
import {
  Alert,
  Breadcrumbs,
  Button,
  Checkbox,
  Container,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  Skeleton,
  cn,
} from '@wayora/ui';
import { Reveal } from '@wayora/ui/motion';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { ApiClientError } from '../../lib/api-client';
import { listTravellers } from '../../services/account';
import { createBooking } from '../../services/bookings';
import { fetchOffer } from '../../services/search';
import { authKeys } from '../auth/AuthProvider';
import { serviceBySlug } from '../navigation/config';
import { OfferDetails, offerHeading } from '../offers/OfferDetails';
import { offerPath, readOfferParams, resultsPathFor } from '../offers/paths';
import { offerKeys } from '../offers/routes';
import { BookingPriceSummary } from './BookingPriceSummary';
import { BookingSteps } from './BookingSteps';
import { notificationKeys } from '../notifications/keys';
import { bookingKeys } from './keys';
import { travelDates } from './format';
import { confirmationPath, payPath, readStep, type CheckoutStep } from './paths';

/*
 * /book/:serviceType/:offerId?sid=&from=[&step=details|review]
 * (docs/bookings.md#web). Signed-in only (RequireAuth).
 *
 * Steps: the offer → the details this category needs → review and confirm.
 * The step is in the URL (so Back works); the details are only in memory,
 * never in the URL or browser storage: a reload starts the details again.
 * Nothing is booked until "Confirm demo booking"; the server then validates
 * the offer again and takes its price from its own copy.
 */

const timeFormat = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit' });

/** Failures the offer (or booking) can't recover from: search again. */
const GONE = new Set([
  'SEARCH_EXPIRED',
  'OFFER_NOT_IN_SEARCH',
  'OFFER_NOT_FOUND',
  'CATEGORY_MISMATCH',
  'OFFER_UNAVAILABLE',
]);
/** Failures that may pass if tried again later. */
const TEMPORARY = new Set([
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'SEARCH_FAILED',
  'SERVICE_UNAVAILABLE',
  'RATE_LIMITED',
]);
/** "Already being created": retried automatically, a few times at most. */
const IN_PROGRESS_RETRIES = 3;
const IN_PROGRESS_DELAY_MS = 1500;

const codeOf = (error: unknown) => (error instanceof ApiClientError ? error.code : null);

export function CheckoutRoute() {
  const routeParams = useParams();
  const [search] = useSearchParams();
  const parsed = readOfferParams(routeParams, search);
  if (!parsed.ok) {
    return (
      <Message
        icon={<SearchX />}
        title="This booking link isn't valid"
        description="It doesn't name an offer Wayora knows. Start from a search instead."
        action={
          <Button asChild>
            <Link to="/">Back to home</Link>
          </Button>
        }
      />
    );
  }
  const resultsPath = resultsPathFor(parsed.serviceType, parsed.from);
  if (parsed.searchId === null) {
    return <OfferGone resultsPath={resultsPath} />;
  }
  return (
    <Checkout
      key={`${parsed.serviceType}|${parsed.resultId}|${parsed.searchId}`}
      serviceType={parsed.serviceType}
      resultId={parsed.resultId}
      searchId={parsed.searchId}
      from={parsed.from}
    />
  );
}

/** A whole-page state (the page's one h1). */
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
          action={action}
        />
      </div>
    </Container>
  );
}

function OfferGone({ resultsPath }: { resultsPath: string }) {
  return (
    <Message
      icon={<Clock />}
      title="This offer can no longer be booked"
      description="Search results are kept for a few minutes, and this one has expired or changed. Search again to see current offers."
      action={
        <Button asChild>
          <Link to={resultsPath}>Search again</Link>
        </Button>
      }
    />
  );
}

function Checkout({
  serviceType,
  resultId,
  searchId,
  from,
}: {
  serviceType: SearchServiceType;
  resultId: string;
  searchId: string;
  from: string | null;
}) {
  const service = serviceBySlug[serviceType];
  const resultsPath = resultsPathFor(serviceType, from);
  const offer = useQuery({
    queryKey: offerKeys.offer(serviceType, searchId, resultId),
    queryFn: ({ signal }) => fetchOffer(serviceType, searchId, resultId, signal),
    retry: false,
    staleTime: 60_000,
  });
  useDocumentTitle(`Book: ${service.name}`);

  if (offer.isError && GONE.has(codeOf(offer.error) ?? '')) {
    return <OfferGone resultsPath={resultsPath} />;
  }
  if (offer.isError) {
    const api = offer.error instanceof ApiClientError ? offer.error : null;
    return (
      <Container size="narrow" className="py-section-sm">
        <h1 className="sr-only">Book {service.name.toLowerCase()}</h1>
        <ErrorState
          title="We couldn't load this offer"
          description={
            api && TEMPORARY.has(api.code) ? api.message : 'Check your connection and try again.'
          }
          reference={api?.requestId ?? undefined}
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
      </Container>
    );
  }
  if (!offer.data) {
    return (
      <Container className="py-section-sm">
        <h1 className="sr-only">Book {service.name.toLowerCase()}</h1>
        <div role="status" aria-label="Loading the offer" className="flex flex-col gap-4">
          <Skeleton className="h-6 w-60" />
          <Skeleton className="h-10 w-2/3" />
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <Skeleton className="h-72 rounded-xl" />
            <Skeleton className="h-56 rounded-xl" />
          </div>
        </div>
      </Container>
    );
  }
  const bookable =
    offer.data.result.source === 'demo' ||
    (offer.data.booking?.available === true && offer.data.booking.kind === 'supplier');
  if (!bookable) {
    // The API refuses it too (SERVICE_UNAVAILABLE); no form is shown for an
    // offer that can't be booked here.
    const offerUrl = offerPath(serviceType, resultId, searchId, from ?? '');
    return (
      <Message
        icon={<Store />}
        title="This supplier offer can’t be booked on Wayora yet"
        description={`${offer.data.booking?.reason ?? 'Wayora can show this supplier’s offer, but booking it isn’t available.'} No reservation, ticket or payment can be made here.`}
        action={
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button asChild>
              <Link to={offerUrl}>Back to the offer</Link>
            </Button>
            <Button asChild variant="secondary">
              <Link to={resultsPath}>Back to results</Link>
            </Button>
          </div>
        }
      />
    );
  }
  return (
    <CheckoutFlow
      offer={offer.data}
      refreshOffer={() => offer.refetch()}
      serviceType={serviceType}
      resultsPath={resultsPath}
      offerUrl={offerPath(serviceType, resultId, searchId, from ?? '')}
    />
  );
}

// ─── The flow ─────────────────────────────────────────────────────────────

interface DetailsValues {
  travellers: { firstName: string; lastName: string }[];
  contactPhone: string | undefined;
}
type DetailsForm = UseFormReturn<
  DetailsValues,
  unknown,
  z.output<ReturnType<typeof detailsSchema>>
>;

/** The API's own rules for this offer's details, so the form can't disagree with the server. */
function detailsSchema(requirements: BookingRequirements) {
  return z.object({
    travellers: z.array(bookingTravellerInputSchema).length(requirements.namedTravellers.length),
    contactPhone:
      requirements.contactPhone === 'required' ? phoneE164Schema : z.string().max(0).optional(),
  });
}

function CheckoutFlow({
  offer,
  refreshOffer,
  serviceType,
  resultsPath,
  offerUrl,
}: {
  offer: OfferResponse;
  refreshOffer: () => Promise<unknown>;
  serviceType: SearchServiceType;
  resultsPath: string;
  offerUrl: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const service = serviceBySlug[serviceType];
  const result = offer.result;
  /** A supplier reservation request (Phase 23) rather than a demo booking. */
  const supplier = result.source !== 'demo';
  const requirements = bookingRequirementsFor(result);
  const heading = offerHeading(result);
  const dates = offerTravelDates(result);
  const partyLabel = `${requirements.partySize} ${requirements.partySize === 1 ? requirements.partyNoun.one : requirements.partyNoun.many}`;

  const form: DetailsForm = useForm<
    DetailsValues,
    unknown,
    z.output<ReturnType<typeof detailsSchema>>
  >({
    resolver: zodResolver(detailsSchema(requirements)),
    defaultValues: {
      travellers: requirements.namedTravellers.map(() => ({ firstName: '', lastName: '' })),
      contactPhone: '',
    },
    mode: 'onTouched',
  });
  const [detailsDone, setDetailsDone] = useState(false);

  // The step is in the URL; review is only reachable with valid details.
  const requested = readStep(params.get('step'));
  const step: CheckoutStep = requested === 'review' && !detailsDone ? 'details' : requested;
  const goTo = (next: CheckoutStep, options: { replace?: boolean } = {}) =>
    setParams(
      (current) => {
        const q = new URLSearchParams(current);
        if (next === 'offer') q.delete('step');
        else q.set('step', next);
        return q;
      },
      { replace: options.replace ?? false },
    );
  useEffect(() => {
    if (requested !== step) goTo(step, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the requested step is corrected
  }, [requested, step]);

  // Move focus to the new step's heading (not on first render).
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    stepHeading.current?.focus();
  }, [step]);

  // One idempotency key per distinct request: retries and double clicks reuse
  // it (the server books once); changed details or a new price get a new one.
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const keyFor = (body: CreateBookingRequest) => {
    const serialized = JSON.stringify(body);
    if (attempt.current?.body !== serialized) {
      attempt.current = { body: serialized, key: crypto.randomUUID() };
    }
    return attempt.current.key;
  };
  const review = useForm<{ accept: boolean }>({ defaultValues: { accept: false } });
  const inProgressRetries = useRef(0);
  // Set synchronously, so a second click in the same tick (before React has
  // re-rendered the button as disabled) sends nothing. The server's
  // idempotency key is the real guarantee; this just avoids the extra request.
  const inFlight = useRef(false);
  const [waiting, setWaiting] = useState(false);
  const create = useMutation({
    mutationFn: (vars: { body: CreateBookingRequest; key: string }) =>
      createBooking(vars.body, vars.key),
    retry: false,
    onSuccess: (booking) => {
      queryClient.setQueryData(bookingKeys.detail(booking.reference), booking);
      void queryClient.invalidateQueries({ queryKey: bookingKeys.lists });
      void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
      // With a payment step, the booking waits for its demo payment.
      void navigate(
        booking.payment.canPay ? payPath(booking.reference) : confirmationPath(booking.reference),
        { replace: true },
      );
    },
    onError: (error, vars) => {
      const code = codeOf(error);
      if (code === 'IDEMPOTENCY_IN_PROGRESS' && inProgressRetries.current < IN_PROGRESS_RETRIES) {
        // Still in flight: the retry below is part of the same attempt.
        // The same booking is still being saved (e.g. an earlier click): ask again shortly.
        inProgressRetries.current += 1;
        setWaiting(true);
        setTimeout(() => {
          setWaiting(false);
          create.mutate(vars);
        }, IN_PROGRESS_DELAY_MS);
        return;
      }
      inFlight.current = false;
      if (code === 'PRICE_CHANGED') {
        review.setValue('accept', false);
        void refreshOffer();
      }
      if (code === 'IDEMPOTENCY_KEY_REUSED') attempt.current = null;
      if (code === 'VALIDATION_FAILED' && error instanceof ApiClientError) {
        let mapped = false;
        for (const issue of error.details) {
          const path = issue.path.replace(/^body\./, '');
          if (/^travellers\.\d+\.(firstName|lastName)$/.test(path) || path === 'contactPhone') {
            form.setError(path as 'contactPhone', { message: issue.message });
            mapped = true;
          }
        }
        if (mapped) {
          setDetailsDone(false);
          goTo('details');
        }
      }
    },
  });

  // Built when confirming (an event), never during render.
  const confirm = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const values = form.getValues();
    const body: CreateBookingRequest = {
      serviceType,
      searchId: offer.searchId,
      offerId: result.id,
      travellers: values.travellers,
      ...(requirements.contactPhone === 'required' ? { contactPhone: values.contactPhone } : {}),
      acceptedPrice: result.price,
      ...(supplier ? { acceptSupplierTerms: true } : { acceptDemoTerms: true }),
    };
    inProgressRetries.current = 0;
    create.mutate({ body, key: keyFor(body) });
  };
  const submitBooking = () => void review.handleSubmit(confirm)();

  const errorCode = create.isError ? codeOf(create.error) : null;
  if (errorCode && GONE.has(errorCode)) return <OfferGone resultsPath={resultsPath} />;
  const busy = create.isPending || waiting;

  return (
    <Container className="flex flex-col gap-6 py-section-sm">
      <Breadcrumbs
        items={[
          { label: 'Home', link: <Link to="/" /> },
          { label: `${service.name} results`, link: <Link to={resultsPath} /> },
          { label: 'Offer', link: <Link to={offerUrl} /> },
          { label: 'Book' },
        ]}
      />
      <header className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-caption font-semibold tracking-wide text-brand-ink uppercase">
            {supplier ? 'Booking request' : 'Demo booking'} · {service.name}
          </p>
          <h1 className="text-heading-1">{heading.title}</h1>
          <p className="text-body-lg text-ink-secondary">{heading.subtitle}</p>
        </div>
        <BookingSteps current={step} />
      </header>
      {supplier ? (
        <Alert tone="info" role="none" title="A booking request, confirmed only by the supplier">
          {SUPPLIER_BOOKING_NOTICE}
        </Alert>
      ) : (
        <Alert tone="warning" role="none" title="This is a demo booking">
          {DEMO_BOOKING_NOTICE}
        </Alert>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-10">
        <div className="flex min-w-0 flex-col gap-6">
          <Reveal
            key={step}
            trigger="mount"
            preset="fadeUp"
            distance="sm"
            className="flex flex-col gap-6"
          >
            {step === 'offer' ? (
              <OfferStep
                headingRef={stepHeading}
                offer={offer}
                supplier={supplier}
                onContinue={() => goTo('details')}
              />
            ) : step === 'details' ? (
              <DetailsStep
                headingRef={stepHeading}
                supplier={supplier}
                form={form}
                requirements={requirements}
                onBack={() => goTo('offer')}
                onContinue={form.handleSubmit(() => {
                  setDetailsDone(true);
                  goTo('review');
                })}
              />
            ) : (
              <ReviewStep
                headingRef={stepHeading}
                supplier={supplier}
                offer={offer}
                requirements={requirements}
                values={form.getValues()}
                review={review}
                busy={busy}
                waiting={waiting}
                error={create.isError ? create.error : null}
                onEdit={() => goTo('details')}
                onBack={() => goTo('details')}
                onSubmit={submitBooking}
              />
            )}
          </Reveal>
        </div>

        <aside
          aria-label="Booking summary"
          className="flex flex-col gap-4 lg:sticky lg:top-[calc(var(--header-offset,5rem)+1rem)]"
        >
          <div className="flex flex-col gap-1 rounded-xl border border-line bg-card p-5 shadow-xs">
            <p className="text-caption text-ink-secondary">{service.name}</p>
            <p className="text-title">{heading.title}</p>
            <p className="text-body-sm text-ink-secondary">
              {travelDates({ startsOn: dates.startsOn, endsOn: dates.endsOn })}
            </p>
            <p className="text-body-sm text-ink-secondary">{partyLabel}</p>
          </div>
          <BookingPriceSummary
            price={result.price}
            partyLabel={partyLabel}
            demo={result.source === 'demo'}
          />
          <p className="text-caption text-ink-secondary">
            Offer from this search until{' '}
            <time dateTime={offer.expiresAt}>{timeFormat.format(new Date(offer.expiresAt))}</time>.
          </p>
        </aside>
      </div>
    </Container>
  );
}

// ─── Steps ────────────────────────────────────────────────────────────────

function StepHeading({
  headingRef,
  children,
}: {
  headingRef: Ref<HTMLHeadingElement>;
  children: ReactNode;
}) {
  return (
    <h2 ref={headingRef} tabIndex={-1} className="text-heading-2 outline-none">
      {children}
    </h2>
  );
}

function OfferStep({
  headingRef,
  offer,
  supplier,
  onContinue,
}: {
  headingRef: Ref<HTMLHeadingElement>;
  offer: OfferResponse;
  supplier: boolean;
  onContinue: () => void;
}) {
  return (
    <>
      <div className="flex flex-col gap-1">
        <StepHeading headingRef={headingRef}>Check the offer</StepHeading>
        <p className="text-body-sm text-ink-secondary">
          {offer.validation.status === 'session'
            ? supplier
              ? 'As your search found it; not rechecked with the supplier. The supplier confirms the price when it confirms the reservation.'
              : 'As your search found it. Demo offers are not rechecked with any supplier.'
            : `Checked with the provider at ${timeFormat.format(new Date(offer.validation.checkedAt!))}.`}
        </p>
      </div>
      {offer.validation.status === 'price-changed' ? (
        <Alert tone="warning" title="The price has changed since you searched">
          The price shown is the provider&apos;s current price. You&apos;ll confirm it before
          booking.
        </Alert>
      ) : null}
      <OfferDetails result={offer.result} />
      <div className="flex justify-end">
        <Button size="lg" onClick={onContinue}>
          Continue to traveller details
        </Button>
      </div>
    </>
  );
}

function DetailsStep({
  headingRef,
  supplier,
  form,
  requirements,
  onBack,
  onContinue,
}: {
  headingRef: Ref<HTMLHeadingElement>;
  supplier: boolean;
  form: DetailsForm;
  requirements: BookingRequirements;
  onBack: () => void;
  onContinue: () => void;
}) {
  const saved = useQuery({
    queryKey: authKeys.travellers,
    queryFn: ({ signal }) => listTravellers(signal),
    staleTime: 60_000,
  });
  const savedTravellers: Traveller[] = saved.data ?? [];
  const { errors } = form.formState;
  const fill = (index: number, travellerId: string) => {
    const t = savedTravellers.find((s) => s.id === travellerId);
    if (!t) return;
    form.setValue(`travellers.${index}.firstName`, t.firstName, {
      shouldValidate: true,
      shouldDirty: true,
    });
    form.setValue(`travellers.${index}.lastName`, t.lastName, {
      shouldValidate: true,
      shouldDirty: true,
    });
  };
  const nothingToAsk =
    requirements.namedTravellers.length === 0 && requirements.contactPhone !== 'required';

  return (
    <form
      noValidate
      aria-labelledby="details-heading"
      onSubmit={(e) => {
        e.preventDefault();
        onContinue();
      }}
      className="flex flex-col gap-6"
    >
      <div className="flex flex-col gap-1" id="details-heading">
        <StepHeading headingRef={headingRef}>
          {nothingToAsk ? 'No traveller details needed' : 'Who is travelling?'}
        </StepHeading>
        <p className="text-body-sm text-ink-secondary">
          {nothingToAsk
            ? 'Nothing to fill in for this booking.'
            : supplier
              ? 'Only what this booking needs. Names are sent to the supplier for this reservation only.'
              : 'Only what this booking needs. Names are used for this demo booking only.'}
        </p>
      </div>
      {requirements.note ? (
        <p className="flex gap-2 rounded-lg bg-info-soft px-4 py-3 text-body-sm text-ink-secondary">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {requirements.note}
        </p>
      ) : null}

      {requirements.namedTravellers.map((slot, i) => {
        const fieldErrors = errors.travellers?.[i];
        return (
          <fieldset
            key={slot.label}
            className="flex flex-col gap-4 rounded-xl border border-line bg-card p-5 shadow-xs"
          >
            <legend className="sr-only">{slot.label}</legend>
            <div className="flex flex-wrap items-center justify-between gap-3" aria-hidden="true">
              <p className="text-title">{slot.label}</p>
            </div>
            {savedTravellers.length > 0 ? (
              <Field
                label="Fill from a saved traveller"
                hint="Optional. You can still edit the names."
              >
                <Select
                  defaultValue=""
                  onChange={(e) => fill(i, e.target.value)}
                  placeholder="Choose a saved traveller"
                  options={savedTravellers.map((t) => ({
                    value: t.id,
                    label: `${t.firstName} ${t.lastName}`,
                  }))}
                />
              </Field>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="First name" error={fieldErrors?.firstName?.message} required>
                <Input
                  autoComplete={i === 0 ? 'given-name' : 'off'}
                  {...form.register(`travellers.${i}.firstName`)}
                />
              </Field>
              <Field label="Last name" error={fieldErrors?.lastName?.message} required>
                <Input
                  autoComplete={i === 0 ? 'family-name' : 'off'}
                  {...form.register(`travellers.${i}.lastName`)}
                />
              </Field>
            </div>
          </fieldset>
        );
      })}

      {requirements.contactPhone === 'required' ? (
        <div className="rounded-xl border border-line bg-card p-5 shadow-xs">
          <Field
            label="Mobile number"
            hint="For the driver, in international format, e.g. +91 98765 43210. Stored only with this demo booking."
            error={errors.contactPhone?.message}
            required
          >
            <Input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              {...form.register('contactPhone')}
            />
          </Field>
        </div>
      ) : null}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <Button type="button" variant="ghost" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          Back to the offer
        </Button>
        <Button type="submit" size="lg">
          Continue to review
        </Button>
      </div>
    </form>
  );
}

function ReviewStep({
  headingRef,
  supplier,
  offer,
  requirements,
  values,
  review,
  busy,
  waiting,
  error,
  onEdit,
  onBack,
  onSubmit,
}: {
  headingRef: Ref<HTMLHeadingElement>;
  supplier: boolean;
  offer: OfferResponse;
  requirements: BookingRequirements;
  values: DetailsValues;
  review: UseFormReturn<{ accept: boolean }>;
  busy: boolean;
  waiting: boolean;
  error: unknown;
  onEdit: () => void;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const accepted = useWatch({ control: review.control, name: 'accept' });
  const code = codeOf(error);
  const api = error instanceof ApiClientError ? error : null;
  let problem: ReactNode = null;
  if (code === 'PRICE_CHANGED') {
    problem = (
      <Alert tone="danger" title="The price has changed">
        The offer now shows the provider&apos;s current price. Check it, then confirm again.
      </Alert>
    );
  } else if (code === 'IDEMPOTENCY_IN_PROGRESS') {
    problem = (
      <Alert tone="warning" title="Your booking is still being saved">
        It may already be in <Link to="/trips">My trips</Link>. Check there before trying again.
      </Alert>
    );
  } else if (api && TEMPORARY.has(api.code)) {
    problem = (
      <Alert tone="danger" title="We couldn't book this right now">
        {api.message}
      </Alert>
    );
  } else if (error && code !== 'VALIDATION_FAILED') {
    problem = (
      <Alert tone="danger" title="We couldn't confirm whether your booking was saved">
        Check your connection and confirm again: the same booking is never created twice.
        {api?.requestId ? ` Reference: ${api.requestId}.` : ''}
      </Alert>
    );
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) onSubmit();
      }}
      className="flex flex-col gap-6"
    >
      <div className="flex flex-col gap-1">
        <StepHeading headingRef={headingRef}>Review and confirm</StepHeading>
        <p className="text-body-sm text-ink-secondary">
          Nothing is booked until you confirm. Check the details and the price.
        </p>
      </div>

      <section
        aria-labelledby="review-travellers"
        className="flex flex-col gap-3 rounded-xl border border-line bg-card p-5 shadow-xs"
      >
        <div className="flex items-center justify-between gap-3">
          <h3 id="review-travellers" className="text-title">
            {requirements.namedTravellers.length > 0 ? 'Travellers' : 'Passengers'}
          </h3>
          {requirements.namedTravellers.length > 0 || requirements.contactPhone === 'required' ? (
            <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
              Edit
            </Button>
          ) : null}
        </div>
        {requirements.namedTravellers.length > 0 ? (
          <ul className="flex flex-col gap-1.5 text-body-sm">
            {requirements.namedTravellers.map((slot, i) => (
              <li key={slot.label} className="flex flex-wrap justify-between gap-x-4">
                <span className="text-ink-secondary">{slot.label}</span>
                <span className="text-ink">
                  {values.travellers[i]?.firstName} {values.travellers[i]?.lastName}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body-sm text-ink-secondary">
            {requirements.partySize}{' '}
            {requirements.partySize === 1
              ? requirements.partyNoun.one
              : requirements.partyNoun.many}
            ; no names needed.
          </p>
        )}
        {requirements.contactPhone === 'required' ? (
          <p className="flex flex-wrap justify-between gap-x-4 text-body-sm">
            <span className="text-ink-secondary">Mobile number</span>
            <span className="text-ink">{values.contactPhone}</span>
          </p>
        ) : null}
      </section>

      {supplier ? (
        <section
          aria-labelledby="booking-terms"
          className="flex flex-col gap-3 rounded-xl border border-line bg-sunken p-5"
        >
          <h3 id="booking-terms" className="text-title">
            How this booking works
          </h3>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-body-sm text-ink-secondary">
            <li>
              Wayora sends this reservation request to the supplier. It is confirmed only when the
              supplier confirms it; until then it isn&apos;t booked.
            </li>
            <li>
              Wayora takes no payment. You pay the supplier under its own terms, which also decide
              cancellations and refunds.
            </li>
            <li>
              If the supplier doesn&apos;t answer clearly, Wayora checks with it and never sends a
              second request on its own.
            </li>
          </ul>
          <Checkbox
            label="I understand how this supplier booking works"
            {...review.register('accept', { required: true })}
          />
        </section>
      ) : (
        <section
          aria-labelledby="demo-terms"
          className="flex flex-col gap-3 rounded-xl border border-line bg-sunken p-5"
        >
          <h3 id="demo-terms" className="text-title">
            Demo terms
          </h3>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-body-sm text-ink-secondary">
            <li>
              This is a demo. Wayora saves the booking, but no supplier reservation, ticket or
              payment is made, and nothing is charged.
            </li>
            <li>The price is this demo offer&apos;s price, not a supplier guarantee.</li>
            <li>
              If a payment step follows, it is a demo payment: no card details are asked for and no
              real money moves.
            </li>
            <li>
              You can cancel it in My trips until the travel date. Cancelling only changes its
              status. This offer includes no cancellation terms, and nothing is refunded because
              nothing is paid.
            </li>
          </ul>
          <Checkbox
            label="I understand this is a demo booking"
            {...review.register('accept', { required: true })}
          />
        </section>
      )}

      {problem}
      {offer.result.price === null ? (
        <Alert tone="danger" title="This offer has no price">
          It can&apos;t be booked.
        </Alert>
      ) : null}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
          <ArrowLeft aria-hidden="true" />
          Back to details
        </Button>
        <div className="flex flex-col items-stretch gap-2 sm:items-end">
          <Button
            type="submit"
            size="lg"
            loading={busy}
            disabled={!accepted || busy || offer.result.price === null}
            aria-describedby={accepted ? undefined : 'confirm-hint'}
          >
            {supplier ? 'Send booking request' : 'Confirm demo booking'}
          </Button>
          <p
            id="confirm-hint"
            aria-live="polite"
            className={cn('text-caption text-ink-secondary', accepted && !waiting && 'sr-only')}
          >
            {waiting
              ? 'Still saving your booking…'
              : accepted
                ? ''
                : supplier
                  ? 'Tick “I understand how this supplier booking works” to send it.'
                  : 'Tick “I understand this is a demo booking” to confirm.'}
          </p>
        </div>
      </div>
    </form>
  );
}
