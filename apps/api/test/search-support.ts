import { pino } from 'pino';
import {
  searchRequestSchema,
  utcDateFromToday,
  type HotelResult,
  type SearchRequest,
  type SearchRequestInput,
  type SearchRequestInputFor,
  type SearchServiceType,
} from '@wayora/contracts';
import {
  ProviderError,
  SEARCH_ONLY,
  type ProviderResult,
  type SearchProvider,
} from '../src/modules/providers/provider.js';
import { ProviderRegistry } from '../src/modules/providers/registry.js';
import { type MemorySearchCache } from '../src/modules/search/cache.js';
import { SearchService } from '../src/modules/search/search.service.js';

/*
 * Test-only providers that simulate supplier behaviour (slow, failing,
 * malformed) deterministically. These live in test/, so no fault switch
 * exists in production code.
 */

export const silentLogger = pino({ level: 'silent' });
export const DATE = utcDateFromToday(20);
export const DATE_PLUS_3 = utcDateFromToday(23);
export const PICKUP_AT = `${utcDateFromToday(5)}T09:30:00+05:30`;

export const VALID_INPUTS: { [S in SearchServiceType]: SearchRequestInputFor<S> } = {
  flights: {
    serviceType: 'flights',
    origin: 'airport:BLR',
    destination: 'airport:DEL',
    departureDate: DATE,
    adults: 1,
  },
  hotels: {
    serviceType: 'hotels',
    destination: 'city:goa',
    checkIn: DATE,
    checkOut: DATE_PLUS_3,
    adults: 2,
  },
  trains: {
    serviceType: 'trains',
    origin: 'station:SBC',
    destination: 'station:MAS',
    departureDate: DATE,
    adults: 1,
  },
  buses: {
    serviceType: 'buses',
    origin: 'city:bengaluru',
    destination: 'city:chennai',
    departureDate: DATE,
    adults: 1,
  },
  metro: { serviceType: 'metro', origin: 'metro:blr-whitefield', destination: 'metro:blr-lalbagh' },
  cabs: {
    serviceType: 'cabs',
    pickup: 'airport:BLR',
    dropoff: 'locality:blr-koramangala',
    pickupAt: PICKUP_AT,
  },
  holidays: {
    serviceType: 'holidays',
    destination: 'destination:kerala',
    departureDate: DATE,
    adults: 2,
  },
};

export function parse(input: SearchRequestInput): SearchRequest {
  return searchRequestSchema.parse(input);
}

export function hotelsRequest(
  overrides: Partial<SearchRequestInput & { serviceType: 'hotels' }> = {},
) {
  return parse({ ...VALID_INPUTS.hotels, ...overrides } as SearchRequestInput);
}

/** A minimal valid hotel result for provider `providerId`. */
export function hotelResult(
  providerId: string,
  ref: string,
  rupees: number,
  extra: Partial<HotelResult> & { dedupeKey?: string } = {},
): ProviderResult<'hotels'> {
  return {
    serviceType: 'hotels',
    id: `${providerId}:${ref}`,
    providerId,
    source: 'demo',
    title: `Hotel ${ref}`,
    price: {
      kind: 'total',
      total: { amountMinor: String(rupees * 100), currency: 'INR' },
      // One night, so the nightly price equals the total.
      perUnit: { amount: { amountMinor: String(rupees * 100), currency: 'INR' }, unit: 'night' },
    },
    offerRef: ref,
    validUntil: '2026-12-01T10:00:00+05:30',
    property: { name: `Hotel ${ref}`, propertyType: 'hotel', area: null, cityName: 'Goa' },
    roomType: 'Double',
    checkIn: DATE,
    checkOut: DATE_PLUS_3,
    nights: 3,
    rooms: 1,
    guests: 2,
    amenities: ['wifi'],
    breakfastIncluded: false,
    ...extra,
  };
}

type Behaviour =
  | { kind: 'results'; results: readonly unknown[]; delayMs?: number }
  | { kind: 'hang' }
  | { kind: 'throw'; error: unknown };

export interface StubProvider extends SearchProvider {
  calls: number;
  /** Highest number of searches this stub had running at once (shared counter). */
}

export function stubProvider(
  id: string,
  behaviour: Behaviour,
  {
    serviceTypes = ['hotels'],
    timeoutMs = 200,
    kind = 'demo',
    onStart,
    onEnd,
  }: {
    serviceTypes?: SearchServiceType[];
    timeoutMs?: number;
    kind?: 'demo' | 'live';
    onStart?: () => void;
    onEnd?: () => void;
  } = {},
): StubProvider {
  const provider: StubProvider = {
    id,
    name: `Stub ${id}`,
    kind,
    version: '1',
    serviceTypes,
    operations: SEARCH_ONLY,
    timeoutMs,
    requiredConfig: [],
    calls: 0,
    async search(_request, { signal }) {
      provider.calls += 1;
      onStart?.();
      try {
        if (behaviour.kind === 'hang') {
          return await new Promise<never>(() => undefined); // never settles, ignores the signal
        }
        if (behaviour.kind === 'throw') throw behaviour.error;
        if (behaviour.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
          signal.throwIfAborted();
        }
        return { results: behaviour.results as ProviderResult[] };
      } finally {
        onEnd?.();
      }
    },
  };
  return provider;
}

export const unavailable = new ProviderError('unavailable', 'Supplier maintenance window.');

export function serviceWith(
  providers: SearchProvider[],
  {
    cache = null as MemorySearchCache | null,
    concurrency,
    now,
  }: { cache?: MemorySearchCache | null; concurrency?: number; now?: () => Date } = {},
) {
  const registry = new ProviderRegistry({ demoEnabled: true });
  for (const p of providers) registry.register(p);
  return new SearchService({
    registry,
    logger: silentLogger,
    ...(cache ? { cache } : {}),
    ...(concurrency ? { concurrency } : {}),
    ...(now ? { now } : {}),
  });
}
