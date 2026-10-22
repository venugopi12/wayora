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
  type Booking,
  type BookingPayment,
  type Payment,
  type BookingView,
  type SearchResponse,
  type SearchResult,
  type Traveller,
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
    cancellable: status === 'confirmed' || status === 'pending',
    payment,
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
  ...rest
}: Booking) => rest;

export function installFakeBookingApi({
  results,
  travellers = [],
  bookings = [],
  signedIn = true,
  payments: paymentMode = 'none',
}: {
  results: SearchResult[];
  travellers?: Traveller[];
  bookings?: Booking[];
  signedIn?: boolean;
  /** `demo`: new bookings wait for a demo payment (Phase 13). */
  payments?: 'none' | 'demo';
}) {
  const account = installFakeAccountApi({ signedIn, travellers });
  const accountFetch = globalThis.fetch;
  const response: SearchResponse = searchResponse(results);
  const search = installFakeSearchApi({ kind: 'ok', response });
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

  const handle = async (method: string, url: URL, init?: RequestInit): Promise<Response> => {
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
        return fail(409, 'BOOKING_NOT_CANCELLABLE', 'This booking is already cancelled.');
      }
      const at = '2026-10-22T10:00:00+00:00';
      const updated: Booking = {
        ...booking,
        status: 'cancelled',
        cancellable: false,
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

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
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
    store,
    posts,
    requests,
    payments,
    paymentPosts,
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
