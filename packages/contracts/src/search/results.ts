import { z } from 'zod';
import { moneySchema } from '../money.js';
import {
  dataSourceSchema,
  offsetDateTimeSchema,
  paginationSchema,
  providerStatusSchema,
  searchPriceSchema,
  searchServiceTypeSchema,
  searchWarningSchema,
  isoDateSchema,
} from './common.js';
import {
  busTypeSchema,
  cabinClassSchema,
  holidayInterestSchema,
  hotelAmenitySchema,
  propertyTypeSchema,
  trainClassSchema,
  vehicleTypeSchema,
} from './requests.js';

/*
 * Normalized search results (Phase 9).
 *
 * Every provider adapter translates its supplier's format into exactly these
 * shapes, and the API validates each result against them before returning it.
 * Results are a discriminated union on `serviceType`; each category carries
 * only the fields that make sense for it. Optional fields are omitted, never
 * filled with invented values.
 */

/** Optional availability: set ONLY when a provider actually reports it. Demo data never does. */
export const availabilitySchema = z.enum(['available', 'limited', 'sold-out']);

const resultBase = {
  /** Stable for the same provider offer: `<providerId>:<offerRef>`. */
  id: z.string().min(1).max(200),
  providerId: z.string().min(1).max(64),
  source: dataSourceSchema,
  /** One-line summary for lists and screen readers. */
  title: z.string().min(1).max(200),
  price: searchPriceSchema.nullable(),
  availability: availabilitySchema.optional(),
  /**
   * The provider's own reference for this offer, for a later revalidation or
   * booking step. Opaque; only meaningful to the provider that issued it.
   */
  offerRef: z.string().min(1).max(200),
  /** Until when the price shown is indicative. Never a guarantee. */
  validUntil: offsetDateTimeSchema,
};

const pointSchema = z.object({
  /** Place id from the search place directory, when the point is one. */
  placeId: z.string().nullable(),
  code: z.string().nullable(),
  name: z.string().min(1),
  cityName: z.string().min(1),
});
export type ResultPoint = z.infer<typeof pointSchema>;

const timedLeg = {
  departAt: offsetDateTimeSchema,
  arriveAt: offsetDateTimeSchema,
  durationMinutes: z.number().int().positive(),
};

// ─── Flights ──────────────────────────────────────────────────────────────

export const flightSegmentSchema = z.object({
  carrier: z.object({ code: z.string().min(1), name: z.string().min(1) }),
  flightNumber: z.string().min(1),
  origin: pointSchema,
  destination: pointSchema,
  ...timedLeg,
});

export const flightItinerarySchema = z.object({
  direction: z.enum(['outbound', 'return']),
  segments: z.array(flightSegmentSchema).min(1),
  stops: z.number().int().min(0),
  ...timedLeg,
});

/** The party a flight offer is priced for (from the search; the price covers all of them). */
export const flightPassengersSchema = z.object({
  adults: z.number().int().min(1),
  children: z.number().int().min(0),
  infants: z.number().int().min(0),
});
export type FlightPassengers = z.infer<typeof flightPassengersSchema>;

export const flightResultSchema = z.object({
  serviceType: z.literal('flights'),
  ...resultBase,
  cabinClass: cabinClassSchema,
  itineraries: z.array(flightItinerarySchema).min(1).max(2),
  passengers: flightPassengersSchema,
});

// ─── Hotels ───────────────────────────────────────────────────────────────

export const hotelResultSchema = z.object({
  serviceType: z.literal('hotels'),
  ...resultBase,
  property: z.object({
    name: z.string().min(1),
    propertyType: propertyTypeSchema,
    area: z.string().nullable(),
    cityName: z.string().min(1),
  }),
  roomType: z.string().min(1),
  checkIn: isoDateSchema,
  checkOut: isoDateSchema,
  nights: z.number().int().positive(),
  rooms: z.number().int().positive(),
  guests: z.number().int().positive(),
  amenities: z.array(hotelAmenitySchema),
  breakfastIncluded: z.boolean(),
});

// ─── Trains ───────────────────────────────────────────────────────────────

export const trainResultSchema = z.object({
  serviceType: z.literal('trains'),
  ...resultBase,
  trainNumber: z.string().min(1),
  trainName: z.string().min(1),
  origin: pointSchema,
  destination: pointSchema,
  ...timedLeg,
  travelClass: z.object({ code: trainClassSchema, name: z.string().min(1) }),
  passengers: z.number().int().positive(),
});

// ─── Buses ────────────────────────────────────────────────────────────────

export const busResultSchema = z.object({
  serviceType: z.literal('buses'),
  ...resultBase,
  operatorName: z.string().min(1),
  busType: busTypeSchema,
  origin: pointSchema,
  destination: pointSchema,
  ...timedLeg,
  passengers: z.number().int().positive(),
  amenities: z.array(z.string().min(1)),
});

// ─── Metro ────────────────────────────────────────────────────────────────

export const metroLegSchema = z.object({
  line: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    colour: z.string().regex(/^#[0-9a-f]{6}$/i),
  }),
  from: pointSchema,
  to: pointSchema,
  stops: z.number().int().positive(),
  durationMinutes: z.number().int().positive(),
});

export const metroResultSchema = z.object({
  serviceType: z.literal('metro'),
  ...resultBase,
  cityName: z.string().min(1),
  origin: pointSchema,
  destination: pointSchema,
  legs: z.array(metroLegSchema).min(1),
  transfers: z.number().int().min(0),
  /** Estimated in-train time plus interchange walking; no timetable. */
  durationMinutes: z.number().int().positive(),
  passengers: z.number().int().positive(),
});

// ─── Cabs ─────────────────────────────────────────────────────────────────

export const cabResultSchema = z
  .object({
    serviceType: z.literal('cabs'),
    ...resultBase,
    vehicleType: vehicleTypeSchema,
    /** Generic description, e.g. "Sedan (Dzire-size)"; no specific car is promised. */
    vehicleLabel: z.string().min(1),
    capacity: z.number().int().positive(),
    pickup: pointSchema,
    dropoff: pointSchema,
    pickupAt: offsetDateTimeSchema,
    distanceKm: z.number().positive(),
    /** Estimated drive time in normal traffic. */
    durationMinutes: z.number().int().positive(),
    /** Passengers the ride was searched for (never more than the vehicle seats). */
    passengers: z.number().int().positive(),
  })
  .refine((cab) => cab.passengers <= cab.capacity, {
    message: 'A ride can’t carry more passengers than it has seats.',
    path: ['passengers'],
  });

// ─── Holidays ─────────────────────────────────────────────────────────────

export const holidayResultSchema = z.object({
  serviceType: z.literal('holidays'),
  ...resultBase,
  packageName: z.string().min(1),
  destination: pointSchema,
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  nights: z.number().int().positive(),
  travellers: z.number().int().positive(),
  inclusions: z.array(z.string().min(1)),
  highlights: z.array(z.string().min(1)),
  interests: z.array(holidayInterestSchema),
});

// ─── Union and response ───────────────────────────────────────────────────

export const searchResultSchema = z.discriminatedUnion('serviceType', [
  flightResultSchema,
  hotelResultSchema,
  trainResultSchema,
  busResultSchema,
  metroResultSchema,
  cabResultSchema,
  holidayResultSchema,
]);
export type SearchResult = z.infer<typeof searchResultSchema>;
export type SearchResultFor<S extends SearchResult['serviceType']> = Extract<
  SearchResult,
  { serviceType: S }
>;
export type FlightResult = SearchResultFor<'flights'>;
export type HotelResult = SearchResultFor<'hotels'>;
export type TrainResult = SearchResultFor<'trains'>;
export type BusResult = SearchResultFor<'buses'>;
export type MetroResult = SearchResultFor<'metro'>;
export type CabResult = SearchResultFor<'cabs'>;
export type HolidayResult = SearchResultFor<'holidays'>;

export const searchResultSchemas = {
  flights: flightResultSchema,
  hotels: hotelResultSchema,
  trains: trainResultSchema,
  buses: busResultSchema,
  metro: metroResultSchema,
  cabs: cabResultSchema,
  holidays: holidayResultSchema,
} as const;

// ─── Facets (Phase 10) ────────────────────────────────────────────────────

/**
 * Filter choices found in a search's results, so a UI only offers filters
 * that match something real. Computed from the whole provider round (before
 * filters), so choices don't vanish as filters are applied; counts are of
 * that unfiltered set.
 */
export const facetKeySchema = z.enum([
  'stops',
  'carriers',
  'propertyTypes',
  'amenities',
  'areas',
  'classes',
  'trains',
  'operators',
  'busTypes',
  'busAmenities',
  'lines',
  'transfers',
  'vehicleTypes',
  'capacities',
  'interests',
  'nights',
]);
export type FacetKey = z.infer<typeof facetKeySchema>;

export const facetOptionSchema = z.object({
  /** The filter value to send back (a code, id or provider label). */
  value: z.string().min(1),
  label: z.string().min(1),
  count: z.number().int().min(1),
});
export type FacetOption = z.infer<typeof facetOptionSchema>;

const numberRange = z.object({ min: z.number().int(), max: z.number().int() });

export const searchFacetsSchema = z.object({
  /**
   * Lowest and highest comparable price in the request currency (per night
   * for hotels, the low end of a range for cab estimates); null when no result
   * has one.
   */
  price: z
    .object({ min: moneySchema, max: moneySchema, basis: z.enum(['total', 'night']) })
    .nullable(),
  /** Journey minutes (longest direction for return flights); null where not meaningful. */
  durationMinutes: numberRange.nullable(),
  options: z.partialRecord(facetKeySchema, z.array(facetOptionSchema)),
});
export type SearchFacets = z.infer<typeof searchFacetsSchema>;

export const searchResponseSchema = z.object({
  /** Identifies this set of provider answers; stays the same while paging, sorting and filtering within its lifetime. */
  searchId: z.uuid(),
  serviceType: searchServiceTypeSchema,
  results: z.array(searchResultSchema),
  pagination: paginationSchema,
  providerStatuses: z.array(providerStatusSchema),
  /** `demo` when every result is fixture data; `mixed` if demo and live are combined. */
  dataSource: z.enum(['demo', 'live', 'mixed', 'none']),
  /** Shown with demo results; null for live-only data. */
  disclaimer: z.string().nullable(),
  warnings: z.array(searchWarningSchema),
  generatedAt: offsetDateTimeSchema,
  /** After this, run the search again rather than reusing these results. */
  expiresAt: offsetDateTimeSchema,
  facets: searchFacetsSchema,
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

/**
 * How current an offer is (docs/search.md#offer-validation).
 *
 * - `session`: exactly as the provider returned it in this search; not
 *   rechecked with the supplier (demo providers, or suppliers without a
 *   revalidation API). Valid for this search until `expiresAt` only.
 * - `confirmed`: the provider rechecked it just now (`checkedAt`); unchanged.
 * - `price-changed`: the provider rechecked it and the price is different.
 *   `result.price` is the new price, `previousPrice` the one the search showed.
 */
export const offerValidationSchema = z.object({
  status: z.enum(['session', 'confirmed', 'price-changed']),
  checkedAt: offsetDateTimeSchema.nullable(),
  previousPrice: searchPriceSchema.nullable(),
});
export type OfferValidation = z.infer<typeof offerValidationSchema>;

/**
 * One offer from a search session (GET /search/:serviceType/sessions/:searchId/offer).
 * Always read from the server's copy of the search, never from client data.
 */
export const offerResponseSchema = z.object({
  searchId: z.uuid(),
  serviceType: searchServiceTypeSchema,
  result: searchResultSchema,
  disclaimer: z.string().nullable(),
  generatedAt: offsetDateTimeSchema,
  expiresAt: offsetDateTimeSchema,
  validation: offerValidationSchema,
});
export type OfferResponse = z.infer<typeof offerResponseSchema>;

// ─── Providers (GET /providers) ───────────────────────────────────────────

export const providerOperationSchema = z.enum(['search', 'revalidate', 'book']);
export type ProviderOperation = z.infer<typeof providerOperationSchema>;

/** Safe provider metadata: no credentials, URLs or internal configuration values. */
export const providerInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: dataSourceSchema,
  serviceTypes: z.array(searchServiceTypeSchema).min(1),
  operations: z.record(providerOperationSchema, z.enum(['supported', 'unsupported'])),
  enabled: z.boolean(),
  /** Why a provider is disabled, in plain words; null when enabled. */
  disabledReason: z.string().nullable(),
  timeoutMs: z.number().int().positive(),
});
export type ProviderInfo = z.infer<typeof providerInfoSchema>;
export const providerInfoListSchema = z.array(providerInfoSchema);
