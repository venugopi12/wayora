import { z } from 'zod';
import { personName } from './auth.js';
import { moneySchema } from './money.js';
import {
  isoDateSchema,
  offsetDateTimeSchema,
  paginationSchema,
  searchPriceSchema,
  searchServiceTypeSchema,
} from './search/common.js';
import {
  hotelCancellationPolicySchema,
  offerValidationSchema,
  searchResultSchema,
  type SearchResult,
} from './search/results.js';

/*
 * Bookings (Phase 12, docs/bookings.md; supplier reservations since Phase 23).
 *
 * A booking is created from an offer of a live search session.
 * - A DEMO booking (`demo: true`, reference `WYD-…`, "Wayora demo"): Wayora
 *   stores it and simulates its confirmation; no supplier reservation,
 *   ticket or payment exists.
 * - A SUPPLIER booking (`demo: false`, reference `WY-…`): Wayora asks a
 *   configured supplier to reserve it, and it is confirmed only when the
 *   supplier confirms. No real supplier implements reservations yet
 *   (docs/providers.md), so every booking made today is a demo booking.
 *
 * Wayora references are Wayora's own, never supplier identifiers; a
 * supplier's reference appears only in `reservation.supplierReference`.
 */

/** `WYD-` (demo) or `WY-` (supplier booking) + two groups of four characters from an alphabet without look-alikes (no 0/O, 1/I/L). */
export const BOOKING_REFERENCE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const bookingReferenceSchema = z
  .string({ error: 'Name the booking.' })
  .trim()
  .toUpperCase()
  .regex(
    /^WYD?-[23456789A-HJKMNP-Z]{4}-[23456789A-HJKMNP-Z]{4}$/,
    'Not a valid booking reference.',
  );

/**
 * Lifecycle (server-enforced; docs/bookings.md#statuses, docs/payments.md):
 *   pending ──(demo confirmation, simulated)──▶ confirmed
 *     • payment mode `none`: straight away
 *     • payment mode `demo`: after a demo payment succeeds
 *   pending ──(payment window passed, nothing paid)──▶ expired
 *   pending ──▶ failed            pending | confirmed ──(you, before travel)──▶ cancelled
 * `cancelled`, `expired` and `failed` are final. `confirmed` is always a demo
 * confirmation: no supplier has reserved anything.
 */
export const bookingStatusSchema = z.enum([
  'pending',
  'confirmed',
  'cancelled',
  'expired',
  'failed',
]);
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
    /** Required for a demo offer (the server checks which kind it is). */
    acceptDemoTerms: z
      .literal(true, { error: 'Confirm that you understand this is a demo booking.' })
      .optional(),
    /**
     * Required for a supplier offer: the reservation is requested from the
     * supplier, confirmed only when it confirms, and paid to the supplier
     * under its terms (Wayora takes no payment).
     */
    acceptSupplierTerms: z
      .literal(true, { error: 'Confirm that you understand how this supplier booking works.' })
      .optional(),
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
  /**
   * `you` for the account holder, `wayora` for Wayora (the demo confirmation,
   * or staff), `supplier` for a supplier's answer (Phase 23).
   */
  by: z.enum(['you', 'wayora', 'supplier']),
  note: z.string().nullable(),
});
export type BookingEvent = z.infer<typeof bookingEventSchema>;

// ─── Payment side of a booking (Phase 13) ────────────────────────────────

/**
 * How a booking is paid (fixed when it is made):
 * - `none`: nothing is paid on Wayora. Phase 12 bookings, bookings made while
 *   payments are off, and estimate-priced offers (cab fares are ranges, so
 *   there is no exact amount to take).
 * - `demo`: a simulated payment is required before the demo confirmation.
 *   No money moves; see DEMO_PAYMENT_NOTICE.
 */
export const bookingPaymentModeSchema = z.enum(['none', 'demo']);
export type BookingPaymentMode = z.infer<typeof bookingPaymentModeSchema>;

/**
 * Outcomes the demo payment simulator can be asked for (only when the server
 * enables demo scenarios; never with a real provider). The server's simulator
 * decides the result; the client never sends a payment status.
 * - `succeed`: approved at once
 * - `decline`: declined at once
 * - `pending`: pending, then approved a few seconds later
 * - `pending-decline`: pending, then declined
 */
export const DEMO_PAYMENT_SCENARIOS = ['succeed', 'decline', 'pending', 'pending-decline'] as const;
export const demoPaymentScenarioSchema = z.enum(DEMO_PAYMENT_SCENARIOS);
export type DemoPaymentScenario = z.infer<typeof demoPaymentScenarioSchema>;

/**
 * The money side of a booking, for display and for deciding whether "Pay" is offered:
 * - `not-required`: payment mode `none`
 * - `unpaid`: payable now (a new attempt can start)
 * - `processing`: an attempt is created or pending
 * - `paid`: an attempt succeeded and the booking was confirmed
 * - `refund-required`: an attempt succeeded after the booking was cancelled or
 *   expired; the booking stays cancelled (see docs/payments.md#late-success)
 * - `closed`: unpaid, and the booking can no longer be paid (cancelled, expired)
 */
export const bookingPaymentStateSchema = z.enum([
  'not-required',
  'unpaid',
  'processing',
  'paid',
  'refund-required',
  'closed',
]);
export type BookingPaymentState = z.infer<typeof bookingPaymentStateSchema>;

export const bookingPaymentSchema = z.object({
  mode: bookingPaymentModeSchema,
  state: bookingPaymentStateSchema,
  /**
   * What is due, from the booking's own record (null when nothing is paid on
   * Wayora): the total less any rewards applied at checkout (Phase 25).
   */
  amount: moneySchema.nullable(),
  /** Points and travel credit set against the total (Phase 25), or null. */
  rewards: z.object({ points: z.number().int(), amount: moneySchema }).nullable().optional(),
  /** Pay before this or the booking expires (null when nothing is due). */
  dueAt: offsetDateTimeSchema.nullable(),
  /** Whether a new payment attempt can be started now. */
  canPay: z.boolean(),
  /** The attempt in progress (created or pending), to resume watching it. */
  activePaymentId: z.uuid().nullable(),
  /** Demo scenarios this server accepts, or null (scenarios off, or not a demo payment). */
  demoScenarios: z.array(demoPaymentScenarioSchema).nullable(),
});
export type BookingPayment = z.infer<typeof bookingPaymentSchema>;

// ─── Supplier side of a booking (Phase 23) ───────────────────────────────

/**
 * The supplier reservation of a supplier booking
 * (docs/bookings.md#supplier-reservations):
 * - `requested`: recorded by Wayora, not sent yet
 * - `in-progress`: sent, or accepted by the supplier and not confirmed yet
 * - `confirmed`: the supplier confirmed it (with its reference)
 * - `failed`: the supplier did not reserve it
 * - `unknown`: sent, but no definitive answer; Wayora is checking, and never
 *   sends a second reservation until it knows
 * - `cancellation-pending`: cancellation asked of the supplier, not confirmed yet
 * - `cancelled`: the supplier confirmed the cancellation
 */
export const reservationStateSchema = z.enum([
  'requested',
  'in-progress',
  'confirmed',
  'failed',
  'unknown',
  'cancellation-pending',
  'cancelled',
]);
export type ReservationState = z.infer<typeof reservationStateSchema>;

export const bookingReservationSchema = z.object({
  /** `demo`: no supplier reservation exists (state is null). */
  kind: z.enum(['demo', 'supplier']),
  state: reservationStateSchema.nullable(),
  /** The supplier's confirmation reference, only once the supplier gave it. */
  supplierReference: z.string().nullable(),
  confirmedAt: offsetDateTimeSchema.nullable(),
  /** The supplier confirmed a price different from the booked one (staff follow up). */
  priceMismatch: z.boolean(),
  /** Automatic checks stopped; Wayora staff are confirming with the supplier. */
  needsAttention: z.boolean(),
  /** Wayora's own explanation of where it stands (never supplier text). */
  explanation: z.string(),
});
export type BookingReservation = z.infer<typeof bookingReservationSchema>;

export const travelDocumentTypeSchema = z.enum(['ticket', 'voucher', 'itinerary']);
export type TravelDocumentType = z.infer<typeof travelDocumentTypeSchema>;

/** Tickets and vouchers: only references a supplier actually issued, never generated ones. */
export const bookingDocumentsSchema = z.object({
  /** `not-applicable` for demo bookings (nothing is ever issued). */
  state: z.enum(['not-applicable', 'none-issued', 'issued']),
  items: z.array(
    z.object({
      type: travelDocumentTypeSchema,
      reference: z.string(),
      /** The booked traveller it is for, when the supplier says. */
      travellerName: z.string().nullable(),
      issuedAt: offsetDateTimeSchema,
    }),
  ),
  explanation: z.string(),
});
export type BookingDocuments = z.infer<typeof bookingDocumentsSchema>;

export const bookingCancellationSchema = z.object({
  /** Same as `cancellable`: whether you can ask to cancel now. */
  available: z.boolean(),
  state: z.enum(['not-requested', 'pending', 'cancelled']),
  /** Why it can or can't be cancelled, and what happens if it is. */
  explanation: z.string(),
  /** The supplier's cancellation terms from the booked offer, if it sent any. */
  policy: hotelCancellationPolicySchema.nullable(),
});
export type BookingCancellation = z.infer<typeof bookingCancellationSchema>;

/**
 * A refund of the booking's payment (docs/payments.md#refunds), tracked
 * apart from the booking and the payment:
 * - `not-applicable`: nothing was paid on Wayora
 * - `required`: owed, but the payment's provider can't refund (demo: no money was taken)
 * - `requested` / `pending`: asked of the provider / the provider is processing it
 * - `succeeded`: the provider confirmed it
 * - `failed`: the provider refused it
 * - `unknown`: asked, no definitive answer yet (Wayora checks again)
 */
export const refundStateSchema = z.enum([
  'not-applicable',
  'required',
  'requested',
  'pending',
  'succeeded',
  'failed',
  'unknown',
]);
export type RefundState = z.infer<typeof refundStateSchema>;

export const bookingRefundSchema = z.object({
  state: refundStateSchema,
  /** The original payment's amount and currency (never another figure). */
  amount: moneySchema.nullable(),
  /** A demo payment: no real money was ever involved. */
  demo: z.boolean(),
  explanation: z.string(),
});
export type BookingRefund = z.infer<typeof bookingRefundSchema>;

const bookingCore = {
  reference: bookingReferenceSchema,
  status: bookingStatusSchema,
  /** A demo booking: no supplier reservation, ticket or payment exists. */
  demo: z.boolean(),
  serviceType: searchServiceTypeSchema,
  /** The offer exactly as it was when the booking was made (immutable). */
  offer: searchResultSchema,
  /** The provider's display name at booking time. */
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
  /** How it is paid, and where that stands (Phase 13). */
  payment: bookingPaymentSchema,
  /** The supplier side (Phase 23): `kind: 'demo'` for demo bookings. */
  reservation: bookingReservationSchema,
};

/** One booking, as its owner sees it. */
export const bookingSchema = z.object({
  ...bookingCore,
  travellers: z.array(bookingTravellerSchema),
  contactPhone: z.string().nullable(),
  /** How the price was checked when booking: `session` for demo offers (never rechecked). */
  priceCheck: offerValidationSchema.shape.status,
  history: z.array(bookingEventSchema).min(1),
  documents: bookingDocumentsSchema,
  cancellation: bookingCancellationSchema,
  refund: bookingRefundSchema,
});
export type Booking = z.infer<typeof bookingSchema>;

/** A booking in a list (no names or phone numbers). */
export const bookingSummarySchema = z.object(bookingCore);
export type BookingSummary = z.infer<typeof bookingSummarySchema>;

/**
 * - `upcoming`: active bookings (confirmed, or pending payment) whose travel
 *   hasn't ended (and metro, which has no date),
 * - `past`: active bookings whose travel has ended,
 * - `cancelled`: cancelled, expired (never paid) and failed bookings.
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

/** What a supplier booking means before it is made (checkout terms). */
export const SUPPLIER_BOOKING_NOTICE =
  'Wayora sends this reservation request to the supplier. It is confirmed only when the supplier confirms it. Wayora takes no payment: you pay the supplier under its own terms.';

/** What a demo booking means, shown wherever one is created or displayed. */
export const DEMO_BOOKING_NOTICE =
  'Demo booking: Wayora saved it, but no supplier reservation, ticket or payment was made, and nothing was charged.';
