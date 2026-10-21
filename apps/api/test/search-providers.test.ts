import { describe, expect, it } from 'vitest';
import {
  searchResultSchemas,
  type SearchRequestInput,
  type SearchServiceType,
} from '@wayora/contracts';
import { DEMO_PROVIDERS } from '../src/modules/providers/demo/index.js';
import { ProviderError, type SearchProvider } from '../src/modules/providers/provider.js';
import { ProviderRegistry } from '../src/modules/providers/registry.js';
import { DATE, VALID_INPUTS, parse, stubProvider } from './search-support.js';

const NOW = new Date('2026-10-21T08:00:00Z');
const run = async (provider: SearchProvider, input: SearchRequestInput) =>
  (await provider.search(parse(input), { signal: new AbortController().signal, now: NOW })).results;
const demo = (type: SearchServiceType) =>
  DEMO_PROVIDERS.find((p) => p.serviceTypes.includes(type))!;

describe('provider registry', () => {
  it('registers providers and resolves them by category, in order', () => {
    const registry = new ProviderRegistry({ demoEnabled: true });
    const a = stubProvider(
      'a',
      { kind: 'results', results: [] },
      { serviceTypes: ['hotels', 'flights'] },
    );
    const b = stubProvider('b', { kind: 'results', results: [] }, { serviceTypes: ['hotels'] });
    registry.register(a).register(b);
    expect(registry.searchProvidersFor('hotels').map((p) => p.id)).toEqual(['a', 'b']);
    expect(registry.searchProvidersFor('flights').map((p) => p.id)).toEqual(['a']);
    expect(registry.searchProvidersFor('cabs')).toEqual([]);
    expect(() => registry.register(a)).toThrow(/already registered/);
  });

  it('disables demo providers when demo data is off, and providers named in config', () => {
    const registry = new ProviderRegistry({ demoEnabled: false, disabledIds: ['live-off'] });
    registry.register(stubProvider('demo-x', { kind: 'results', results: [] }));
    registry.register(stubProvider('live-on', { kind: 'results', results: [] }, { kind: 'live' }));
    registry.register(stubProvider('live-off', { kind: 'results', results: [] }, { kind: 'live' }));
    expect(registry.searchProvidersFor('hotels').map((p) => p.id)).toEqual(['live-on']);
    expect(registry.describe().map((p) => [p.id, p.enabled, p.disabledReason])).toEqual([
      ['demo-x', false, 'Demo data is switched off.'],
      ['live-on', true, null],
      ['live-off', false, 'Disabled by configuration.'],
    ]);
  });

  it('keeps providers with missing configuration off, without exposing values', () => {
    const live = {
      ...stubProvider('acme', { kind: 'results', results: [] }, { kind: 'live' }),
      requiredConfig: ['ACME_API_KEY'],
    };
    const off = new ProviderRegistry({ demoEnabled: true, isConfigured: () => false }).register(
      live,
    );
    expect(off.searchProvidersFor('hotels')).toEqual([]);
    expect(off.describe()[0]).toMatchObject({ enabled: false, disabledReason: 'Not configured.' });
    expect(JSON.stringify(off.describe())).not.toContain('ACME_API_KEY');
    const on = new ProviderRegistry({
      demoEnabled: true,
      isConfigured: (n) => n === 'ACME_API_KEY',
    }).register(live);
    expect(on.searchProvidersFor('hotels')).toHaveLength(1);
  });

  it('declares one demo provider per category, search-only', () => {
    expect(DEMO_PROVIDERS.map((p) => [p.id, p.serviceTypes, p.kind])).toEqual([
      ['demo-flights', ['flights'], 'demo'],
      ['demo-hotels', ['hotels'], 'demo'],
      ['demo-trains', ['trains'], 'demo'],
      ['demo-buses', ['buses'], 'demo'],
      ['demo-metro', ['metro'], 'demo'],
      ['demo-cabs', ['cabs'], 'demo'],
      ['demo-holidays', ['holidays'], 'demo'],
    ]);
    for (const p of DEMO_PROVIDERS) {
      expect(p.operations).toEqual({
        search: 'supported',
        revalidate: 'unsupported',
        book: 'unsupported',
      });
      expect(p.requiredConfig).toEqual([]);
    }
  });

  it('a single-category adapter refuses other categories', async () => {
    await expect(run(demo('hotels'), VALID_INPUTS.flights)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('demo providers', () => {
  it.each(Object.keys(VALID_INPUTS) as SearchServiceType[])(
    '%s: returns contract-valid, deterministic, clearly demo results',
    async (type) => {
      const first = await run(demo(type), VALID_INPUTS[type]);
      const second = await run(demo(type), VALID_INPUTS[type]);
      expect(first.length).toBeGreaterThan(0);
      expect(second).toEqual(first);
      for (const result of first) {
        const parsed = searchResultSchemas[type].parse(result);
        expect(parsed.source).toBe('demo');
        expect(parsed.providerId).toBe(`demo-${type}`);
        expect(parsed.availability).toBeUndefined(); // demo data never claims availability
        expect(parsed.id).toBe(`${parsed.providerId}:${parsed.offerRef}`);
      }
      expect(new Set(first.map((r) => r.id)).size).toBe(first.length);
    },
  );

  it('flights: follows the requested route, date, cabin and passengers', async () => {
    const results = await run(demo('flights'), {
      ...VALID_INPUTS.flights,
      adults: 2,
      children: 1,
      infants: 1,
    });
    for (const r of results) {
      if (r.serviceType !== 'flights') throw new Error('wrong type');
      const out = r.itineraries[0]!;
      expect(out.segments[0]!.origin.code).toBe('BLR');
      expect(out.segments.at(-1)!.destination.code).toBe('DEL');
      expect(out.departAt.startsWith(DATE)).toBe(true);
      expect(out.segments.every((s) => s.carrier.name.includes('Demo'))).toBe(true);
      // 2 adults + 1 child at 75% + 1 infant at ₹1,500
      const price = r.price;
      if (price?.kind !== 'total' || !price.perUnit)
        throw new Error('expected a total price per adult');
      const perAdult = BigInt(price.perUnit.amount.amountMinor) / 100n;
      const child = (perAdult * 3n + 2n) / 4n;
      expect(price.total.amountMinor).toBe(String((perAdult * 2n + child + 1500n) * 100n));
    }
    expect(results.some((r) => r.serviceType === 'flights' && r.itineraries[0]!.stops === 1)).toBe(
      true,
    );
  });

  it('flights: round trips have an outbound and a return itinerary; first class has no demo fares', async () => {
    const round = await run(demo('flights'), { ...VALID_INPUTS.flights, returnDate: DATE });
    for (const r of round)
      if (r.serviceType === 'flights')
        expect(r.itineraries.map((i) => i.direction)).toEqual(['outbound', 'return']);
    expect(await run(demo('flights'), { ...VALID_INPUTS.flights, cabinClass: 'first' })).toEqual(
      [],
    );
  });

  it('hotels: prices nights × rooms and excludes rooms too small for the party', async () => {
    const results = await run(demo('hotels'), { ...VALID_INPUTS.hotels, rooms: 1, adults: 3 });
    expect(results.map((r) => r.serviceType === 'hotels' && r.property.name)).toEqual([
      'Palm Tide Resort (demo)',
      'Red Roof Homestay (demo)',
    ]);
    const r = results[0]!;
    if (r.serviceType !== 'hotels' || r.price?.kind !== 'total') throw new Error('shape');
    expect(r.nights).toBe(3);
    expect(r.price.total.amountMinor).toBe(String(11_400 * 3 * 100));
  });

  it('returns nothing (not invented results) where the fixtures have no match', async () => {
    expect(
      await run(demo('trains'), {
        ...VALID_INPUTS.trains,
        origin: 'station:JP',
        destination: 'station:MAS',
      }),
    ).toEqual([]);
    expect(
      await run(demo('buses'), {
        ...VALID_INPUTS.buses,
        origin: 'city:chennai',
        destination: 'city:pune',
      }),
    ).toEqual([]);
    expect(await run(demo('cabs'), { ...VALID_INPUTS.cabs, passengers: 7 })).toEqual([]);
    expect(
      await run(demo('holidays'), {
        ...VALID_INPUTS.holidays,
        destination: 'destination:bali',
        adults: 1,
      }),
    ).toHaveLength(2);
  });

  it('metro: plans a one-change journey through the interchange', async () => {
    const [journey] = await run(demo('metro'), { ...VALID_INPUTS.metro, passengers: 2 });
    if (journey?.serviceType !== 'metro') throw new Error('shape');
    expect(journey.transfers).toBe(1);
    expect(journey.legs.map((l) => l.line.name)).toEqual(['Purple Line', 'Green Line']);
    expect(journey.legs[0]!.to.name).toMatch(/Majestic/);
    expect(journey.durationMinutes).toBe((22 + 4) * 2 + 6);
  });

  it('cabs: estimates a price range and respects capacity', async () => {
    const results = await run(demo('cabs'), { ...VALID_INPUTS.cabs, passengers: 5 });
    expect(results.map((r) => r.serviceType === 'cabs' && r.vehicleType)).toEqual(['suv']);
    const [suv] = results;
    if (suv?.serviceType !== 'cabs' || suv.price?.kind !== 'range') throw new Error('shape');
    expect(BigInt(suv.price.max.amountMinor)).toBeGreaterThan(BigInt(suv.price.min.amountMinor));
    expect(suv.distanceKm).toBe(40);
  });

  it('respects the schedule: weekly services only appear on their days', async () => {
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(Date.parse(`${DATE}T00:00:00Z`) + i * 86_400_000);
      return { date: d.toISOString().slice(0, 10), weekday: d.getUTCDay() };
    });
    for (const { date, weekday } of days) {
      const results = await run(demo('flights'), {
        ...VALID_INPUTS.flights,
        destination: 'airport:GOI',
        departureDate: date,
      });
      const has441 = results.some(
        (r) =>
          r.serviceType === 'flights' && r.itineraries[0]!.segments[0]!.flightNumber === 'KDA 441',
      );
      expect(has441, `weekday ${weekday}`).toBe([1, 3, 5].includes(weekday));
    }
  });
});
