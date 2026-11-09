import { vi } from 'vitest';
import {
  BOOKING_REFERENCE_ALPHABET,
  bookingListResponseSchema,
  bookingRequirementsFor,
  bookingSchema,
  DEMO_PAYMENT_NOTICE,
  DEMO_PAYMENT_SCENARIOS,
  createBookingRequestSchema,
  createPaymentRequestSchema,
  offerTravelDates,
  paymentListResponseSchema,
  paymentSchema,
  notificationListResponseSchema,
  notificationPreferencesSchema,
  PUSH_NOT_CONFIGURED_STATUS,
  notificationSchema,
  type Booking,
  type BookingPayment,
  type Notification,
  type NotificationPreferences,
  type Payment,
  type BookingView,
  type SearchResponse,
  type SearchResult,
  type Traveller,
  tripEventSchema,
  tripStatusSchema,
  type TripDisruption,
  type TripEvent,
  type TripStatus,
} from '@wayora/contracts';
import { installFakeAccountApi } from './fake-account-api';
import { installFakeSearchApi, searchResponse } from './fake-search-api';

/*
 * A stand-in for the bookings API, combined with the account and search
 * fakes (one `fetch` routes to all three). It follows the contract and the
 * API's documented rules closely enough to drive the UI:
 *   - the session cookie decides the user (nothing from the browser),
 *   - POST /bookings needs an Idempotency-Key; the same key and body replays
 *     the first booking, the same key with another body is refused,
 *   - the price comes from the stored search, and `acceptedPrice` must match.
 *   - payments (Phase 13, `payments: 'demo'`): the amount must equal the
 *     booking's, the outcome is the simulated scenario (the test settles
 *     pending ones), and a successful payment confirms the booking.
 * The API's real behaviour (PostgreSQL, concurrency) is covered by
 * apps/api/test/integration/bookings.test.ts and payments.test.ts.
 */

export interface BookingPost {
  key: string | null;
  body: Record<string, unknown>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
const ok = (data: unknown, status = 200, headers?: Record<string, string>) =>
  json(status, { data, meta: { requestId: 'req-booking' } }, headers);
const fail = (status: number, code: string, message: string, details?: unknown[]) =>
  json(status, {
    error: { code, message, requestId: 'req-booking', ...(details ? { details } : {}) },
  });

let counter = 0;
function nextReference(): string {
  counter += 1;
  const chars = Array.from({ length: 8 }, (_, i) => {
    const n = Math.floor(counter / BOOKING_REFERENCE_ALPHABET.length ** i);
    return BOOKING_REFERENCE_ALPHABET[n % BOOKING_REFERENCE_ALPHABET.length];
  }).join('');
  return `WYD-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

const NO_PAYMENT: BookingPayment = {
  mode: 'none',
  state: 'not-required',
  amount: null,
  dueAt: null,
  canPay: false,
  activePaymentId: null,
  demoScenarios: null,
};

/** The payment side of a booking that waits for a demo payment. */
export function unpaidDemo(offer: SearchResult): BookingPayment {
  if (offer.price?.kind !== 'total') return NO_PAYMENT;
  return {
    mode: 'demo',
    state: 'unpaid',
    amount: offer.price.total,
    dueAt: '2030-01-01T10:30:00.000Z',
    canPay: true,
    activePaymentId: null,
    demoScenarios: [...DEMO_PAYMENT_SCENARIOS],
  };
}

// The supplier side of a booking, as the API presents it (Phase 23).
const DEMO_RESERVATION: Booking['reservation'] = {
  kind: 'demo',
  state: null,
  supplierReference: null,
  confirmedAt: null,
  priceMismatch: false,
  needsAttention: false,
  explanation: 'Demo booking: no supplier reservation was made.',
};
const DEMO_DOCUMENTS: Booking['documents'] = {
  state: 'not-applicable',
  items: [],
  explanation: 'Demo booking: no ticket, voucher or PNR exists.',
};
function demoCancellation(
  status: Booking['status'],
  cancellable: boolean,
): Booking['cancellation'] {
  return {
    available: cancellable,
    state: status === 'cancelled' ? 'cancelled' : 'not-requested',
    explanation:
      status === 'cancelled'
        ? 'Cancelled. Only the booking’s status changed; no supplier was contacted.'
        : cancellable
          ? 'You can cancel this demo booking until the travel date. Only its status changes.'
          : 'This booking can’t be cancelled now.',
    policy: null,
  };
}
function demoRefund(payment: BookingPayment): Booking['refund'] {
  return payment.state === 'refund-required'
    ? {
        state: 'required',
        amount: payment.amount,
        demo: true,
        explanation:
          'A refund would be owed, but this was a demo payment: no real money was charged, and the demo provider can’t refund.',
      }
    : {
        state: 'not-applicable',
        amount: null,
        demo: true,
        explanation: 'Nothing was paid, so there is nothing to refund.',
      };
}

const SUPPLIER = 'Fixture Air (test supplier)';
const SUPPLIER_EXPLANATION: Record<NonNullable<Booking['reservation']['state']>, string> = {
  requested: `Recorded by Wayora and being sent to ${SUPPLIER}.`,
  'in-progress': `Sent to ${SUPPLIER}, waiting for its confirmation. Nothing is confirmed until ${SUPPLIER} confirms it.`,
  unknown: `${SUPPLIER} didn’t give a clear answer, so Wayora is checking whether it reserved it. Wayora won’t send another request until it knows.`,
  confirmed: `${SUPPLIER} confirmed this reservation.`,
  failed: `${SUPPLIER} didn’t reserve it (the offer was no longer available), so nothing is booked. Wayora took no payment.`,
  'cancellation-pending': `You asked ${SUPPLIER} to cancel it. It stays confirmed until ${SUPPLIER} confirms the cancellation.`,
  cancelled: `${SUPPLIER} confirmed the cancellation.`,
};

/**
 * A supplier booking (Phase 23) of a supplier `offer`, in a given
 * reservation state: from the TEST-ONLY fixture supplier, never real.
 */
export function supplierBooking(
  offer: SearchResult,
  {
    state = 'confirmed',
    reference = nextSupplierReference(),
    createdAt = '2026-10-22T09:00:00+00:00',
    cancel = true,
    needsAttention = false,
    tickets = true,
  }: {
    state?: NonNullable<Booking['reservation']['state']>;
    reference?: string;
    createdAt?: string;
    /** The supplier can cancel through Wayora. */
    cancel?: boolean;
    needsAttention?: boolean;
    tickets?: boolean;
  } = {},
): Booking {
  const requirements = bookingRequirementsFor(offer);
  const dates = offerTravelDates(offer);
  const status: Booking['status'] =
    state === 'confirmed' || state === 'cancellation-pending'
      ? 'confirmed'
      : state === 'failed'
        ? 'failed'
        : state === 'cancelled'
          ? 'cancelled'
          : 'pending';
  const confirmed = ['confirmed', 'cancellation-pending', 'cancelled'].includes(state);
  const cancellable = state === 'confirmed' && cancel;
  return bookingSchema.parse({
    reference,
    status,
    demo: false,
    serviceType: offer.serviceType,
    offer,
    providerName: SUPPLIER,
    price: offer.price,
    partySize: requirements.partySize,
    startsOn: dates.startsOn,
    endsOn: dates.endsOn,
    createdAt,
    cancellable,
    payment: NO_PAYMENT,
    reservation: {
      kind: 'supplier',
      state,
      supplierReference: confirmed ? 'FXR00001' : null,
      confirmedAt: confirmed ? createdAt : null,
      priceMismatch: false,
      needsAttention,
      explanation: needsAttention
        ? `${SUPPLIER_EXPLANATION[state]} Our team is confirming it with ${SUPPLIER} directly; nothing else is sent until then.`
        : SUPPLIER_EXPLANATION[state],
    },
    documents:
      confirmed && tickets
        ? {
            state: 'issued',
            items: [
              {
                type: 'ticket',
                reference: '098000010001',
                travellerName: 'Asha Rao',
                issuedAt: createdAt,
              },
            ],
            explanation: `Issued by ${SUPPLIER}.`,
          }
        : {
            state: 'none-issued',
            items: [],
            explanation: confirmed
              ? `${SUPPLIER} hasn’t issued a ticket or voucher through Wayora. Use the supplier reference with ${SUPPLIER}.`
              : `A ticket or voucher can exist only after ${SUPPLIER} confirms the reservation.`,
          },
    cancellation: {
      available: cancellable,
      state:
        state === 'cancelled'
          ? 'cancelled'
          : state === 'cancellation-pending'
            ? 'pending'
            : 'not-requested',
      explanation:
        state === 'cancelled'
          ? `Cancelled: ${SUPPLIER} confirmed it.`
          : state === 'cancellation-pending'
            ? `Waiting for ${SUPPLIER} to confirm the cancellation. The booking stays confirmed until it does.`
            : cancellable
              ? `Cancelling asks ${SUPPLIER} to cancel it; it is cancelled only when ${SUPPLIER} confirms. Any refund of what you paid ${SUPPLIER} follows its terms.`
              : confirmed
                ? 'Cancelling this booking isn’t available through Wayora. Contact the supplier with its reference, under its own terms.'
                : 'The supplier hasn’t confirmed this booking yet, so it can’t be cancelled. If it doesn’t confirm it, nothing is reserved.',
      policy: null,
    },
    refund: {
      state: 'not-applicable',
      amount: null,
      demo: false,
      explanation: `Wayora took no payment for this booking. Any refund of what you paid ${SUPPLIER} follows its terms.`,
    },
    travellers: requirements.namedTravellers.map((slot) => ({
      firstName: 'Asha',
      lastName: 'Rao',
      type: slot.type ?? null,
    })),
    contactPhone: null,
    priceCheck: 'session',
    history: [
      { status: 'pending', at: createdAt, by: 'you', note: null },
      ...(status === 'pending'
        ? []
        : [
            {
              status: status === 'failed' ? 'failed' : 'confirmed',
              at: createdAt,
              by: 'supplier',
              note: status === 'failed' ? null : `Confirmed by ${SUPPLIER}.`,
            },
          ]),
      ...(status === 'cancelled'
        ? [{ status: 'cancelled', at: createdAt, by: 'supplier', note: null }]
        : []),
    ],
  });
}

let supplierCounter = 0;
/** WY-SUP?-???? from the reference alphabet: unique per call. */
function nextSupplierReference(): string {
  supplierCounter += 1;
  const chars = Array.from({ length: 5 }, (_, i) => {
    const n = Math.floor(supplierCounter / BOOKING_REFERENCE_ALPHABET.length ** i);
    return BOOKING_REFERENCE_ALPHABET[n % BOOKING_REFERENCE_ALPHABET.length];
  }).join('');
  return `WY-SUP${chars.slice(0, 1)}-${chars.slice(1)}`;
}

/** A confirmed demo booking of `offer`, shaped like the API's. */
export function demoBooking(
  offer: SearchResult,
  {
    travellers,
    contactPhone = null,
    createdAt = '2026-10-22T09:00:00+00:00',
    status = 'confirmed',
    reference = nextReference(),
    payment = NO_PAYMENT,
  }: {
    travellers?: { firstName: string; lastName: string }[];
    contactPhone?: string | null;
    createdAt?: string;
    status?: Booking['status'];
    reference?: string;
    payment?: BookingPayment;
  } = {},
): Booking {
  const requirements = bookingRequirementsFor(offer);
  const names =
    travellers ??
    requirements.namedTravellers.map((_, i) => ({ firstName: 'Asha', lastName: `Rao ${i + 1}` }));
  const dates = offerTravelDates(offer);
  const cancellable = status === 'confirmed' || status === 'pending';
  return bookingSchema.parse({
    reference,
    status,
    demo: true,
    serviceType: offer.serviceType,
    offer,
    providerName: 'Wayora demo provider',
    price: offer.price,
    partySize: requirements.partySize,
    startsOn: dates.startsOn,
    endsOn: dates.endsOn,
    createdAt,
    cancellable,
    payment,
    reservation: DEMO_RESERVATION,
    documents: DEMO_DOCUMENTS,
    cancellation: demoCancellation(status, cancellable),
    refund: demoRefund(payment),
    travellers: names.map((t, i) => ({
      ...t,
      type: requirements.namedTravellers[i]?.type ?? null,
    })),
    contactPhone,
    priceCheck: 'session',
    history: [
      { status: 'pending', at: createdAt, by: 'you', note: null },
      ...(status === 'pending'
        ? []
        : [
            {
              status: 'confirmed',
              at: createdAt,
              by: 'wayora',
              note: 'Demo confirmation: no supplier was contacted.',
            },
          ]),
      ...(status === 'cancelled'
        ? [{ status: 'cancelled', at: createdAt, by: 'you', note: null }]
        : []),
    ],
  });
}

const summary = ({
  travellers: _t,
  contactPhone: _p,
  priceCheck: _c,
  history: _h,
  documents: _d,
  cancellation: _x,
  refund: _r,
  ...rest
}: Booking) => rest;

export function installFakeBookingApi({
  results,
  travellers = [],
  bookings = [],
  signedIn = true,
  payments: paymentMode = 'none',
  notifications: initialNotifications = [],
  supplier = {},
}: {
  results: SearchResult[];
  travellers?: Traveller[];
  bookings?: Booking[];
  signedIn?: boolean;
  /** `demo`: new bookings wait for a demo payment (Phase 13). */
  payments?: 'none' | 'demo';
  /** The signed-in user's notifications, newest first (Phase 14). */
  notifications?: Notification[];
  /**
   * Supplier bookings (Phase 23, test-only fixture supplier): whether its
   * offers can be booked, what a new reservation ends as, and what a
   * cancellation request does.
   */
  supplier?: {
    bookable?: boolean;
    outcome?: 'confirmed' | 'unknown' | 'failed';
    cancel?: 'cancelled' | 'pending' | 'refused';
  };
}) {
  const account = installFakeAccountApi({ signedIn, travellers });
  const accountFetch = globalThis.fetch;
  const response: SearchResponse = searchResponse(results);
  const search = installFakeSearchApi(
    { kind: 'ok', response },
    { supplierBookable: supplier.bookable ?? false },
  );
  search.sessions.set(response.searchId, response);
  const searchFetch = globalThis.fetch;

  const store: Booking[] = [...bookings];
  const posts: BookingPost[] = [];
  const keys = new Map<string, { body: string; reference: string }>();
  const queued: Response[] = [];
  const holds: Promise<void>[] = [];
  const requests: string[] = [];
  const inFlight = new Set<string>();
  const payments = new Map<string, Payment>();
  const paymentPosts: BookingPost[] = [];
  const paymentKeys = new Map<string, { body: string; id: string }>();
  let paymentCounter = 0;
  const at = '2026-10-22T10:00:00.000Z';

  /** Recomputes a booking's payment side from its payments, like the API. */
  const syncBooking = (reference: string) => {
    const index = store.findIndex((b) => b.reference === reference);
    const booking = store[index]!;
    if (booking.payment.mode !== 'demo') return booking;
    const mine = [...payments.values()].filter((p) => p.bookingReference === reference);
    const active = mine.find((p) => p.status === 'created' || p.status === 'pending');
    const paid = mine.find((p) => p.status === 'succeeded');
    const payable = booking.status === 'pending' && !active && !paid;
    const updated: Booking = {
      ...booking,
      payment: {
        ...booking.payment,
        state: paid ? 'paid' : active ? 'processing' : payable ? 'unpaid' : 'closed',
        canPay: payable,
        activePaymentId: active?.id ?? null,
        demoScenarios: payable ? [...DEMO_PAYMENT_SCENARIOS] : null,
      },
    };
    store.splice(index, 1, updated);
    return updated;
  };

  const setPaymentStatus = (id: string, status: Payment['status']) => {
    const current = payments.get(id)!;
    const updated = paymentSchema.parse({
      ...current,
      status,
      cancellable: status === 'pending' || status === 'created',
      completedAt: status === 'pending' || status === 'created' ? null : at,
      failure:
        status === 'failed'
          ? { code: 'demo_declined', message: 'The demo payment was declined (simulated).' }
          : status === 'cancelled'
            ? { code: 'cancelled', message: 'The payment was cancelled before it completed.' }
            : null,
      history: [...current.history, { status, at, by: 'provider', note: null }],
    });
    payments.set(id, updated);
    if (status === 'succeeded') {
      const index = store.findIndex((b) => b.reference === updated.bookingReference);
      const booking = store[index]!;
      if (booking.status === 'pending') {
        store.splice(index, 1, {
          ...booking,
          status: 'confirmed',
          history: [
            ...booking.history,
            {
              status: 'confirmed',
              at,
              by: 'wayora',
              note: 'Demo confirmation after a demo payment.',
            },
          ],
        });
      }
    }
    syncBooking(updated.bookingReference);
    return updated;
  };

  const handlePayments = (method: string, path: string, init?: RequestInit): Response => {
    const start = /^\/bookings\/([^/]+)\/payments$/.exec(path);
    if (start) {
      const reference = decodeURIComponent(start[1]!);
      const booking = store.find((b) => b.reference === reference);
      if (!booking) return fail(404, 'NOT_FOUND', "We couldn't find that booking.");
      if (method === 'GET') {
        return ok(
          paymentListResponseSchema.parse({
            items: [...payments.values()]
              .filter((p) => p.bookingReference === reference)
              .sort((a, b) => b.attempt - a.attempt),
          }),
        );
      }
      const key = new Headers(init?.headers).get('Idempotency-Key');
      const raw = String(init?.body ?? '{}');
      paymentPosts.push({ key, body: JSON.parse(raw) as Record<string, unknown> });
      if (!key) return fail(400, 'BAD_REQUEST', 'Add an Idempotency-Key header.');
      const seen = paymentKeys.get(key);
      if (seen) {
        if (seen.body !== raw) return fail(422, 'IDEMPOTENCY_KEY_REUSED', 'Key reused.');
        return ok(payments.get(seen.id), 201, { 'Idempotent-Replayed': 'true' });
      }
      const parsed = createPaymentRequestSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return fail(400, 'VALIDATION_FAILED', 'The request is invalid.');
      if (!booking.payment.canPay) {
        return fail(409, 'PAYMENT_NOT_ALLOWED', 'This booking can’t be paid now.');
      }
      const amount = booking.payment.amount!;
      if (
        parsed.data.amount.amountMinor !== amount.amountMinor ||
        parsed.data.amount.currency !== amount.currency
      ) {
        return fail(409, 'PAYMENT_AMOUNT_MISMATCH', 'The amount doesn’t match this booking.');
      }
      paymentCounter += 1;
      const id = `01890000-0000-7000-9000-${String(paymentCounter).padStart(12, '0')}`;
      const scenario = parsed.data.demoScenario ?? 'succeed';
      const attempt =
        [...payments.values()].filter((p) => p.bookingReference === reference).length + 1;
      payments.set(
        id,
        paymentSchema.parse({
          id,
          bookingReference: reference,
          attempt,
          status: 'created',
          mode: 'demo',
          demo: true,
          providerName: 'Wayora demo payments (simulated)',
          amount,
          demoScenario: scenario,
          failure: null,
          cancellable: true,
          refund: { required: false, supported: false },
          createdAt: at,
          updatedAt: at,
          completedAt: null,
          history: [{ status: 'created', at, by: 'you', note: null }],
          notice: DEMO_PAYMENT_NOTICE,
        }),
      );
      paymentKeys.set(key, { body: raw, id });
      const result = setPaymentStatus(
        id,
        scenario === 'succeed' ? 'succeeded' : scenario === 'decline' ? 'failed' : 'pending',
      );
      return ok(result, 201);
    }
    const one = /^\/payments\/([^/]+)(\/cancel)?$/.exec(path);
    const payment = one ? payments.get(decodeURIComponent(one[1]!)) : undefined;
    if (!one || !payment) return fail(404, 'NOT_FOUND', "We couldn't find that payment.");
    if (method === 'GET' && !one[2]) return ok(payment);
    if (method === 'POST' && one[2]) {
      if (!payment.cancellable) {
        return fail(409, 'PAYMENT_NOT_CANCELLABLE', 'This payment has already completed.');
      }
      return ok(setPaymentStatus(payment.id, 'cancelled'));
    }
    return fail(404, 'NOT_FOUND', 'Not found.');
  };

  // ─── Trip tracking (Phase 17) ───────────────────────────────────────────
  const trips = new Map<
    string,
    {
      timeline?: TripEvent[];
      status?: TripStatus;
      refreshed?: TripStatus;
      disruptions?: TripDisruption[];
      failing?: RegExp;
    }
  >();
  const tripRequests: string[] = [];
  const tripState = (reference: string) => {
    let t = trips.get(reference);
    if (!t) {
      t = {};
      trips.set(reference, t);
    }
    return t;
  };
  const defaultTimeline = (booking: Booking): TripEvent[] =>
    booking.history.map((h, i) =>
      tripEventSchema.parse({
        id: `01890000-0000-7000-8000-${String(900 + i).padStart(12, '0')}`,
        type: i === 0 ? 'booking_created' : `booking_${h.status}`,
        kind: 'booking',
        source: 'wayora',
        title: i === 0 ? 'Booking requested' : `Booking ${h.status}`,
        description: h.note,
        occurredAt: h.at,
        observedAt: null,
        amount: null,
        paymentId: null,
      }),
    );
  const defaultStatus = (booking: Booking): TripStatus =>
    tripStatusSchema.parse({
      reference: booking.reference,
      freshness: 'unsupported',
      explanation: 'Travel status isn’t available for this kind of booking.',
      source: null,
      providerName: null,
      simulated: false,
      observedAt: null,
      checkedAt: null,
      legs: [],
      refresh: { available: false, nextAllowedAt: null },
    });
  const handleTrips = (method: string, booking: Booking, what: string): Response => {
    const t = tripState(booking.reference);
    if (t.failing?.test(what)) return fail(503, 'SERVICE_UNAVAILABLE', 'Try again later.');
    if (method === 'GET' && what === 'timeline') {
      return ok({
        reference: booking.reference,
        items: t.timeline ?? defaultTimeline(booking),
        nextCursor: null,
      });
    }
    if (method === 'GET' && what === 'status') return ok(t.status ?? defaultStatus(booking));
    if (method === 'GET' && what === 'disruptions') {
      return ok({
        reference: booking.reference,
        items: t.disruptions ?? [],
        notice:
          'Wayora doesn’t change your booking because of a disruption: nothing is cancelled, rebooked, refunded or compensated automatically.',
      });
    }
    if (method === 'POST' && what === 'status/refresh') {
      if (!t.refreshed) {
        return fail(
          409,
          'TRIP_TRACKING_UNAVAILABLE',
          'Travel status isn’t available for this booking.',
        );
      }
      t.status = t.refreshed;
      return ok(t.refreshed);
    }
    return fail(404, 'NOT_FOUND', 'Not found.');
  };

  const handle = async (method: string, url: URL, init?: RequestInit): Promise<Response> => {
    const trip =
      /^\/api\/v1\/bookings\/([^/]+)\/(timeline|status|disruptions|status\/refresh)$/.exec(
        url.pathname,
      );
    if (trip) {
      tripRequests.push(`${method} ${trip[2]}`);
      if (!account.state.signedIn) return fail(401, 'UNAUTHENTICATED', 'Sign in to continue.');
      const booking = store.find((b) => b.reference === decodeURIComponent(trip[1]!));
      if (!booking) return fail(404, 'NOT_FOUND', "We couldn't find that booking.");
      return handleTrips(method, booking, trip[2]!);
    }
    if (/^\/api\/v1\/(payments|bookings\/[^/]+\/payments)/.test(url.pathname)) {
      const full = url.pathname.replace(/^\/api\/v1/, '');
      requests.push(`${method} ${full}${url.search}`);
      if (!account.state.signedIn) return fail(401, 'UNAUTHENTICATED', 'Sign in to continue.');
      const hold = holds.shift();
      if (hold) await hold;
      const next = queued.shift();
      if (next) return next;
      return handlePayments(method, full, init);
    }
    const path = url.pathname.replace(/^\/api\/v1\/bookings/, '');
    requests.push(`${method} /bookings${path}${url.search}`);
    if (!account.state.signedIn) return fail(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    const postKey =
      method === 'POST' && path === '' ? new Headers(init?.headers).get('Idempotency-Key') : null;
    if (method === 'POST' && path === '') {
      posts.push({
        key: postKey,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      // Like the API: a key whose first request is still running is refused.
      if (postKey && inFlight.has(postKey)) {
        return fail(409, 'IDEMPOTENCY_IN_PROGRESS', 'This booking is already being created.');
      }
      if (postKey) inFlight.add(postKey);
    }
    try {
      return await respond(method, path, url, init);
    } finally {
      if (postKey) inFlight.delete(postKey);
    }
  };

  const respond = async (
    method: string,
    path: string,
    url: URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const hold = holds.shift();
    if (hold) await hold;
    const next = queued.shift();
    if (next) return next;

    if (method === 'POST' && path === '') {
      const headers = new Headers(init?.headers);
      const key = headers.get('Idempotency-Key');
      const raw = String(init?.body ?? '{}');
      const body = JSON.parse(raw) as Record<string, unknown>;
      if (!key) return fail(400, 'VALIDATION_FAILED', 'Add an Idempotency-Key header.');
      const seen = keys.get(key);
      if (seen) {
        if (seen.body !== raw) {
          return fail(422, 'IDEMPOTENCY_KEY_REUSED', 'That key was used for another booking.');
        }
        const replay = store.find((b) => b.reference === seen.reference)!;
        return ok(replay, 201, { 'Idempotent-Replayed': 'true' });
      }
      const parsed = createBookingRequestSchema.safeParse(body);
      if (!parsed.success) {
        return fail(
          400,
          'VALIDATION_FAILED',
          'Check the highlighted fields.',
          parsed.error.issues.map((i) => ({
            path: `body.${i.path.join('.')}`,
            message: i.message,
            code: i.code,
          })),
        );
      }
      const session = search.sessions.get(parsed.data.searchId);
      if (!session) return fail(410, 'SEARCH_EXPIRED', 'This search has expired.');
      const offer = session.results.find((r) => r.id === parsed.data.offerId);
      if (!offer) return fail(404, 'OFFER_NOT_IN_SEARCH', "That offer isn't part of this search.");
      if (JSON.stringify(offer.price) !== JSON.stringify(parsed.data.acceptedPrice)) {
        return fail(409, 'PRICE_CHANGED', 'The price has changed. Check the new price.');
      }
      if (offer.source !== 'demo') {
        if (!supplier.bookable) {
          return fail(503, 'SERVICE_UNAVAILABLE', 'Booking this offer isn’t available yet.');
        }
        if (parsed.data.acceptSupplierTerms !== true) {
          return fail(400, 'VALIDATION_FAILED', 'The request is invalid.', [
            {
              path: 'body.acceptSupplierTerms',
              message: 'Confirm that you understand how this supplier booking works.',
              code: 'required',
            },
          ]);
        }
        const booking = supplierBooking(offer, { state: supplier.outcome ?? 'confirmed' });
        store.unshift(booking);
        keys.set(key, { body: raw, reference: booking.reference });
        return ok(booking, 201);
      }
      const booking = demoBooking(offer, {
        travellers: parsed.data.travellers.map(({ firstName, lastName }) => ({
          firstName,
          lastName,
        })),
        contactPhone: parsed.data.contactPhone ?? null,
        ...(paymentMode === 'demo' && offer.price?.kind === 'total'
          ? { status: 'pending' as const, payment: unpaidDemo(offer) }
          : {}),
      });
      store.unshift(booking);
      keys.set(key, { body: raw, reference: booking.reference });
      return ok(booking, 201);
    }

    if (method === 'GET' && path === '') {
      const view = (url.searchParams.get('view') ?? 'upcoming') as BookingView;
      const page = Number(url.searchParams.get('page') ?? '1');
      const pageSize = Number(url.searchParams.get('pageSize') ?? '10');
      const inView = (v: BookingView) =>
        store.filter((b) =>
          v === 'cancelled'
            ? ['cancelled', 'failed', 'expired'].includes(b.status)
            : v === 'past'
              ? !['cancelled', 'failed', 'expired'].includes(b.status) && !b.cancellable
              : !['cancelled', 'failed', 'expired'].includes(b.status) && b.cancellable,
        );
      const all = inView(view);
      return ok(
        bookingListResponseSchema.parse({
          view,
          items: all.slice((page - 1) * pageSize, page * pageSize).map(summary),
          pagination: {
            page,
            pageSize,
            totalResults: all.length,
            totalPages: Math.ceil(all.length / pageSize),
          },
          counts: {
            upcoming: inView('upcoming').length,
            past: inView('past').length,
            cancelled: inView('cancelled').length,
          },
        }),
      );
    }

    const one = /^\/([^/]+)(\/cancel)?$/.exec(path);
    const booking = one ? store.find((b) => b.reference === decodeURIComponent(one[1]!)) : null;
    if (!one || !booking) return fail(404, 'NOT_FOUND', "We couldn't find that booking.");
    if (method === 'GET' && !one[2]) return ok(booking);
    if (method === 'POST' && one[2]) {
      if (!booking.cancellable) {
        return fail(
          409,
          'BOOKING_NOT_CANCELLABLE',
          booking.demo ? 'This booking is already cancelled.' : booking.cancellation.explanation,
        );
      }
      if (!booking.demo) {
        if (supplier.cancel === 'refused') {
          return fail(
            409,
            'BOOKING_NOT_CANCELLABLE',
            `${SUPPLIER} refused to cancel this booking, so it stays confirmed.`,
          );
        }
        const next = supplierBooking(booking.offer, {
          reference: booking.reference,
          createdAt: booking.createdAt,
          state: supplier.cancel === 'pending' ? 'cancellation-pending' : 'cancelled',
        });
        store.splice(store.indexOf(booking), 1, next);
        return ok(next);
      }
      const at = '2026-10-22T10:00:00+00:00';
      const updated: Booking = {
        ...booking,
        status: 'cancelled',
        cancellable: false,
        cancellation: demoCancellation('cancelled', false),
        history: [...booking.history, { status: 'cancelled', at, by: 'you', note: null }],
      };
      store.splice(store.indexOf(booking), 1, updated);
      for (const p of payments.values()) {
        if (p.bookingReference === updated.reference && p.cancellable) {
          setPaymentStatus(p.id, 'cancelled');
        }
      }
      return ok(syncBooking(updated.reference));
    }
    return fail(404, 'NOT_FOUND', 'Not found.');
  };

  // ─── Notifications (Phase 14) ──────────────────────────────────────────
  const notifications: Notification[] = initialNotifications.map((n) =>
    notificationSchema.parse(n),
  );
  let preferences: NotificationPreferences = notificationPreferencesSchema.parse({
    emailBookings: true,
    emailPayments: true,
    emailReminders: true,
    email: {
      active: false,
      status: 'Email isn’t set up on this server yet, so no emails are sent.',
    },
    pushBookings: true,
    pushPayments: true,
    pushReminders: true,
    pushSupport: true,
    pushRewards: true,
    push: { active: false, status: PUSH_NOT_CONFIGURED_STATUS, publicKey: null },
  });
  const notificationFailures: { path: RegExp; times: number }[] = [];
  const preferencePatches: Record<string, unknown>[] = [];
  const unreadCount = () => notifications.filter((n) => !n.read).length;
  const handleNotifications = (method: string, url: URL, init?: RequestInit): Response => {
    const path = url.pathname.replace(/^\/api\/v1/, '');
    requests.push(`${method} ${path}${url.search}`);
    if (!account.state.signedIn) return fail(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    const failure = notificationFailures.find((f) => f.path.test(path) && f.times > 0);
    if (failure) {
      failure.times -= 1;
      return fail(503, 'SERVICE_UNAVAILABLE', 'Down.');
    }
    if (method === 'GET' && path === '/notifications/unread-count')
      return ok({ unread: unreadCount() });
    if (method === 'GET' && path === '/notifications') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
      return ok(
        notificationListResponseSchema.parse({
          items: notifications.slice((page - 1) * pageSize, page * pageSize),
          pagination: {
            page,
            pageSize,
            totalResults: notifications.length,
            totalPages: Math.ceil(notifications.length / pageSize),
          },
          unreadCount: unreadCount(),
        }),
      );
    }
    if (method === 'POST' && path === '/notifications/read-all') {
      const updated = unreadCount();
      notifications.forEach((n, i) => {
        if (!n.read) notifications[i] = { ...n, read: true, readAt: at };
      });
      return ok({ updated, unread: 0 });
    }
    if (path === '/notifications/preferences') {
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        preferencePatches.push(body);
        preferences = notificationPreferencesSchema.parse({ ...preferences, ...body });
      }
      return ok(preferences);
    }
    const read = /^\/notifications\/([^/]+)\/read$/.exec(path);
    if (method === 'PATCH' && read) {
      const index = notifications.findIndex((n) => n.id === read[1]);
      if (index === -1) return fail(404, 'NOT_FOUND', "We couldn't find that notification.");
      const n = notifications[index]!;
      if (!n.read) notifications[index] = { ...n, read: true, readAt: at };
      return ok(notifications[index]);
    }
    return fail(404, 'NOT_FOUND', 'Not found.');
  };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.pathname.startsWith('/api/v1/notifications'))
      return handleNotifications(method, url, init);
    if (
      url.pathname.startsWith('/api/v1/bookings') ||
      url.pathname.startsWith('/api/v1/payments')
    ) {
      return handle(method, url, init);
    }
    if (url.pathname.startsWith('/api/v1/search')) return searchFetch(input, init);
    return accountFetch(input, init);
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    account,
    search,
    response,
    notifications,
    preferencePatches,
    /** Answer the next `times` notification requests matching `path` with a 503. */
    failNotifications(path: RegExp, times = 1) {
      notificationFailures.push({ path, times });
    },
    store,
    posts,
    requests,
    payments,
    paymentPosts,
    /** Trip tracking state per booking reference (timeline, status, disruptions). */
    trip: tripState,
    tripRequests,
    /** The demo provider settles a pending payment. */
    settle(id: string, outcome: 'succeeded' | 'failed') {
      return setPaymentStatus(id, outcome);
    },
    /** Answer the next bookings request with this error instead. */
    failNext(status: number, code: string, message = 'Something went wrong.', details?: unknown[]) {
      queued.push(fail(status, code, message, details));
    },
    /** Hold the next bookings request until the returned function is called. */
    holdNext(): () => void {
      let release!: () => void;
      holds.push(new Promise<void>((r) => (release = r)));
      return () => release();
    },
  };
}
