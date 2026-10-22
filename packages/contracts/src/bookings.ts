import { z } from 'zod';
import { personName } from './auth.js';
import {
  isoDateSchema,
  offsetDateTimeSchema,
  paginationSchema,
  searchPriceSchema,
  searchServiceTypeSchema,
} from './search/common.js';
import { offerValidationSchema, searchResultSchema, type SearchResult } from './search/results.js';

/*
 * Demo bookings (Phase 12, docs/bookings.md).
 *
 * A booking is created from an offer of a live search session. It is a
 * DEMO: Wayora stores the booking and simulates its confirmation, but no
 * supplier reservation, ticket or payment exists. Every booking says so
 * (`demo: true`), and its reference starts with `WYD-` ("Wayora demo").
 */

/** `WYD-` + two groups of four characters from an alphabet without look-alikes (no 0/O, 1/I/L). */
export const BOOKING_REFERENCE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const bookingReferenceSchema = z
  .string({ error: 'Name the booking.' })
  .trim()
  .toUpperCase()
  .regex(/^WYD-[23456789A-HJKMNP-Z]{4}-[23456789A-HJKMNP-Z]{4}$/, 'Not a valid booking reference.');

/**
 * Lifecycle (server-enforced; docs/bookings.md#statuses):
 *   pending ──(demo confirmation, simulated)──▶ confirmed
 *   pending ──▶ failed            pending | confirmed ──(you, before travel)──▶ cancelled
 * `cancelled` and `failed` are final.
 */
export const bookingStatusSchema = z.enum(['pending', 'confirmed', 'cancelled', 'failed']);
export type BookingStatus = z.infer<typeof bookingStatusSchema>;

export const passengerTypeSchema = z.enum(['adult', 'child', 'infant']);
export type PassengerType = z.infer<typeof passengerTypeSchema>;

// ─── What each category needs ────────────────────────────────────────────

export interface NamedTravellerSlot {
  /** Shown as the field group's label, e.g. "Adult 1", "Lead guest". */
  label: string;
  /** Only flights distinguish passenger types. */
  type: PassengerType | null;
}

export interface BookingRequirements {
  /** People whose names the booking needs, in order. May be empty (metro). */
  namedTravellers: NamedTravellerSlot[];
  /** How many people the offer is for (its price covers all of them). */
  partySize: number;
  /** What the party is called for this category. */
  partyNoun: { one: string; many: string };
  /** A mobile number for the operator (cabs). */
  contactPhone: 'required' | 'not-needed';
  /** Category-specific limits of the demo flow, in plain words. */
  note: string | null;
}

/** "Passenger" for one, "Passenger 1", "Passenger 2"… for several. */
const numbered = (label: string, count: number, type: PassengerType | null): NamedTravellerSlot[] =>
  Array.from({ length: count }, (_, i) => ({
    label: count === 1 ? label : `${label} ${i + 1}`,
    type,
  }));

/**
 * The details a demo booking of `offer` needs, derived only from fields the
 * offer contract has. Shared by the API (which enforces it) and the web app
 * (which builds the form from it), so the two can't disagree.
 */
export function bookingRequirementsFor(offer: SearchResult): BookingRequirements {
  switch (offer.serviceType) {
    case 'flights': {
      const { adults, children, infants } = offer.passengers;
      return {
        namedTravellers: [
          ...numbered('Adult', adults, 'adult'),
          ...numbered('Child', children, 'child'),
          ...numbered('Infant', infants, 'infant'),
        ],
        partySize: adults + children + infants,
        partyNoun: { one: 'passenger', many: 'passengers' },
        contactPhone: 'not-needed',
        note: 'Names as they appear on each passenger’s ID. The demo asks for nothing else (no passport, date of birth or seats).',
      };
    }
    case 'hotels':
      return {
        namedTravellers: [{ label: 'Lead guest', type: null }],
        partySize: offer.guests,
        partyNoun: { one: 'guest', many: 'guests' },
        contactPhone: 'not-needed',
        note: `One lead guest checks in for all ${offer.guests} guest${offer.guests === 1 ? '' : 's'} in ${offer.rooms} room${offer.rooms === 1 ? '' : 's'}.`,
      };
    case 'trains':
    case 'buses':
      return {
        namedTravellers: numbered('Passenger', offer.passengers, null),
        partySize: offer.passengers,
        partyNoun: { one: 'passenger', many: 'passengers' },
        contactPhone: 'not-needed',
        note: 'Names only: the demo doesn’t ask for ages, seats or berth preferences.',
      };
    case 'holidays':
      return {
        namedTravellers: numbered('Traveller', offer.travellers, null),
        partySize: offer.travellers,
        partyNoun: { one: 'traveller', many: 'travellers' },
        contactPhone: 'not-needed',
        note: null,
      };
    case 'cabs':
      return {
        namedTravellers: [{ label: 'Lead passenger', type: null }],
        partySize: offer.passengers,
        partyNoun: { one: 'passenger', many: 'passengers' },
        contactPhone: 'required',
        note: 'The fare is an estimate: a real operator would set the final fare after the ride.',
      };
    case 'metro':
      return {
        namedTravellers: [],
        partySize: offer.passengers,
        partyNoun: { one: 'passenger', many: 'passengers' },
        contactPhone: 'not-needed',
        note: 'Metro tickets carry no names and the demo has no timetable, so this booking has no travel date or train.',
      };
  }
}

/** Local travel dates of an offer, as YYYY-MM-DD; null where it has none. */
export function offerTravelDates(offer: SearchResult): {
  startsOn: string | null;
  endsOn: string | null;
} {
  const day = (offsetDateTime: string) => offsetDateTime.slice(0, 10); // local date of the offset time
  switch (offer.serviceType) {
    case 'flights':
      return {
        startsOn: day(offer.itineraries[0]!.departAt),
        endsOn: day(offer.itineraries[offer.itineraries.length - 1]!.arriveAt),
      };
    case 'hotels':
      return { startsOn: offer.checkIn, endsOn: offer.checkOut };
    case 'trains':
    case 'buses':
      return { startsOn: day(offer.departAt), endsOn: day(offer.arriveAt) };
    case 'cabs':
      return { startsOn: day(offer.pickupAt), endsOn: day(offer.pickupAt) };
    case 'holidays':
      return { startsOn: offer.startDate, endsOn: offer.endDate };
    case 'metro':
      return { startsOn: null, endsOn: null };
  }
}

// ─── Create ──────────────────────────────────────────────────────────────

/** Mobile number in E.164, e.g. +919876543210. Spaces, dashes and brackets are dropped. */
export const phoneE164Schema = z
  .string({ error: 'Enter a mobile number.' })
  .transform((v) => v.replace(/[\s().-]/g, ''))
  .pipe(
    z
      .string()
      .min(1, 'Enter a mobile number.')
      .regex(/^\+[1-9][0-9]{6,14}$/, 'Use the international format, like +91 98765 43210.'),
  );

export const bookingTravellerInputSchema = z
  .object({
    firstName: personName('a first name', 100),
    lastName: personName('a last name', 100),
  })
  .strict();
export type BookingTravellerInput = z.input<typeof bookingTravellerInputSchema>;

/**
 * POST /bookings (with an `Idempotency-Key` header).
 *
 * The client names an offer of a live search and the details the category
 * needs. `acceptedPrice` is the price the visitor saw and accepted: it is NOT
 * used as the price (the server's copy is), only compared with it, so a
 * changed or tampered price is refused instead of booked.
 */
export const createBookingRequestSchema = z
  .object({
    serviceType: searchServiceTypeSchema,
    searchId: z.uuid({ error: 'Not a valid search id.' }),
    offerId: z
      .string({ error: 'Name the offer.' })
      .min(1)
      .max(200)
      .regex(/^[\x21-\x7e]+$/, 'Not a valid offer id.'),
    travellers: z.array(bookingTravellerInputSchema).max(20, 'Too many travellers.'),
    contactPhone: phoneE164Schema.nullable().optional(),
    acceptedPrice: searchPriceSchema.nullable(),
    acceptDemoTerms: z.literal(true, {
      error: 'Confirm that you understand this is a demo booking.',
    }),
  })
  .strict();
export type CreateBookingRequest = z.input<typeof createBookingRequestSchema>;

// ─── Responses ───────────────────────────────────────────────────────────

export const bookingTravellerSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  type: passengerTypeSchema.nullable(),
});
export type BookingTraveller = z.infer<typeof bookingTravellerSchema>;

export const bookingEventSchema = z.object({
  status: bookingStatusSchema,
  at: offsetDateTimeSchema,
  /** `you` for the account holder, `wayora` for the system (the demo confirmation). */
  by: z.enum(['you', 'wayora']),
  note: z.string().nullable(),
});
export type BookingEvent = z.infer<typeof bookingEventSchema>;

const bookingCore = {
  reference: bookingReferenceSchema,
  status: bookingStatusSchema,
  /** Always true today: no supplier reservation, ticket or payment exists. */
  demo: z.boolean(),
  serviceType: searchServiceTypeSchema,
  /** The offer exactly as it was when the booking was made (immutable). */
  offer: searchResultSchema,
  /** The provider's display name at booking time (a demo provider). */
  providerName: z.string(),
  /** The booked price: the offer's server-side price at booking time. */
  price: searchPriceSchema.nullable(),
  partySize: z.number().int().positive(),
  /** Local travel dates where the offer has them; null for metro. */
  startsOn: isoDateSchema.nullable(),
  endsOn: isoDateSchema.nullable(),
  createdAt: offsetDateTimeSchema,
  /** Whether you can cancel it now (status and travel date allow it). */
  cancellable: z.boolean(),
};

/** One booking, as its owner sees it. */
export const bookingSchema = z.object({
  ...bookingCore,
  travellers: z.array(bookingTravellerSchema),
  contactPhone: z.string().nullable(),
  /** How the price was checked when booking: `session` for demo offers (never rechecked). */
  priceCheck: offerValidationSchema.shape.status,
  history: z.array(bookingEventSchema).min(1),
});
export type Booking = z.infer<typeof bookingSchema>;

/** A booking in a list (no names or phone numbers). */
export const bookingSummarySchema = z.object(bookingCore);
export type BookingSummary = z.infer<typeof bookingSummarySchema>;

/**
 * - `upcoming`: active bookings whose travel hasn't ended (and metro, which has no date),
 * - `past`: active bookings whose travel has ended,
 * - `cancelled`: cancelled (and failed) bookings.
 */
export const bookingViewSchema = z.enum(['upcoming', 'past', 'cancelled']);
export type BookingView = z.infer<typeof bookingViewSchema>;

export const bookingListQuerySchema = z
  .object({
    view: bookingViewSchema.default('upcoming'),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict();
export type BookingListQuery = z.input<typeof bookingListQuerySchema>;

export const bookingListResponseSchema = z.object({
  view: bookingViewSchema,
  items: z.array(bookingSummarySchema),
  pagination: paginationSchema,
  /** Totals per view, for tab labels. */
  counts: z.record(bookingViewSchema, z.number().int().min(0)),
});
export type BookingListResponse = z.infer<typeof bookingListResponseSchema>;

export const bookingParamsSchema = z.object({ reference: bookingReferenceSchema });

/** What a demo booking means, shown wherever one is created or displayed. */
export const DEMO_BOOKING_NOTICE =
  'Demo booking: Wayora saved it, but no supplier reservation, ticket or payment was made, and nothing was charged.';
