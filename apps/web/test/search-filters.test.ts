import { describe, expect, it } from 'vitest';
import type { SearchFacets } from '@wayora/contracts';
import {
  activeFilterChips,
  clearAllFilters,
  formatHours,
  readFilters,
  readPage,
  readSort,
} from '../src/features/search/filters';
import { readSearchParams, searchParamsFor, withParams } from '../src/features/search/params';
import { summarizeSearch } from '../src/features/search/summary';
import { DATE } from './search-fixtures';

const q = (query: string) => new URLSearchParams(query);

describe('reading filters from the URL', () => {
  it('maps every flight filter to its request field', () => {
    expect(
      readFilters(
        'flights',
        q(
          'stops=1&depart-times=morning,evening&arrive-times=night&airlines=CDA,KDA&maxDuration=240&minPrice=3000&maxPrice=9000',
        ),
      ),
    ).toEqual({
      filters: {
        maxStops: 1,
        departureWindows: ['morning', 'evening'],
        arrivalWindows: ['night'],
        carriers: ['CDA', 'KDA'],
        maxDurationMinutes: 240,
        minPriceMinor: '300000',
        maxPriceMinor: '900000',
      },
      dropped: [],
    });
  });

  it('per category: hotel prices are per night, toggles and ranges', () => {
    expect(
      readFilters('hotels', q('minPrice=2000&maxPrice=8000&breakfast=1&areas=Palolem')).filters,
    ).toEqual({
      minNightlyPriceMinor: '200000',
      maxNightlyPriceMinor: '800000',
      breakfastIncluded: true,
      areas: ['Palolem'],
    });
    expect(readFilters('holidays', q('minNights=3&maxNights=5&interests=beach')).filters).toEqual({
      minNights: 3,
      maxNights: 5,
      interests: ['beach'],
    });
    expect(readFilters('cabs', q('seats=5&vehicles=suv')).filters).toEqual({
      minCapacity: 5,
      vehicleTypes: ['suv'],
    });
    expect(readFilters('metro', q('changes=0&lines=blr-purple')).filters).toEqual({
      maxTransfers: 0,
      lines: ['blr-purple'],
    });
  });

  it('drops invalid values instead of failing the search', () => {
    const read = readFilters(
      'flights',
      q('stops=lots&depart-times=midnight&maxPrice=-1&minPrice=0&maxDuration=5&airlines=CDA,,CDA'),
    );
    expect(read.filters).toEqual({ carriers: ['CDA'] });
    expect(read.dropped.sort()).toEqual([
      'depart-times',
      'maxDuration',
      'maxPrice',
      'minPrice',
      'stops',
    ]);
    expect(readFilters('hotels', q('breakfast=yes')).dropped).toEqual(['breakfast']);
    expect(readFilters('hotels', q('amenities=sauna')).dropped).toEqual(['amenities']);
  });

  it('drops an inverted range entirely', () => {
    const read = readFilters('buses', q('minPrice=900&maxPrice=100'));
    expect(read.filters).toEqual({});
    expect(read.dropped).toEqual(['minPrice', 'maxPrice']);
  });

  it('ignores parameters that belong to other categories', () => {
    expect(readFilters('trains', q('airlines=CDA&breakfast=1')).filters).toEqual({});
  });

  it('reads sort and page safely', () => {
    expect(readSort('hotels', q(''))).toEqual({ sort: 'price-asc', dropped: false });
    expect(readSort('hotels', q('sort=price-desc'))).toEqual({
      sort: 'price-desc',
      dropped: false,
    });
    expect(readSort('hotels', q('sort=rating-desc'))).toEqual({ sort: 'price-asc', dropped: true });
    expect(readSort('flights', q('sort=departure-asc')).sort).toBe('departure-asc');
    expect(readPage(q('page=3'))).toEqual({ page: 3, dropped: false });
    for (const bad of ['0', '-1', '101', 'two', '1.5']) {
      expect(readPage(q(`page=${bad}`))).toEqual({ page: 1, dropped: true });
    }
  });
});

describe('active filter chips', () => {
  const facets: SearchFacets = {
    price: null,
    durationMinutes: null,
    options: { carriers: [{ value: 'CDA', label: 'Coral Demo Air', count: 2 }] },
  };

  it('labels each value from the facets and removes only that value', () => {
    const chips = activeFilterChips('flights', q('airlines=CDA,KDA&stops=0&maxPrice=6000'), {
      currency: 'INR',
      facets,
    });
    expect(chips.map((c) => c.label)).toEqual([
      'Nonstop only',
      'Price: up to ₹6,000',
      'Airline: Coral Demo Air',
      'Airline: KDA',
    ]);
    expect(chips.find((c) => c.label === 'Airline: Coral Demo Air')!.remove).toEqual({
      airlines: 'KDA',
    });
    expect(chips.find((c) => c.label === 'Airline: KDA')!.remove).toEqual({ airlines: 'CDA' });
  });

  it('shows nothing for invalid values, and clear-all covers every filter parameter', () => {
    expect(activeFilterChips('flights', q('stops=lots'), { currency: 'INR' })).toEqual([]);
    expect(Object.keys(clearAllFilters('hotels')).sort()).toEqual([
      'amenities',
      'areas',
      'breakfast',
      'free-cancel',
      'maxPrice',
      'minPrice',
      'types',
    ]);
  });

  it('formats durations', () => {
    expect(formatHours(45)).toBe('45 min');
    expect(formatHours(180)).toBe('3 h');
    expect(formatHours(150)).toBe('2 h 30 min');
  });
});

describe('search URL state', () => {
  const search = `from=airport:BLR&to=airport:DEL&depart=${DATE}`;

  it('reads a valid search with its refinements', () => {
    const state = readSearchParams('flights', q(`${search}&sort=price-asc&page=2&airlines=CDA`));
    expect(state.status).toBe('ready');
    if (state.status !== 'ready') return;
    expect(state.request).toMatchObject({
      serviceType: 'flights',
      origin: 'airport:BLR',
      sortBy: 'price-asc',
      page: 2,
      filters: { carriers: ['CDA'] },
    });
    expect(state.dropped).toEqual([]);
  });

  it('a new search keeps filters, sort and unrelated parameters but restarts at page 1', () => {
    const current = q(`${search}&airlines=CDA&sort=price-asc&page=3&utm_source=newsletter`);
    const next = searchParamsFor(
      'flights',
      { from: 'airport:BLR', to: 'airport:GOI', depart: DATE, adults: '1' },
      current,
      'INR',
    );
    expect(Object.fromEntries(next)).toEqual({
      from: 'airport:BLR',
      to: 'airport:GOI',
      depart: DATE,
      adults: '1',
      airlines: 'CDA',
      sort: 'price-asc',
      utm_source: 'newsletter',
    });
  });

  it('refinements reset the page unless they set it', () => {
    expect(withParams(q('page=3&stops=0'), { stops: '1' }).toString()).toBe('stops=1');
    expect(withParams(q('page=3'), { page: '4' }).toString()).toBe('page=4');
  });

  it('summarizes searches for the summary bar', () => {
    expect(
      summarizeSearch('flights', {
        from: 'airport:BLR',
        to: 'airport:GOI',
        depart: '2026-11-10',
        adults: '2',
        children: '1',
        infants: '0',
        cabin: 'premium-economy',
      }),
    ).toEqual({
      title: 'Bengaluru (BLR) to Goa (GOI)',
      details: ['Tue, 10 Nov, one way', '2 adults, 1 child', 'Premium economy'],
    });
    expect(
      summarizeSearch('hotels', {
        to: 'city:goa',
        checkin: '2026-11-10',
        checkout: '2026-11-13',
        rooms: '1',
        adults: '2',
        children: '0',
      }),
    ).toEqual({
      title: 'Stays in Goa',
      details: ['Tue, 10 Nov – Fri, 13 Nov, 3 nights', '1 room', '2 adults'],
    });
  });
});
