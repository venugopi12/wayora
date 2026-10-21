import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SORT,
  SEARCH_PLACES,
  SORT_OPTIONS,
  offerResponseSchema,
  daysBetween,
  findPlace,
  partySize,
  placeSchema,
  searchRequestSchema,
  searchRequestSchemas,
  searchResponseSchema,
  searchResultSchema,
  utcDateFromToday,
  type SearchRequestInput,
} from '../src/index.js';

const in10 = utcDateFromToday(10);
const in13 = utcDateFromToday(13);
const pickupIn2Days = new Date(Date.now() + 2 * 86_400_000).toISOString().replace('Z', '+00:00');

const valid: Record<SearchRequestInput['serviceType'], SearchRequestInput> = {
  flights: {
    serviceType: 'flights',
    origin: 'airport:BLR',
    destination: 'airport:GOI',
    departureDate: in10,
    adults: 1,
  },
  hotels: {
    serviceType: 'hotels',
    destination: 'city:goa',
    checkIn: in10,
    checkOut: in13,
    adults: 2,
  },
  trains: {
    serviceType: 'trains',
    origin: 'station:SBC',
    destination: 'station:MAS',
    departureDate: in10,
    adults: 1,
  },
  buses: {
    serviceType: 'buses',
    origin: 'city:bengaluru',
    destination: 'city:hyderabad',
    departureDate: in10,
    adults: 2,
  },
  metro: { serviceType: 'metro', origin: 'metro:blr-whitefield', destination: 'metro:blr-lalbagh' },
  cabs: {
    serviceType: 'cabs',
    pickup: 'airport:BLR',
    dropoff: 'locality:blr-koramangala',
    pickupAt: pickupIn2Days,
  },
  holidays: {
    serviceType: 'holidays',
    destination: 'destination:kerala',
    departureDate: in10,
    adults: 2,
  },
};

const issuesOf = (input: unknown) => {
  const result = searchRequestSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('search requests', () => {
  it.each(Object.entries(valid))(
    'accepts a valid %s request and applies defaults',
    (type, input) => {
      const parsed = searchRequestSchema.parse(input);
      expect(parsed).toMatchObject({
        currency: 'INR',
        page: 1,
        pageSize: 10,
        sortBy: DEFAULT_SORT[type as keyof typeof DEFAULT_SORT],
        filters: {},
      });
    },
  );

  it('rejects an unsupported service type', () => {
    expect(issuesOf({ ...valid.flights, serviceType: 'ferries' })).toEqual(
      [': Unsupported service type.'].map((s) => expect.stringContaining(s.slice(2))),
    );
  });

  it('rejects unknown fields (strict)', () => {
    expect(issuesOf({ ...valid.flights, providerUrl: 'http://evil.example' })[0]).toMatch(
      /unrecognized/i,
    );
    expect(issuesOf({ ...valid.hotels, filters: { stars: 5 } })[0]).toMatch(/filters/);
  });

  it.each([
    ['flights', 'origin'],
    ['flights', 'departureDate'],
    ['hotels', 'checkIn'],
    ['trains', 'adults'],
    ['cabs', 'pickupAt'],
    ['holidays', 'destination'],
  ] as const)('%s requires %s', (type, field) => {
    const { [field]: _omit, ...rest } = valid[type] as Record<string, unknown>;
    expect(issuesOf(rest).some((i) => i.startsWith(field))).toBe(true);
  });

  it('checks route rules: known places, right kind, different ends, same city where needed', () => {
    expect(issuesOf({ ...valid.flights, destination: 'airport:XXX' })).toEqual([
      'destination: Choose a place from the list.',
    ]);
    expect(issuesOf({ ...valid.flights, destination: 'station:MAS' })).toEqual([
      'destination: Choose a place from the list.',
    ]);
    expect(issuesOf({ ...valid.flights, destination: 'airport:BLR' })).toEqual([
      'destination: Choose a different place from the start.',
    ]);
    expect(issuesOf({ ...valid.metro, destination: 'metro:del-rajiv-chowk' })).toEqual([
      'destination: Choose a place in Bengaluru.',
    ]);
    expect(issuesOf({ ...valid.cabs, dropoff: 'locality:bom-bkc' })).toEqual([
      'dropoff: Choose a place in Bengaluru.',
    ]);
    expect(issuesOf({ ...valid.buses, destination: 'city:bengaluru' })).toEqual([
      'destination: Choose a different place from the start.',
    ]);
  });

  it('validates dates and date ranges', () => {
    expect(
      issuesOf({ ...valid.flights, departureDate: `${Number(in10.slice(0, 4)) + 1}-02-30` }),
    ).toEqual(['departureDate: Enter a real date.']);
    expect(issuesOf({ ...valid.flights, departureDate: '12/11/2026' })[0]).toMatch(/YYYY-MM-DD/);
    expect(issuesOf({ ...valid.flights, departureDate: utcDateFromToday(-3) })).toEqual([
      'departureDate: That date has already passed.',
    ]);
    expect(issuesOf({ ...valid.flights, departureDate: utcDateFromToday(400) })[0]).toMatch(
      /within the next 365 days/,
    );
    expect(issuesOf({ ...valid.flights, returnDate: utcDateFromToday(5) })).toEqual([
      'returnDate: Return on or after the departure date.',
    ]);
    expect(issuesOf({ ...valid.flights, returnDate: in10 })).toEqual([]); // same-day return is fine
    expect(issuesOf({ ...valid.hotels, checkOut: in10 })).toEqual([
      'checkOut: Check out at least one night after check-in.',
    ]);
    expect(issuesOf({ ...valid.hotels, checkOut: utcDateFromToday(41) })).toEqual([
      'checkOut: Stays can be at most 30 nights.',
    ]);
    expect(issuesOf({ ...valid.cabs, pickupAt: '2026-11-12 10:00' })[0]).toMatch(/UTC offset/);
    expect(
      issuesOf({ ...valid.cabs, pickupAt: new Date(Date.now() - 86_400_000).toISOString() }),
    ).toEqual(['pickupAt: Choose a pick-up time in the future.']);
  });

  it('validates party sizes', () => {
    expect(issuesOf({ ...valid.flights, adults: 0 })).toEqual(['adults: Enter 1 or more.']);
    expect(issuesOf({ ...valid.flights, adults: 5, children: 5 })).toEqual([
      'children: At most 9 seated passengers (adults and children).',
    ]);
    expect(issuesOf({ ...valid.flights, adults: 1, infants: 2 })).toEqual([
      'infants: At most one infant per adult.',
    ]);
    expect(issuesOf({ ...valid.flights, adults: 1.5 })[0]).toMatch(/whole number/);
    expect(issuesOf({ ...valid.hotels, rooms: 3, adults: 2 })).toEqual([
      'adults: Each room needs at least one adult.',
    ]);
    expect(issuesOf({ ...valid.hotels, rooms: 1, adults: 5 })).toEqual([
      'adults: At most 4 adults per room.',
    ]);
    expect(issuesOf({ ...valid.trains, adults: 4, children: 3 })).toEqual([
      'children: At most 6 passengers per search.',
    ]);
    expect(issuesOf({ ...valid.cabs, passengers: 8 })).toEqual(['passengers: Enter 7 or fewer.']);
  });

  it('validates currencies, pagination and sort options', () => {
    expect(issuesOf({ ...valid.flights, currency: 'XYZ' })[0]).toMatch(/Currency must be one of/);
    expect(issuesOf({ ...valid.flights, currency: 'inr' })[0]).toMatch(/Currency/);
    expect(issuesOf({ ...valid.flights, page: 0 })[0]).toMatch(/^page/);
    expect(issuesOf({ ...valid.flights, page: 101 })[0]).toMatch(/^page/);
    expect(issuesOf({ ...valid.flights, pageSize: 51 })[0]).toMatch(/^pageSize/);
    expect(issuesOf({ ...valid.hotels, sortBy: 'rating-desc' })[0]).toMatch(/^sortBy/);
    expect(issuesOf({ ...valid.metro, sortBy: 'price-asc' })[0]).toMatch(/^sortBy/);
  });

  it('validates category-specific filters', () => {
    expect(issuesOf({ ...valid.flights, filters: { maxStops: 3 } })[0]).toMatch(/maxStops/);
    expect(issuesOf({ ...valid.flights, filters: { maxPriceMinor: '-5' } })[0]).toMatch(
      /maxPriceMinor/,
    );
    expect(issuesOf({ ...valid.trains, filters: { classes: ['3A', '3A'] } })[0]).toMatch(
      /duplicate/,
    );
    expect(issuesOf({ ...valid.trains, filters: { classes: ['GN'] } })[0]).toMatch(/classes/);
    expect(issuesOf({ ...valid.holidays, filters: { minNights: 6, maxNights: 3 } })).toEqual([
      'filters.maxNights: Must be at least the minimum.',
    ]);
    expect(issuesOf({ ...valid.cabs, filters: { vehicleTypes: ['helicopter'] } })[0]).toMatch(
      /vehicleTypes/,
    );
  });

  it('counts the party per category', () => {
    expect(
      partySize(
        searchRequestSchema.parse({ ...valid.flights, adults: 2, children: 1, infants: 1 }),
      ),
    ).toBe(4);
    expect(partySize(searchRequestSchema.parse({ ...valid.cabs, passengers: 3 }))).toBe(3);
  });

  it('exposes one schema per category', () => {
    expect(Object.keys(searchRequestSchemas)).toEqual([
      'flights',
      'hotels',
      'trains',
      'buses',
      'metro',
      'cabs',
      'holidays',
    ]);
  });
});

describe('search place directory', () => {
  it('is valid, unique and lookup-able', () => {
    for (const place of SEARCH_PLACES) expect(placeSchema.parse(place)).toEqual(place);
    expect(new Set(SEARCH_PLACES.map((p) => p.id)).size).toBe(SEARCH_PLACES.length);
    expect(findPlace('airport:BLR')?.code).toBe('BLR');
    expect(findPlace('nope:x')).toBeUndefined();
  });

  it('helpers', () => {
    expect(daysBetween('2026-11-10', '2026-11-13')).toBe(3);
  });
});

describe('search results and response', () => {
  const base = {
    id: 'demo-hotels:goa-casa',
    providerId: 'demo-hotels',
    source: 'demo',
    title: 'Casa',
    price: { kind: 'total', total: { amountMinor: '1200000', currency: 'INR' }, perUnit: null },
    offerRef: 'goa-casa',
    validUntil: '2026-11-10T10:00:00+05:30',
  };
  const hotel = {
    ...base,
    serviceType: 'hotels',
    property: { name: 'Casa', propertyType: 'boutique', area: null, cityName: 'Goa' },
    roomType: 'Double room',
    checkIn: '2026-11-10',
    checkOut: '2026-11-12',
    nights: 2,
    rooms: 1,
    guests: 2,
    amenities: ['wifi'],
    breakfastIncluded: true,
  };

  it('accepts a well-formed result and rejects category mix-ups and floats', () => {
    expect(searchResultSchema.safeParse(hotel).success).toBe(true);
    expect(searchResultSchema.safeParse({ ...hotel, serviceType: 'flights' }).success).toBe(false);
    expect(
      searchResultSchema.safeParse({
        ...hotel,
        price: { ...hotel.price, total: { amountMinor: '12.5', currency: 'INR' } },
      }).success,
    ).toBe(false);
    expect(searchResultSchema.safeParse({ ...hotel, availability: 'probably' }).success).toBe(
      false,
    );
  });

  it('accepts a response envelope', () => {
    const response = {
      searchId: '01890000-0000-7000-8000-000000000001',
      serviceType: 'hotels',
      results: [hotel],
      pagination: { page: 1, pageSize: 10, totalResults: 1, totalPages: 1 },
      providerStatuses: [
        {
          providerId: 'demo-hotels',
          providerName: 'Demo',
          kind: 'demo',
          status: 'success',
          resultCount: 1,
          durationMs: 3,
          message: null,
        },
      ],
      dataSource: 'demo',
      disclaimer: 'Demo data',
      warnings: [],
      generatedAt: '2026-11-10T04:30:00+00:00',
      expiresAt: '2026-11-10T04:32:00+00:00',
      facets: {
        price: {
          min: { amountMinor: '390000', currency: 'INR' },
          max: { amountMinor: '390000', currency: 'INR' },
          basis: 'night',
        },
        durationMinutes: null,
        options: { areas: [{ value: 'Palolem', label: 'Palolem', count: 1 }] },
      },
    };
    expect(searchResponseSchema.parse(response)).toEqual(response);
    expect(() =>
      searchResponseSchema.parse({
        ...response,
        facets: { ...response.facets, options: { ratings: [] } },
      }),
    ).toThrow();
  });

  it('accepts an offer lookup response', () => {
    const offer = {
      searchId: '01890000-0000-7000-8000-000000000001',
      serviceType: 'hotels',
      result: hotel,
      disclaimer: 'Demo data',
      generatedAt: '2026-11-10T04:30:00+00:00',
      expiresAt: '2026-11-10T04:40:00+00:00',
    };
    expect(offerResponseSchema.parse(offer)).toEqual(offer);
  });
});

describe('Phase 10 filters and sorting', () => {
  it('accepts every category filter on real result fields', () => {
    const ok = (input: Record<string, unknown>) => expect(issuesOf(input)).toEqual([]);
    ok({
      ...valid.flights,
      filters: {
        maxStops: 1,
        departureWindows: ['morning'],
        arrivalWindows: ['evening'],
        carriers: ['CDA'],
        maxDurationMinutes: 240,
        minPriceMinor: '100000',
        maxPriceMinor: '900000',
      },
      sortBy: 'price-desc',
    });
    ok({
      ...valid.hotels,
      filters: {
        propertyTypes: ['resort'],
        amenities: ['pool'],
        areas: ['Candolim'],
        breakfastIncluded: true,
        minNightlyPriceMinor: '300000',
        maxNightlyPriceMinor: '1200000',
      },
    });
    ok({
      ...valid.trains,
      filters: { trains: ['D2601'], arrivalWindows: ['night'], maxDurationMinutes: 600 },
    });
    ok({
      ...valid.buses,
      filters: {
        operators: ['Deccan Demo Travels'],
        amenities: ['Charging point'],
        maxPriceMinor: '200000',
      },
    });
    ok({ ...valid.metro, filters: { lines: ['blr-purple'], maxDurationMinutes: 45 } });
    ok({
      ...valid.cabs,
      filters: { minCapacity: 4, minPriceMinor: '50000' },
      sortBy: 'price-desc',
    });
    ok({
      ...valid.holidays,
      filters: { minPriceMinor: '1000000', maxPriceMinor: '9000000' },
      sortBy: 'price-desc',
    });
  });

  it('rejects inverted ranges, invented filters and sorts, and bad values', () => {
    expect(
      issuesOf({ ...valid.flights, filters: { minPriceMinor: '900000', maxPriceMinor: '100000' } }),
    ).toEqual(['filters.maxPriceMinor: Must be at least the minimum.']);
    expect(
      issuesOf({
        ...valid.hotels,
        filters: { minNightlyPriceMinor: '900000', maxNightlyPriceMinor: '100000' },
      }),
    ).toEqual(['filters.maxNightlyPriceMinor: Must be at least the minimum.']);
    // No rating data exists, so there is no rating filter or sort.
    expect(issuesOf({ ...valid.hotels, filters: { minRating: 4 } })).not.toEqual([]);
    expect(issuesOf({ ...valid.hotels, sortBy: 'rating-desc' })).not.toEqual([]);
    expect(issuesOf({ ...valid.hotels, sortBy: 'default' })).not.toEqual([]);
    expect(issuesOf({ ...valid.flights, filters: { carriers: ['CDA', 'CDA'] } })).not.toEqual([]);
    expect(issuesOf({ ...valid.flights, filters: { carriers: [''] } })).not.toEqual([]);
    expect(issuesOf({ ...valid.flights, filters: { maxDurationMinutes: 5 } })).not.toEqual([]);
    expect(issuesOf({ ...valid.cabs, filters: { minCapacity: 9 } })).not.toEqual([]);
    expect(issuesOf({ ...valid.hotels, filters: { breakfastIncluded: 'yes' } })).not.toEqual([]);
  });

  it('documents a default sort that each category schema actually accepts', () => {
    for (const [type, sort] of Object.entries(DEFAULT_SORT)) {
      expect(SORT_OPTIONS[type as keyof typeof SORT_OPTIONS]).toContain(sort);
    }
  });
});
