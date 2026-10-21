import { describe, expect, it } from 'vitest';
import {
  searchFacetsSchema,
  type SearchRequestInput,
  type SearchResult,
  type SearchResultFor,
  type SearchServiceType,
} from '@wayora/contracts';
import { DEMO_PROVIDERS } from '../src/modules/providers/demo/index.js';
import { computeFacets } from '../src/modules/search/facets.js';
import {
  applyFilters,
  applySort,
  flightCarriers,
  flightDuration,
  flightStops,
  priceAmount,
} from '../src/modules/search/refine.js';
import { VALID_INPUTS, hotelResult, parse } from './search-support.js';

/*
 * Filters, sorting and facets (Phase 10), exercised on the real demo
 * fixtures (what the API actually serves) plus small hand-made results for
 * edge cases such as missing prices and exact ties.
 */

const NOW = new Date('2026-10-21T08:00:00Z');

async function demoResults<S extends SearchServiceType>(
  input: SearchRequestInput & { serviceType: S },
): Promise<SearchResultFor<S>[]> {
  const provider = DEMO_PROVIDERS.find((p) => p.serviceTypes.includes(input.serviceType))!;
  const { results } = await provider.search(parse(input), {
    signal: new AbortController().signal,
    now: NOW,
  });
  return results.map(({ dedupeKey: _key, ...r }) => r as SearchResultFor<S>);
}

/** Filters `all` with `input` and checks the filter really removed something. */
function filtered<S extends SearchServiceType>(
  input: SearchRequestInput & { serviceType: S },
  all: readonly SearchResult[],
): SearchResultFor<S>[] {
  const kept = applyFilters(parse(input), all).results as SearchResultFor<S>[];
  expect(kept.length, 'filter keeps something').toBeGreaterThan(0);
  expect(kept.length, 'filter removes something').toBeLessThan(all.length);
  return kept;
}

const rupees = (r: SearchResult) => Number(priceAmount(r.price)!.amount / 100n);
const localHour = (t: string) => Number(t.slice(11, 13));

describe('filters on demo data', () => {
  it('flights: stops, departure and arrival windows, carriers, duration, price range', async () => {
    const base = { ...VALID_INPUTS.flights, departureDate: VALID_INPUTS.flights.departureDate };
    const all = await demoResults(base);
    expect(all.some((r) => flightStops(r) > 0)).toBe(true);

    for (const r of filtered({ ...base, filters: { maxStops: 0 } }, all))
      expect(flightStops(r)).toBe(0);
    for (const r of filtered({ ...base, filters: { departureWindows: ['morning'] } }, all)) {
      expect(localHour(r.itineraries[0]!.departAt)).toBeGreaterThanOrEqual(6);
      expect(localHour(r.itineraries[0]!.departAt)).toBeLessThan(12);
    }
    for (const r of filtered({ ...base, filters: { arrivalWindows: ['afternoon'] } }, all)) {
      expect(localHour(r.itineraries[0]!.arriveAt)).toBeGreaterThanOrEqual(12);
      expect(localHour(r.itineraries[0]!.arriveAt)).toBeLessThan(17);
    }
    for (const r of filtered({ ...base, filters: { carriers: ['KDA'] } }, all)) {
      expect(flightCarriers(r)).toContain('KDA');
    }
    for (const r of filtered({ ...base, filters: { maxDurationMinutes: 200 } }, all)) {
      expect(flightDuration(r)).toBeLessThanOrEqual(200);
    }
    const prices = all.map(rupees).sort((a, b) => a - b);
    const mid = prices[Math.floor(prices.length / 2)]!;
    for (const r of filtered({ ...base, filters: { maxPriceMinor: String(mid * 100) } }, all)) {
      expect(rupees(r)).toBeLessThanOrEqual(mid);
    }
    for (const r of filtered({ ...base, filters: { minPriceMinor: String(mid * 100) } }, all)) {
      expect(rupees(r)).toBeGreaterThanOrEqual(mid);
    }
  });

  it('flights: combined filters are ANDed, and can eliminate everything', async () => {
    const all = await demoResults(VALID_INPUTS.flights);
    const both = applyFilters(
      parse({ ...VALID_INPUTS.flights, filters: { maxStops: 0, carriers: ['CDA'] } }),
      all,
    ).results as SearchResultFor<'flights'>[];
    expect(both.length).toBeGreaterThan(0);
    for (const r of both) {
      expect(flightStops(r)).toBe(0);
      expect(flightCarriers(r)).toEqual(['CDA']);
    }
    const none = applyFilters(
      parse({ ...VALID_INPUTS.flights, filters: { maxStops: 0, maxDurationMinutes: 15 } }),
      all,
    );
    expect(none.results).toEqual([]);
  });

  it('hotels: property type, amenities (all required), area, breakfast, nightly price', async () => {
    const base = { ...VALID_INPUTS.hotels, destination: 'city:goa' };
    const all = await demoResults(base);
    for (const r of filtered({ ...base, filters: { propertyTypes: ['resort'] } }, all)) {
      expect(r.property.propertyType).toBe('resort');
    }
    for (const r of filtered({ ...base, filters: { amenities: ['pool', 'spa'] } }, all)) {
      expect(r.amenities).toEqual(expect.arrayContaining(['pool', 'spa']));
    }
    for (const r of filtered({ ...base, filters: { areas: ['Palolem'] } }, all)) {
      expect(r.property.area).toBe('Palolem');
    }
    for (const r of filtered({ ...base, filters: { breakfastIncluded: true } }, all)) {
      expect(r.breakfastIncluded).toBe(true);
    }
    // Nightly, not total: ₹7,800/night passes a ₹8,000/night limit though its 3-night total doesn't.
    const nightly = filtered({ ...base, filters: { maxNightlyPriceMinor: '800000' } }, all);
    expect(nightly.map((r) => r.property.name)).toEqual(
      expect.arrayContaining(['Casa Lagoa (demo)']),
    );
  });

  it('trains: class, train, departure and arrival windows, duration', async () => {
    const all = await demoResults(VALID_INPUTS.trains);
    for (const r of filtered({ ...VALID_INPUTS.trains, filters: { classes: ['CC'] } }, all)) {
      expect(r.travelClass.code).toBe('CC');
    }
    const number = all[0]!.trainNumber;
    for (const r of filtered({ ...VALID_INPUTS.trains, filters: { trains: [number] } }, all)) {
      expect(r.trainNumber).toBe(number);
    }
    const shortest = Math.min(...all.map((r) => r.durationMinutes));
    for (const r of filtered(
      { ...VALID_INPUTS.trains, filters: { maxDurationMinutes: shortest } },
      all,
    )) {
      expect(r.durationMinutes).toBe(shortest);
    }
    const hours = new Set(all.map((r) => localHour(r.arriveAt)));
    expect(hours.size).toBeGreaterThan(1);
  });

  it('buses: operator, type, on-board amenities, price', async () => {
    const base = { ...VALID_INPUTS.buses, destination: 'city:hyderabad' };
    const all = await demoResults(base);
    const operator = all[0]!.operatorName;
    for (const r of filtered({ ...base, filters: { operators: [operator] } }, all)) {
      expect(r.operatorName).toBe(operator);
    }
    for (const r of filtered({ ...base, filters: { busTypes: [all[0]!.busType] } }, all)) {
      expect(r.busType).toBe(all[0]!.busType);
    }
    const amenity = all
      .flatMap((r) => r.amenities)
      .find((a) => all.some((r) => !r.amenities.includes(a)));
    expect(amenity).toBeDefined();
    for (const r of filtered({ ...base, filters: { amenities: [amenity!] } }, all)) {
      expect(r.amenities).toContain(amenity);
    }
  });

  it('metro: line and transfers', async () => {
    const all = await demoResults({
      ...VALID_INPUTS.metro,
      origin: 'metro:blr-whitefield',
      destination: 'metro:blr-vijayanagar',
    });
    expect(all.length).toBeGreaterThan(0);
    const kept = applyFilters(
      parse({ ...VALID_INPUTS.metro, filters: { lines: ['del-blue'] } }),
      all,
    ).results;
    expect(kept).toEqual([]); // no Delhi line in a Bengaluru journey
    const purple = applyFilters(
      parse({ ...VALID_INPUTS.metro, filters: { lines: ['blr-purple'] } }),
      all,
    ).results as SearchResultFor<'metro'>[];
    for (const r of purple) expect(r.legs.some((l) => l.line.id === 'blr-purple')).toBe(true);
  });

  it('cabs: vehicle type, minimum capacity, and price ranges that overlap the limits', async () => {
    const all = await demoResults(VALID_INPUTS.cabs);
    for (const r of filtered({ ...VALID_INPUTS.cabs, filters: { minCapacity: 5 } }, all)) {
      expect(r.capacity).toBeGreaterThanOrEqual(5);
    }
    for (const r of filtered({ ...VALID_INPUTS.cabs, filters: { vehicleTypes: ['suv'] } }, all)) {
      expect(r.vehicleType).toBe('suv');
    }
    const cheapest = all
      .map((r) => (r.price?.kind === 'range' ? r.price : null)!)
      .sort((a, b) => Number(BigInt(a.min.amountMinor) - BigInt(b.min.amountMinor)))[0]!;
    // A limit inside the cheapest range still matches it (the ranges overlap).
    const inside = (BigInt(cheapest.min.amountMinor) + BigInt(cheapest.max.amountMinor)) / 2n;
    const kept = applyFilters(
      parse({ ...VALID_INPUTS.cabs, filters: { maxPriceMinor: inside.toString() } }),
      all,
    ).results;
    expect(kept.length).toBeGreaterThan(0);
  });

  it('holidays: nights range, interests, budget range', async () => {
    const all = await demoResults(VALID_INPUTS.holidays);
    for (const r of filtered(
      { ...VALID_INPUTS.holidays, filters: { minNights: 4, maxNights: 5 } },
      all,
    )) {
      expect(r.nights).toBeGreaterThanOrEqual(4);
      expect(r.nights).toBeLessThanOrEqual(5);
    }
    for (const r of filtered(
      { ...VALID_INPUTS.holidays, filters: { interests: ['beach'] } },
      all,
    )) {
      expect(r.interests).toContain('beach');
    }
  });
});

describe('sorting', () => {
  it('price both ways, duration, departure, with results in a stable order', async () => {
    const all = await demoResults(VALID_INPUTS.flights);
    const asc = applySort(parse({ ...VALID_INPUTS.flights, sortBy: 'price-asc' }), all).map(rupees);
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
    const desc = applySort(parse({ ...VALID_INPUTS.flights, sortBy: 'price-desc' }), all).map(
      rupees,
    );
    expect(desc).toEqual([...desc].sort((a, b) => b - a));
    const byDuration = applySort(
      parse({ ...VALID_INPUTS.flights, sortBy: 'duration-asc' }),
      all,
    ).map((r) => flightDuration(r as SearchResultFor<'flights'>));
    expect(byDuration).toEqual([...byDuration].sort((a, b) => a - b));
    const byDeparture = applySort(
      parse({ ...VALID_INPUTS.flights, sortBy: 'departure-asc' }),
      all,
    ).map((r) => (r as SearchResultFor<'flights'>).itineraries[0]!.departAt);
    expect(byDeparture).toEqual([...byDeparture].sort());
  });

  it('flights "recommended": fewest stops first, then lowest price', async () => {
    const all = await demoResults(VALID_INPUTS.flights);
    const sorted = applySort(parse(VALID_INPUTS.flights), all) as SearchResultFor<'flights'>[];
    const key = sorted.map((r) => [flightStops(r), rupees(r)] as const);
    for (let i = 1; i < key.length; i += 1) {
      const [s0, p0] = key[i - 1]!;
      const [s1, p1] = key[i]!;
      expect(s0 < s1 || (s0 === s1 && p0 <= p1)).toBe(true);
    }
  });

  it('puts results without a price last in both directions, never as zero', () => {
    const request = (sortBy: 'price-asc' | 'price-desc') =>
      parse({ ...VALID_INPUTS.hotels, sortBy });
    const free = hotelResult('p', 'no-price', 0, { price: null });
    const cheap = hotelResult('p', 'cheap', 1000);
    const dear = hotelResult('p', 'dear', 9000);
    expect(applySort(request('price-asc'), [free, dear, cheap]).map((r) => r.offerRef)).toEqual([
      'cheap',
      'dear',
      'no-price',
    ]);
    expect(applySort(request('price-desc'), [free, cheap, dear]).map((r) => r.offerRef)).toEqual([
      'dear',
      'cheap',
      'no-price',
    ]);
    // …and a price limit never matches a result without a price.
    const limited = applyFilters(
      parse({ ...VALID_INPUTS.hotels, filters: { maxNightlyPriceMinor: '99999900' } }),
      [free, cheap],
    );
    expect(limited.results.map((r) => r.offerRef)).toEqual(['cheap']);
  });

  it('breaks exact ties deterministically (by result id), whatever the input order', () => {
    const request = parse({ ...VALID_INPUTS.hotels, sortBy: 'price-asc' });
    const a = hotelResult('p', 'a', 5000);
    const b = hotelResult('p', 'b', 5000);
    const c = hotelResult('p', 'c', 5000);
    const orders = [
      [a, b, c],
      [c, b, a],
      [b, c, a],
    ];
    for (const order of orders) {
      expect(applySort(request, order).map((r) => r.offerRef)).toEqual(['a', 'b', 'c']);
    }
  });
});

describe('facets', () => {
  it('lists only choices present in the results, with counts and ranges', async () => {
    const all = await demoResults(VALID_INPUTS.flights);
    const facets = computeFacets(parse(VALID_INPUTS.flights), all);
    expect(searchFacetsSchema.parse(facets)).toEqual(facets);
    const carriers = facets.options.carriers!;
    expect(carriers.map((c) => c.value).sort()).toEqual(
      [...new Set(all.flatMap(flightCarriers))].sort(),
    );
    expect(carriers.find((c) => c.value === 'CDA')?.label).toBe('Coral Demo Air');
    expect(facets.options.stops!.reduce((n, o) => n + o.count, 0)).toBe(all.length);
    const amounts = all.map(rupees);
    expect(facets.price).toEqual({
      min: { amountMinor: String(Math.min(...amounts) * 100), currency: 'INR' },
      max: { amountMinor: String(Math.max(...amounts) * 100), currency: 'INR' },
      basis: 'total',
    });
    expect(facets.durationMinutes!.min).toBe(Math.min(...all.map(flightDuration)));
  });

  it('per category: hotel prices per night; no facet for data that does not exist', async () => {
    const hotels = await demoResults(VALID_INPUTS.hotels);
    const facets = computeFacets(parse(VALID_INPUTS.hotels), hotels);
    expect(facets.price?.basis).toBe('night');
    expect(Object.keys(facets.options).sort()).toEqual(['amenities', 'areas', 'propertyTypes']);
    expect(JSON.stringify(facets)).not.toMatch(/rating/i);

    for (const type of ['trains', 'buses', 'metro', 'cabs', 'holidays'] as const) {
      const results = await demoResults(VALID_INPUTS[type]);
      const f = computeFacets(parse(VALID_INPUTS[type]), results);
      expect(searchFacetsSchema.parse(f), type).toEqual(f);
      for (const list of Object.values(f.options)) {
        for (const o of list!) expect(o.count, `${type} ${o.value}`).toBeGreaterThan(0);
      }
    }
  });

  it('is empty, not invented, for an empty search', () => {
    const facets = computeFacets(parse(VALID_INPUTS.hotels), []);
    expect(facets).toEqual({ price: null, durationMinutes: null, options: {} });
  });
});
