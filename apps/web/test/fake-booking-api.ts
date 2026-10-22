import { vi } from 'vitest';
import {
  BOOKING_REFERENCE_ALPHABET,
  bookingListResponseSchema,
  bookingRequirementsFor,
  bookingSchema,
  createBookingRequestSchema,
  offerTravelDates,
  type Booking,
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
 * The API's real behaviour (PostgreSQL, concurrency) is covered by
 * apps/api/test/integration/bookings.test.ts.
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

/** A confirmed demo booking of `offer`, shaped like the API's. */
export function demoBooking(
  offer: SearchResult,
  {
    travellers,
    contactPhone = null,
    createdAt = '2026-10-22T09:00:00+00:00',
    status = 'confirmed',
    reference = nextReference(),
  }: {
    travellers?: { firstName: string; lastName: string }[];
    contactPhone?: string | null;
    createdAt?: string;
    status?: Booking['status'];
    reference?: string;
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
}: {
  results: SearchResult[];
  travellers?: Traveller[];
  bookings?: Booking[];
  signedIn?: boolean;
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

  const handle = async (method: string, url: URL, init?: RequestInit): Promise<Response> => {
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
            ? b.status === 'cancelled' || b.status === 'failed'
            : v === 'past'
              ? b.status !== 'cancelled' && b.status !== 'failed' && !b.cancellable
              : b.status !== 'cancelled' && b.status !== 'failed' && b.cancellable,
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
      return ok(updated);
    }
    return fail(404, 'NOT_FOUND', 'Not found.');
  };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.pathname.startsWith('/api/v1/bookings')) return handle(method, url, init);
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
