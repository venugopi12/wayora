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

export function createFixtureAirProvider(
  source: ConfigSource,
  options: { fetch?: typeof fetch; operations?: SearchProvider['operations'] } = {},
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
      book: 'unsupported',
    },
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
}

// ── The fake supplier server ───────────────────────────────────────────────

export interface SupplierCall {
  method: string;
  url: URL;
  headers: Headers;
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

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    this.calls.push({ method: init?.method ?? 'GET', url, headers });
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
    const price = /^\/api\/v1\/flight-offers\/([^/]+)\/price$/.exec(url.pathname);
    if (price) {
      const current = this.prices.get(decodeURIComponent(price[1]!));
      return current ? json({ total: current }) : json({ error: 'gone' }, 404);
    }
    return json({ error: 'unknown' }, 404);
  };
}
