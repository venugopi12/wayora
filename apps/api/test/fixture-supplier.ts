import { z } from 'zod';
import type { FlightResult, SearchRequestFor } from '@wayora/contracts';
import {
  readProviderConfig,
  requiredNames,
  type ConfigSource,
} from '../src/modules/providers/credentials.js';
import { ProviderHttpClient } from '../src/modules/providers/http.js';
import { supplierMoney } from '../src/modules/providers/normalize.js';
import {
  ProviderError,
  type ProviderResult,
  type SearchProvider,
} from '../src/modules/providers/provider.js';
import type {
  ReservationOutcome,
  SupplierReservations,
} from '../src/modules/providers/reservations.js';

/*
 * TEST-ONLY "live" supplier (docs/providers.md#testing): a fictional flight
 * API on the reserved `.test` domain, answered by an in-memory fake server.
 * It is not a real supplier, is never registered by the app, and exists so
 * the live-adapter path (configuration, HTTP, normalization, revalidation,
 * failures, health, booking refusal) is exercised end to end without any
 * credentials. Real adapters follow the same shape (providers/live/index.ts).
 */

export const FIXTURE_SPEC = {
  plain: ['FIXTURE_AIR_BASE_URL'] as const,
  secret: ['FIXTURE_AIR_API_KEY'] as const,
};
export const FIXTURE_CONFIG = {
  FIXTURE_AIR_BASE_URL: 'https://fixture-air.test/api',
  FIXTURE_AIR_API_KEY: 'fixture-secret-key-0001',
};

// ── What the fictional supplier sends (validated before any mapping) ──────

const supplierPoint = z.object({ code: z.string(), name: z.string(), city: z.string() });
const supplierOffer = z.object({
  ref: z.string().min(1).max(100),
  carrier: z.object({ code: z.string().min(1), name: z.string().min(1) }),
  flightNumber: z.string().min(1),
  from: supplierPoint,
  to: supplierPoint,
  departAt: z.string(),
  arriveAt: z.string(),
  durationMinutes: z.number().int().positive(),
  total: z.object({ amount: z.unknown(), currency: z.unknown() }),
  fare: z
    .object({
      name: z.string().nullable().optional(),
      refundable: z.boolean().nullable().optional(),
      changeable: z.boolean().nullable().optional(),
      checkedBagKg: z.number().int().nullable().optional(),
      cabinBagKg: z.number().int().nullable().optional(),
    })
    .optional(),
  expiresAt: z.string(),
});
const searchAnswer = z.object({ offers: z.array(z.unknown()) });
const priceAnswer = z.object({ total: z.object({ amount: z.unknown(), currency: z.unknown() }) });
/** The fictional supplier's reservation record (Phase 23). */
const reservationAnswer = z.object({
  status: z.enum(['confirmed', 'pending', 'cancelled', 'failed']),
  reservationRef: z.string().nullable(),
  total: z.object({ amount: z.unknown(), currency: z.unknown() }).nullable().optional(),
  tickets: z
    .array(z.object({ number: z.string(), passenger: z.number().int().nullable() }))
    .optional(),
  cancellationRef: z.string().nullable().optional(),
});

/** "4520.50" from 452050 minor units (2-digit currencies only: the fixture uses INR). */
const decimal = (amountMinor: string) =>
  `${amountMinor.slice(0, -2) || '0'}.${amountMinor.slice(-2).padStart(2, '0')}`;

function mapReservation(answer: z.infer<typeof reservationAnswer>): ReservationOutcome {
  switch (answer.status) {
    case 'confirmed': {
      if (!answer.reservationRef) {
        // "Confirmed" without a reference is unusable: never invent one.
        throw new ProviderError('error', 'fixture-air: confirmation without a reference');
      }
      const total = answer.total ? supplierMoney(answer.total.amount, answer.total.currency) : null;
      return {
        status: 'confirmed',
        supplierReference: answer.reservationRef,
        price: total,
        documents: (answer.tickets ?? []).map((t) => ({
          type: 'ticket' as const,
          reference: t.number,
          travellerIndex: t.passenger,
        })),
      };
    }
    case 'pending':
      return { status: 'pending', supplierReference: answer.reservationRef };
    case 'cancelled':
      return { status: 'cancelled', cancellationReference: answer.cancellationRef ?? null };
    case 'failed':
      return { status: 'rejected', reason: 'other' };
  }
}

export interface FixtureReservationOptions {
  /** The supplier has a status lookup. */
  lookup?: boolean;
  /** The supplier can cancel. */
  cancel?: boolean;
  /** The supplier documents de-duplicating reservations by Wayora's key. */
  idempotent?: boolean;
}

export function createFixtureAirProvider(
  source: ConfigSource,
  options: {
    fetch?: typeof fetch;
    operations?: SearchProvider['operations'];
    /** Phase 23: give the adapter the fictional supplier's reservation API. */
    reservations?: FixtureReservationOptions;
  } = {},
): SearchProvider {
  const http = new ProviderHttpClient({
    providerId: 'fixture-air',
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const config = () => {
    const c = readProviderConfig(FIXTURE_SPEC, source);
    // The registry keeps an unconfigured provider disabled; this is a second line.
    if (!c) throw new ProviderError('error', 'fixture-air: not configured', { transient: false });
    return c;
  };
  const auth = () => ({ authorization: `Bearer ${config().FIXTURE_AIR_API_KEY.reveal()}` });

  return {
    id: 'fixture-air',
    name: 'Fixture Air (test supplier)',
    kind: 'live',
    version: '1',
    serviceTypes: ['flights'],
    operations: options.operations ?? {
      search: 'supported',
      revalidate: 'supported',
      book: options.reservations ? 'supported' : 'unsupported',
    },
    ...(options.reservations ? { reservations: reservationsFor(options.reservations) } : {}),
    timeoutMs: 2000,
    requiredConfig: requiredNames(FIXTURE_SPEC),

    async search(request, { signal }) {
      if (request.serviceType !== 'flights') {
        throw new ProviderError('error', 'fixture-air only handles flights');
      }
      const r = request as SearchRequestFor<'flights'>;
      const { body } = await http.requestJson({
        url: `${config().FIXTURE_AIR_BASE_URL}/v1/flight-offers`,
        query: {
          from: r.origin.split(':')[1],
          to: r.destination.split(':')[1],
          date: r.departureDate,
          adults: r.adults,
          children: r.children,
          infants: r.infants,
          cabin: r.cabinClass,
        },
        headers: auth(),
        signal,
      });
      const answer = searchAnswer.safeParse(body);
      if (!answer.success)
        throw new ProviderError('error', 'fixture-air: unexpected search answer');
      const results: ProviderResult<'flights'>[] = [];
      for (const raw of answer.data.offers) {
        const offer = supplierOffer.safeParse(raw);
        if (!offer.success) continue; // dropped, never guessed
        const o = offer.data;
        const total = supplierMoney(o.total.amount, o.total.currency);
        if (!total) continue;
        const fromPoint = {
          placeId: r.origin,
          code: o.from.code,
          name: o.from.name,
          cityName: o.from.city,
        };
        const toPoint = {
          placeId: r.destination,
          code: o.to.code,
          name: o.to.name,
          cityName: o.to.city,
        };
        const leg = {
          departAt: o.departAt,
          arriveAt: o.arriveAt,
          durationMinutes: o.durationMinutes,
        };
        const result: FlightResult & { dedupeKey?: string } = {
          serviceType: 'flights',
          id: `fixture-air:${o.ref}`,
          providerId: 'fixture-air',
          source: 'live',
          title: `${o.carrier.name} ${o.flightNumber}`,
          price: { kind: 'total', total, perUnit: null },
          offerRef: o.ref,
          validUntil: o.expiresAt,
          cabinClass: r.cabinClass,
          passengers: { adults: r.adults, children: r.children, infants: r.infants },
          itineraries: [
            {
              direction: 'outbound',
              stops: 0,
              ...leg,
              segments: [
                {
                  carrier: o.carrier,
                  flightNumber: o.flightNumber,
                  origin: fromPoint,
                  destination: toPoint,
                  ...leg,
                },
              ],
            },
          ],
          ...(o.fare
            ? {
                fare: {
                  name: o.fare.name ?? null,
                  refundable: o.fare.refundable ?? null,
                  changeable: o.fare.changeable ?? null,
                  checkedBaggage: o.fare.checkedBagKg
                    ? { pieces: null, weightKg: o.fare.checkedBagKg }
                    : null,
                  cabinBaggage: o.fare.cabinBagKg
                    ? { pieces: null, weightKg: o.fare.cabinBagKg }
                    : null,
                },
              }
            : {}),
        };
        results.push(result);
      }
      return { results };
    },

    async revalidate(offer, { signal }) {
      const { status, body } = await http.requestJson({
        url: `${config().FIXTURE_AIR_BASE_URL}/v1/flight-offers/${encodeURIComponent(offer.offerRef)}/price`,
        headers: auth(),
        signal,
        acceptStatuses: [404, 410],
      });
      if (status === 404 || status === 410) return { status: 'unavailable' };
      const answer = priceAnswer.safeParse(body);
      if (!answer.success) throw new ProviderError('error', 'fixture-air: unexpected price answer');
      const total = supplierMoney(answer.data.total.amount, answer.data.total.currency);
      if (!total) throw new ProviderError('error', 'fixture-air: unusable price');
      return { status: 'available', price: { kind: 'total', total, perUnit: null } };
    },
  };

  function reservationsFor(features: FixtureReservationOptions): SupplierReservations {
    return {
      settlement: 'supplier',
      idempotentReserve: features.idempotent ?? false,
      async reserve(request, { signal }) {
        if (request.expectedPrice.kind !== 'total') throw new Error('fixture: totals only');
        const { status, body } = await http.requestJson({
          method: 'POST',
          url: `${config().FIXTURE_AIR_BASE_URL}/v1/reservations`,
          headers: auth(),
          body: {
            offerRef: request.offer.offerRef,
            idempotencyKey: request.idempotencyKey,
            bookingReference: request.bookingReference,
            expectedTotal: {
              amount: decimal(request.expectedPrice.total.amountMinor),
              currency: request.expectedPrice.total.currency,
            },
            passengers: request.travellers,
            contactPhone: request.contactPhone,
          },
          signal,
          // Documented refusals: nothing was reserved.
          acceptStatuses: [400, 409, 422],
        });
        if (status === 400) return { status: 'rejected', reason: 'invalid-details' };
        if (status === 409) return { status: 'rejected', reason: 'offer-unavailable' };
        if (status === 422) return { status: 'rejected', reason: 'price-changed' };
        const answer = reservationAnswer.safeParse(body);
        if (!answer.success)
          throw new ProviderError('error', 'fixture-air: unexpected reservation answer');
        return mapReservation(answer.data);
      },
      ...(features.lookup
        ? {
            async lookup(request, { signal }) {
              const { status, body } = await http.requestJson({
                url: `${config().FIXTURE_AIR_BASE_URL}/v1/reservations`,
                query: { key: request.idempotencyKey },
                headers: auth(),
                signal,
                acceptStatuses: [404],
              });
              if (status === 404) return { status: 'not-found' };
              const answer = reservationAnswer.safeParse(body);
              if (!answer.success)
                throw new ProviderError('error', 'fixture-air: unexpected lookup answer');
              return mapReservation(answer.data);
            },
          }
        : {}),
      ...(features.cancel
        ? {
            async cancel(request, { signal }) {
              const { status, body } = await http.requestJson({
                method: 'POST',
                url: `${config().FIXTURE_AIR_BASE_URL}/v1/reservations/${encodeURIComponent(request.supplierReference)}/cancel`,
                headers: auth(),
                body: { key: request.cancellationKey },
                signal,
                acceptStatuses: [409],
              });
              if (status === 409) return { status: 'rejected', reason: 'not-cancellable' };
              if (status === 202) return { status: 'pending' };
              const answer = reservationAnswer.safeParse(body);
              if (!answer.success || answer.data.status !== 'cancelled') {
                throw new ProviderError('error', 'fixture-air: unexpected cancellation answer');
              }
              return {
                status: 'cancelled',
                cancellationReference: answer.data.cancellationRef ?? null,
              };
            },
          }
        : {}),
    };
  }
}

// ── The fake supplier server ───────────────────────────────────────────────

export interface SupplierCall {
  method: string;
  url: URL;
  headers: Headers;
  /** Parsed JSON request body (POSTs). */
  body: unknown;
}

/** How the fictional supplier answers a reservation request (Phase 23). */
export type ReserveBehaviour =
  | { kind: 'confirm'; tickets?: boolean; total?: { amount: string; currency: string } }
  | { kind: 'pending' }
  /** A documented refusal: nothing recorded. */
  | { kind: 'reject'; status: 400 | 409 | 422 }
  /** Fails before processing: nothing recorded. */
  | { kind: 'status'; status: number }
  /** Records a confirmed reservation, then never answers (Wayora times out). */
  | { kind: 'store-then-hang' }
  /** Records a confirmed reservation, then answers with an error. */
  | { kind: 'store-then-status'; status: number }
  /** Records a confirmed reservation, then answers with something unreadable. */
  | { kind: 'store-then-garble' };

export type CancelBehaviour =
  | { kind: 'cancel' }
  | { kind: 'refuse' }
  | { kind: 'pending' }
  /** Cancels it, then never answers. */
  | { kind: 'cancel-then-hang' };

export interface StoredReservation {
  key: string;
  ref: string;
  status: 'confirmed' | 'pending' | 'cancelled';
  offerRef: string;
  passengers: unknown;
  cancellationRef: string | null;
}

export type SupplierBehaviour =
  | { kind: 'ok' }
  | { kind: 'status'; status: number; times?: number }
  | { kind: 'hang' }
  | { kind: 'html' }
  | { kind: 'not-a-list' };

export function fixtureOffer(overrides: Record<string, unknown> = {}) {
  return {
    ref: 'FA-1001',
    carrier: { code: 'FA', name: 'Fixture Air' },
    flightNumber: 'FA 101',
    from: { code: 'BLR', name: 'Kempegowda International', city: 'Bengaluru' },
    to: { code: 'DEL', name: 'Indira Gandhi International', city: 'Delhi' },
    departAt: '2026-12-14T06:00:00+05:30',
    arriveAt: '2026-12-14T08:50:00+05:30',
    durationMinutes: 170,
    total: { amount: '4520.50', currency: 'INR' },
    fare: { name: 'Saver', refundable: false, changeable: true, checkedBagKg: 15, cabinBagKg: 7 },
    expiresAt: '2030-01-01T00:00:00Z',
    ...overrides,
  };
}

export class FixtureSupplierServer {
  calls: SupplierCall[] = [];
  offers: unknown[] = [fixtureOffer()];
  searchBehaviour: SupplierBehaviour = { kind: 'ok' };
  /** Current price per ref (string amount, currency); missing ref = gone (404). */
  prices = new Map<string, { amount: unknown; currency: unknown }>([
    ['FA-1001', { amount: '4520.50', currency: 'INR' }],
  ]);
  // Reservations (Phase 23).
  reserveBehaviour: ReserveBehaviour = { kind: 'confirm', tickets: true };
  cancelBehaviour: CancelBehaviour = { kind: 'cancel' };
  /** Lookups answer this status instead (e.g. 503), when set. */
  lookupStatus: number | null = null;
  /** The supplier de-duplicates reservation requests by key (as documented). */
  dedupe = false;
  reservations: StoredReservation[] = [];
  private nextRef = 1;

  /** Calls to one endpoint ("POST /api/v1/reservations", …). */
  callsTo(method: string, pathPrefix: string): SupplierCall[] {
    return this.calls.filter((c) => c.method === method && c.url.pathname.startsWith(pathPrefix));
  }

  /** The supplier confirms a reservation it had pending. */
  confirmPending(): void {
    for (const r of this.reservations) if (r.status === 'pending') r.status = 'confirmed';
  }

  private hang(init: RequestInit | undefined): Promise<Response> {
    return new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }),
    );
  }

  private store(
    body: { idempotencyKey: string; offerRef: string; passengers: unknown },
    status: StoredReservation['status'],
  ) {
    const existing = this.dedupe
      ? this.reservations.find((r) => r.key === body.idempotencyKey)
      : undefined;
    if (existing) return existing;
    const stored: StoredReservation = {
      key: body.idempotencyKey,
      ref: `FXR${String(this.nextRef++).padStart(5, '0')}`,
      status,
      offerRef: body.offerRef,
      passengers: body.passengers,
      cancellationRef: null,
    };
    this.reservations.push(stored);
    return stored;
  }

  private answer(r: StoredReservation, tickets = true) {
    return {
      status: r.status,
      reservationRef: r.ref,
      total: { amount: '4520.50', currency: 'INR' },
      tickets:
        tickets && r.status === 'confirmed'
          ? [{ number: `098${r.ref.slice(3)}0001`, passenger: 0 }]
          : [],
      cancellationRef: r.cancellationRef,
    };
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    this.calls.push({ method: init?.method ?? 'GET', url, headers, body });
    if (headers.get('authorization') !== `Bearer ${FIXTURE_CONFIG.FIXTURE_AIR_API_KEY}`) {
      return new Response('{"error":"bad key"}', { status: 401 });
    }
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.pathname === '/api/v1/flight-offers') {
      const b = this.searchBehaviour;
      if (b.kind === 'hang') {
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), {
            once: true,
          }),
        );
      }
      if (b.kind === 'status') {
        if (b.times === undefined || b.times > 0) {
          if (b.times !== undefined) b.times -= 1;
          return new Response(`{"error":"supplier detail ${FIXTURE_CONFIG.FIXTURE_AIR_API_KEY}"}`, {
            status: b.status,
          });
        }
      }
      if (b.kind === 'html')
        return new Response('<html>maintenance</html>', {
          headers: { 'content-type': 'text/html' },
        });
      if (b.kind === 'not-a-list') return json({ offers: 'none' });
      return json({ offers: this.offers });
    }
    if (url.pathname === '/api/v1/reservations' && init?.method === 'POST') {
      const b = this.reserveBehaviour;
      const request = body as { idempotencyKey: string; offerRef: string; passengers: unknown };
      if (b.kind === 'reject') return json({ code: 'refused' }, b.status);
      if (b.kind === 'status') return new Response('{"error":"down"}', { status: b.status });
      if (b.kind === 'pending') return json(this.answer(this.store(request, 'pending')), 202);
      if (b.kind === 'confirm') {
        const stored = this.store(request, 'confirmed');
        return json(
          { ...this.answer(stored, b.tickets ?? true), ...(b.total ? { total: b.total } : {}) },
          201,
        );
      }
      this.store(request, 'confirmed');
      if (b.kind === 'store-then-hang') return this.hang(init);
      if (b.kind === 'store-then-status')
        return new Response('{"error":"oops"}', { status: b.status });
      return json({ status: 'maybe?', ref: 42 });
    }
    if (url.pathname === '/api/v1/reservations' && (init?.method ?? 'GET') === 'GET') {
      if (this.lookupStatus) return new Response('{"error":"down"}', { status: this.lookupStatus });
      const key = url.searchParams.get('key');
      const found = [...this.reservations].reverse().find((r) => r.key === key);
      return found ? json(this.answer(found)) : json({ error: 'not found' }, 404);
    }
    const cancel = /^\/api\/v1\/reservations\/([^/]+)\/cancel$/.exec(url.pathname);
    if (cancel && init?.method === 'POST') {
      const found = this.reservations.find((r) => r.ref === decodeURIComponent(cancel[1]!));
      if (!found) return json({ error: 'not found' }, 404);
      const b = this.cancelBehaviour;
      if (b.kind === 'refuse') return json({ code: 'not-cancellable' }, 409);
      if (b.kind === 'pending') return json(this.answer(found), 202);
      found.status = 'cancelled';
      found.cancellationRef ??= `FXC${found.ref.slice(3)}`;
      if (b.kind === 'cancel-then-hang') return this.hang(init);
      return json(this.answer(found));
    }
    const price = /^\/api\/v1\/flight-offers\/([^/]+)\/price$/.exec(url.pathname);
    if (price) {
      const current = this.prices.get(decodeURIComponent(price[1]!));
      return current ? json({ total: current }) : json({ error: 'gone' }, 404);
    }
    return json({ error: 'unknown' }, 404);
  };
}
