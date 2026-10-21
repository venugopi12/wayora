import { z } from 'zod';
import {
  daysBetween,
  departureWindowSchema,
  maxPriceMinorSchema,
  offsetDateTimeSchema,
  pageSchema,
  pageSizeSchema,
  searchCurrencySchema,
  travelDateSchema,
} from './common.js';
import { findPlace, placeIdSchema, type PlaceKind } from './places.js';

/*
 * Search requests, one schema per category, combined into a discriminated
 * union on `serviceType`. Each category asks only for what it needs. Every
 * schema is strict (unknown fields are rejected) and checks route rules
 * (known places of the right kind, origin ≠ destination, same city where
 * required), date ranges and party sizes, so nothing invalid reaches a
 * provider.
 */

const commonFields = {
  currency: searchCurrencySchema.default('INR'),
  page: pageSchema,
  pageSize: pageSizeSchema,
};

type Ctx = z.RefinementCtx;

function checkPlace(ctx: Ctx, path: string, id: string, kinds: readonly PlaceKind[]) {
  const place = findPlace(id);
  if (!place || !kinds.includes(place.kind)) {
    ctx.addIssue({ code: 'custom', path: [path], message: 'Choose a place from the list.' });
    return undefined;
  }
  return place;
}

function checkRoute(
  ctx: Ctx,
  [fromKey, toKey]: readonly [string, string],
  from: string,
  to: string,
  kinds: readonly PlaceKind[],
  { sameCity = false }: { sameCity?: boolean } = {},
) {
  const a = checkPlace(ctx, fromKey, from, kinds);
  const b = checkPlace(ctx, toKey, to, kinds);
  if (!a || !b) return;
  if (a.id === b.id) {
    ctx.addIssue({
      code: 'custom',
      path: [toKey],
      message: 'Choose a different place from the start.',
    });
  } else if (sameCity && a.cityId !== b.cityId) {
    ctx.addIssue({ code: 'custom', path: [toKey], message: `Choose a place in ${a.cityName}.` });
  } else if (!sameCity && a.cityId === b.cityId) {
    ctx.addIssue({
      code: 'custom',
      path: [toKey],
      message: 'Choose a different city from the start.',
    });
  }
}

const count = (min: number, max: number, label: string) =>
  z.coerce
    .number({ error: `Enter the number of ${label}.` })
    .int(`Enter a whole number of ${label}.`)
    .min(min, `Enter ${min} or more.`)
    .max(max, `Enter ${max} or fewer.`);

const uniqueList = <T extends z.ZodType>(item: T, max: number) =>
  z
    .array(item)
    .max(max)
    .refine((v) => new Set(v).size === v.length, { error: 'Remove duplicate values.' });

/*
 * Filters (Phase 10). Every filter refers to a field that the normalized
 * result for its category actually carries; the API applies them to the full
 * provider round, so they never trigger new provider calls within a search's
 * lifetime. Price limits are integer minor units in the request currency.
 */

/** A provider-supplied label used as a filter value (operator, area, train number…). */
const facetValue = z.string().trim().min(1).max(80);
const valueList = (max = 30) => uniqueList(facetValue, max);

/** Maximum minutes for a journey (each direction, for flights). */
const maxDurationSchema = z.coerce
  .number()
  .int()
  .min(15)
  .max(72 * 60);

/** `min ≤ max` for paired range filters. */
function checkRange(
  ctx: Ctx,
  filters: Record<string, unknown>,
  [minKey, maxKey]: readonly [string, string],
  compare: (a: string | number, b: string | number) => boolean = (a, b) => BigInt(a) <= BigInt(b),
) {
  const min = filters[minKey];
  const max = filters[maxKey];
  if (
    (typeof min === 'string' || typeof min === 'number') &&
    (typeof max === 'string' || typeof max === 'number') &&
    !compare(min, max)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['filters', maxKey],
      message: 'Must be at least the minimum.',
    });
  }
}
const priceRange = (
  filters: Record<string, unknown>,
  ctx: Ctx,
  keys: readonly [string, string] = ['minPriceMinor', 'maxPriceMinor'],
) => checkRange(ctx, filters, keys);

/**
 * The sort applied when a request names none, per category (docs/search.md#sorting):
 * - flights `recommended`: fewest stops, then lowest price, then shortest
 *   journey, then earliest departure. Uses only fields every result has.
 * - trains, buses: earliest departure (a timetable reading).
 * - metro: fewest changes, then shortest journey.
 * - hotels, cabs, holidays: lowest price.
 * Every sort ends with deterministic tie-breaks (price, departure, duration,
 * then result id), and results without a comparable price go last.
 */
export const DEFAULT_SORT = {
  flights: 'recommended',
  hotels: 'price-asc',
  trains: 'departure-asc',
  buses: 'departure-asc',
  metro: 'transfers-asc',
  cabs: 'price-asc',
  holidays: 'price-asc',
} as const;

// ─── Flights ──────────────────────────────────────────────────────────────

export const cabinClassSchema = z.enum(['economy', 'premium-economy', 'business', 'first']);
export type CabinClass = z.infer<typeof cabinClassSchema>;
export const flightSortSchema = z.enum([
  'recommended',
  'price-asc',
  'price-desc',
  'duration-asc',
  'departure-asc',
]);

export const MAX_FLIGHT_PASSENGERS = 9;

export const flightSearchRequestSchema = z
  .object({
    serviceType: z.literal('flights'),
    origin: placeIdSchema,
    destination: placeIdSchema,
    departureDate: travelDateSchema,
    /** Present for a return trip. */
    returnDate: travelDateSchema.optional(),
    adults: count(1, MAX_FLIGHT_PASSENGERS, 'adults'),
    children: count(0, MAX_FLIGHT_PASSENGERS - 1, 'children').default(0),
    /** Under two, on a lap: at most one per adult. */
    infants: count(0, MAX_FLIGHT_PASSENGERS, 'infants').default(0),
    cabinClass: cabinClassSchema.default('economy'),
    filters: z
      .object({
        maxStops: z.coerce.number().int().min(0).max(2).optional(),
        departureWindows: uniqueList(departureWindowSchema, 5).optional(),
        arrivalWindows: uniqueList(departureWindowSchema, 5).optional(),
        /** Carrier codes, as in `segments[].carrier.code`; matches if any segment is operated by one. */
        carriers: valueList(20).optional(),
        maxDurationMinutes: maxDurationSchema.optional(),
        minPriceMinor: maxPriceMinorSchema.optional(),
        maxPriceMinor: maxPriceMinorSchema.optional(),
      })
      .strict()
      .default({}),
    sortBy: flightSortSchema.default(DEFAULT_SORT.flights),
    ...commonFields,
  })
  .strict()
  .superRefine((v, ctx) => {
    checkRoute(ctx, ['origin', 'destination'], v.origin, v.destination, ['airport']);
    priceRange(v.filters, ctx);
    if (v.returnDate !== undefined && v.returnDate < v.departureDate) {
      ctx.addIssue({
        code: 'custom',
        path: ['returnDate'],
        message: 'Return on or after the departure date.',
      });
    }
    if (v.adults + v.children > MAX_FLIGHT_PASSENGERS) {
      ctx.addIssue({
        code: 'custom',
        path: ['children'],
        message: `At most ${MAX_FLIGHT_PASSENGERS} seated passengers (adults and children).`,
      });
    }
    if (v.infants > v.adults) {
      ctx.addIssue({ code: 'custom', path: ['infants'], message: 'At most one infant per adult.' });
    }
  });

// ─── Hotels ───────────────────────────────────────────────────────────────

export const propertyTypeSchema = z.enum(['hotel', 'resort', 'boutique', 'homestay']);
export const hotelAmenitySchema = z.enum(['wifi', 'breakfast', 'pool', 'spa', 'parking', 'gym']);
export const hotelSortSchema = z.enum(['price-asc', 'price-desc']);
export const MAX_HOTEL_NIGHTS = 30;
export const MAX_ROOMS = 8;

export const hotelSearchRequestSchema = z
  .object({
    serviceType: z.literal('hotels'),
    destination: placeIdSchema,
    checkIn: travelDateSchema,
    checkOut: travelDateSchema,
    rooms: count(1, MAX_ROOMS, 'rooms').default(1),
    adults: count(1, MAX_ROOMS * 4, 'adults'),
    children: count(0, MAX_ROOMS * 3, 'children').default(0),
    filters: z
      .object({
        propertyTypes: uniqueList(propertyTypeSchema, 4).optional(),
        /** All listed amenities must be present. */
        amenities: uniqueList(hotelAmenitySchema, 6).optional(),
        /** Neighbourhoods, as in `property.area`. */
        areas: valueList().optional(),
        /** Only results that include breakfast (`breakfastIncluded`). */
        breakfastIncluded: z.boolean().optional(),
        /** Per night for all rooms (the result's `perUnit` night price). */
        minNightlyPriceMinor: maxPriceMinorSchema.optional(),
        maxNightlyPriceMinor: maxPriceMinorSchema.optional(),
      })
      .strict()
      .default({}),
    sortBy: hotelSortSchema.default(DEFAULT_SORT.hotels),
    ...commonFields,
  })
  .strict()
  .superRefine((v, ctx) => {
    checkPlace(ctx, 'destination', v.destination, ['city']);
    priceRange(v.filters, ctx, ['minNightlyPriceMinor', 'maxNightlyPriceMinor']);
    const nights = daysBetween(v.checkIn, v.checkOut);
    if (nights < 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['checkOut'],
        message: 'Check out at least one night after check-in.',
      });
    } else if (nights > MAX_HOTEL_NIGHTS) {
      ctx.addIssue({
        code: 'custom',
        path: ['checkOut'],
        message: `Stays can be at most ${MAX_HOTEL_NIGHTS} nights.`,
      });
    }
    if (v.adults < v.rooms) {
      ctx.addIssue({
        code: 'custom',
        path: ['adults'],
        message: 'Each room needs at least one adult.',
      });
    }
    if (v.adults > v.rooms * 4) {
      ctx.addIssue({ code: 'custom', path: ['adults'], message: 'At most 4 adults per room.' });
    }
    if (v.children > v.rooms * 3) {
      ctx.addIssue({ code: 'custom', path: ['children'], message: 'At most 3 children per room.' });
    }
  });

// ─── Trains ───────────────────────────────────────────────────────────────

/** Indian Railways class codes used by the demo data. */
export const trainClassSchema = z.enum(['1A', '2A', '3A', 'SL', 'CC', 'EC']);
export type TrainClass = z.infer<typeof trainClassSchema>;
export const TRAIN_CLASS_NAMES: Record<TrainClass, string> = {
  '1A': 'AC First Class',
  '2A': 'AC 2 Tier',
  '3A': 'AC 3 Tier',
  SL: 'Sleeper',
  CC: 'AC Chair Car',
  EC: 'Executive Chair Car',
};
export const trainSortSchema = z.enum(['departure-asc', 'duration-asc', 'price-asc', 'price-desc']);
export const busSortSchema = trainSortSchema;
export const MAX_RAIL_PASSENGERS = 6;

export const trainSearchRequestSchema = z
  .object({
    serviceType: z.literal('trains'),
    origin: placeIdSchema,
    destination: placeIdSchema,
    departureDate: travelDateSchema,
    adults: count(1, MAX_RAIL_PASSENGERS, 'adults'),
    children: count(0, MAX_RAIL_PASSENGERS - 1, 'children').default(0),
    filters: z
      .object({
        classes: uniqueList(trainClassSchema, 6).optional(),
        departureWindows: uniqueList(departureWindowSchema, 5).optional(),
        arrivalWindows: uniqueList(departureWindowSchema, 5).optional(),
        /** Train numbers, as in `trainNumber`. */
        trains: valueList().optional(),
        maxDurationMinutes: maxDurationSchema.optional(),
      })
      .strict()
      .default({}),
    sortBy: trainSortSchema.default(DEFAULT_SORT.trains),
    ...commonFields,
  })
  .strict()
  .superRefine((v, ctx) => {
    checkRoute(ctx, ['origin', 'destination'], v.origin, v.destination, ['rail-station']);
    if (v.adults + v.children > MAX_RAIL_PASSENGERS) {
      ctx.addIssue({
        code: 'custom',
        path: ['children'],
        message: `At most ${MAX_RAIL_PASSENGERS} passengers per search.`,
      });
    }
  });

// ─── Buses ────────────────────────────────────────────────────────────────

export const busTypeSchema = z.enum(['ac-sleeper', 'ac-seater', 'non-ac-sleeper', 'non-ac-seater']);
export type BusType = z.infer<typeof busTypeSchema>;
export const MAX_BUS_PASSENGERS = 6;

export const busSearchRequestSchema = z
  .object({
    serviceType: z.literal('buses'),
    origin: placeIdSchema,
    destination: placeIdSchema,
    departureDate: travelDateSchema,
    adults: count(1, MAX_BUS_PASSENGERS, 'adults'),
    children: count(0, MAX_BUS_PASSENGERS - 1, 'children').default(0),
    filters: z
      .object({
        busTypes: uniqueList(busTypeSchema, 4).optional(),
        departureWindows: uniqueList(departureWindowSchema, 5).optional(),
        arrivalWindows: uniqueList(departureWindowSchema, 5).optional(),
        /** Operator names, as in `operatorName`. */
        operators: valueList().optional(),
        /** All listed on-board amenities must be present. */
        amenities: valueList(10).optional(),
        maxDurationMinutes: maxDurationSchema.optional(),
        minPriceMinor: maxPriceMinorSchema.optional(),
        maxPriceMinor: maxPriceMinorSchema.optional(),
      })
      .strict()
      .default({}),
    sortBy: busSortSchema.default(DEFAULT_SORT.buses),
    ...commonFields,
  })
  .strict()
  .superRefine((v, ctx) => {
    checkRoute(ctx, ['origin', 'destination'], v.origin, v.destination, ['city']);
    priceRange(v.filters, ctx);
    if (v.adults + v.children > MAX_BUS_PASSENGERS) {
      ctx.addIssue({
        code: 'custom',
        path: ['children'],
        message: `At most ${MAX_BUS_PASSENGERS} passengers per search.`,
      });
    }
  });

// ─── Metro ────────────────────────────────────────────────────────────────

export const metroSortSchema = z.enum(['transfers-asc', 'duration-asc']);
export const MAX_METRO_PASSENGERS = 6;

/** Journey planning between two stations of one city's network. No timetables yet. */
export const metroSearchRequestSchema = z
  .object({
    serviceType: z.literal('metro'),
    origin: placeIdSchema,
    destination: placeIdSchema,
    passengers: count(1, MAX_METRO_PASSENGERS, 'passengers').default(1),
    filters: z
      .object({
        maxTransfers: z.coerce.number().int().min(0).max(3).optional(),
        /** Line ids, as in `legs[].line.id`; matches journeys that use any of them. */
        lines: valueList(10).optional(),
        maxDurationMinutes: maxDurationSchema.optional(),
      })
      .strict()
      .default({}),
    sortBy: metroSortSchema.default(DEFAULT_SORT.metro),
    ...commonFields,
  })
  .strict()
  .superRefine((v, ctx) => {
    checkRoute(ctx, ['origin', 'destination'], v.origin, v.destination, ['metro-station'], {
      sameCity: true,
    });
  });

// ─── Cabs ─────────────────────────────────────────────────────────────────

export const vehicleTypeSchema = z.enum(['hatchback', 'sedan', 'suv', 'premium']);
export type VehicleType = z.infer<typeof vehicleTypeSchema>;
export const cabSortSchema = z.enum(['price-asc', 'price-desc', 'capacity-desc']);
export const MAX_CAB_PASSENGERS = 7;
/** Cab pick-ups can be planned this far ahead. */
export const MAX_CAB_DAYS_AHEAD = 90;

export const cabSearchRequestSchema = z
  .object({
    serviceType: z.literal('cabs'),
    pickup: placeIdSchema,
    dropoff: placeIdSchema,
    /** Local pick-up time with its UTC offset. */
    pickupAt: offsetDateTimeSchema,
    passengers: count(1, MAX_CAB_PASSENGERS, 'passengers').default(1),
    filters: z
      .object({
        vehicleTypes: uniqueList(vehicleTypeSchema, 4).optional(),
        minCapacity: z.coerce.number().int().min(1).max(MAX_CAB_PASSENGERS).optional(),
        /** Estimates are ranges: one matches if it overlaps the price range. */
        minPriceMinor: maxPriceMinorSchema.optional(),
        maxPriceMinor: maxPriceMinorSchema.optional(),
      })
      .strict()
      .default({}),
    sortBy: cabSortSchema.default(DEFAULT_SORT.cabs),
    ...commonFields,
  })
  .strict()
  .superRefine((v, ctx) => {
    checkRoute(ctx, ['pickup', 'dropoff'], v.pickup, v.dropoff, ['airport', 'locality'], {
      sameCity: true,
    });
    priceRange(v.filters, ctx);
    const at = Date.parse(v.pickupAt);
    if (at < Date.now() - 15 * 60 * 1000) {
      ctx.addIssue({
        code: 'custom',
        path: ['pickupAt'],
        message: 'Choose a pick-up time in the future.',
      });
    } else if (at > Date.now() + MAX_CAB_DAYS_AHEAD * 24 * 60 * 60 * 1000) {
      ctx.addIssue({
        code: 'custom',
        path: ['pickupAt'],
        message: `Choose a pick-up time within the next ${MAX_CAB_DAYS_AHEAD} days.`,
      });
    }
  });

// ─── Holidays ─────────────────────────────────────────────────────────────

export const holidayInterestSchema = z.enum([
  'beach',
  'culture',
  'nature',
  'wellness',
  'food',
  'adventure',
]);
export type HolidayInterest = z.infer<typeof holidayInterestSchema>;
export const holidaySortSchema = z.enum([
  'price-asc',
  'price-desc',
  'duration-asc',
  'duration-desc',
]);
export const MAX_HOLIDAY_TRAVELLERS = 9;

export const holidaySearchRequestSchema = z
  .object({
    serviceType: z.literal('holidays'),
    destination: placeIdSchema,
    /** First day of the trip. */
    departureDate: travelDateSchema,
    adults: count(1, MAX_HOLIDAY_TRAVELLERS, 'adults'),
    children: count(0, MAX_HOLIDAY_TRAVELLERS - 1, 'children').default(0),
    filters: z
      .object({
        minNights: z.coerce.number().int().min(1).max(30).optional(),
        maxNights: z.coerce.number().int().min(1).max(30).optional(),
        interests: uniqueList(holidayInterestSchema, 6).optional(),
        /** Range for the whole party's package price. */
        minPriceMinor: maxPriceMinorSchema.optional(),
        maxPriceMinor: maxPriceMinorSchema.optional(),
      })
      .strict()
      .default({}),
    sortBy: holidaySortSchema.default(DEFAULT_SORT.holidays),
    ...commonFields,
  })
  .strict()
  .superRefine((v, ctx) => {
    checkPlace(ctx, 'destination', v.destination, ['destination']);
    priceRange(v.filters, ctx);
    if (v.adults + v.children > MAX_HOLIDAY_TRAVELLERS) {
      ctx.addIssue({
        code: 'custom',
        path: ['children'],
        message: `At most ${MAX_HOLIDAY_TRAVELLERS} travellers per search.`,
      });
    }
    const { minNights, maxNights } = v.filters;
    if (minNights !== undefined && maxNights !== undefined && minNights > maxNights) {
      ctx.addIssue({
        code: 'custom',
        path: ['filters', 'maxNights'],
        message: 'Must be at least the minimum.',
      });
    }
  });

// ─── Union ────────────────────────────────────────────────────────────────

export const searchRequestSchema = z.discriminatedUnion(
  'serviceType',
  [
    flightSearchRequestSchema,
    hotelSearchRequestSchema,
    trainSearchRequestSchema,
    busSearchRequestSchema,
    metroSearchRequestSchema,
    cabSearchRequestSchema,
    holidaySearchRequestSchema,
  ],
  { error: 'Unsupported service type.' },
);

/** Parsed (defaults applied) request for any category. */
export type SearchRequest = z.output<typeof searchRequestSchema>;
/** What a client may send. */
export type SearchRequestInput = z.input<typeof searchRequestSchema>;
export type SearchRequestFor<S extends SearchRequest['serviceType']> = Extract<
  SearchRequest,
  { serviceType: S }
>;
export type SearchRequestInputFor<S extends SearchRequest['serviceType']> = Extract<
  SearchRequestInput,
  { serviceType: S }
>;

export const searchRequestSchemas = {
  flights: flightSearchRequestSchema,
  hotels: hotelSearchRequestSchema,
  trains: trainSearchRequestSchema,
  buses: busSearchRequestSchema,
  metro: metroSearchRequestSchema,
  cabs: cabSearchRequestSchema,
  holidays: holidaySearchRequestSchema,
} as const;

/** Sort options per category, for forms. */
export const SORT_OPTIONS = {
  flights: flightSortSchema.options,
  hotels: hotelSortSchema.options,
  trains: trainSortSchema.options,
  buses: busSortSchema.options,
  metro: metroSortSchema.options,
  cabs: cabSortSchema.options,
  holidays: holidaySortSchema.options,
} as const;

/** Party size of a request (travellers, guests or passengers), for pricing and display. */
export function partySize(request: SearchRequest): number {
  switch (request.serviceType) {
    case 'metro':
    case 'cabs':
      return request.passengers;
    case 'flights':
      return request.adults + request.children + request.infants;
    default:
      return request.adults + request.children;
  }
}
