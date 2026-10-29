import { describe, expect, it } from 'vitest';
import {
  bookingDocumentsSchema,
  bookingRefundSchema,
  bookingReservationSchema,
  reservationStateSchema,
  BOOKING_REFERENCE_ALPHABET,
  bookingListQuerySchema,
  bookingReferenceSchema,
  bookingRequirementsFor,
  cabResultSchema,
  createBookingRequestSchema,
  phoneE164Schema,
  type SearchResult,
} from '../src/index.js';

const base = {
  id: 'p:r',
  providerId: 'p',
  source: 'demo',
  title: 'x',
  price: null,
  offerRef: 'r',
  validUntil: '2026-11-10T10:00:00+05:30',
} as const;
const point = { placeId: null, code: null, name: 'A', cityName: 'A' };
const leg = {
  departAt: '2026-11-10T06:00:00+05:30',
  arriveAt: '2026-11-10T08:00:00+05:30',
  durationMinutes: 120,
};

const offers = {
  flights: {
    ...base,
    serviceType: 'flights',
    cabinClass: 'economy',
    itineraries: [
      {
        direction: 'outbound',
        stops: 0,
        ...leg,
        segments: [
          {
            carrier: { code: 'CDA', name: 'Coral' },
            flightNumber: 'CDA 1',
            origin: point,
            destination: point,
            ...leg,
          },
        ],
      },
    ],
    passengers: { adults: 2, children: 1, infants: 1 },
  },
  hotels: {
    ...base,
    serviceType: 'hotels',
    property: { name: 'H', propertyType: 'hotel', area: null, cityName: 'Goa' },
    roomType: 'Double',
    checkIn: '2026-11-10',
    checkOut: '2026-11-12',
    nights: 2,
    rooms: 2,
    guests: 3,
    amenities: [],
    breakfastIncluded: false,
  },
  trains: {
    ...base,
    serviceType: 'trains',
    trainNumber: 'D1',
    trainName: 'Demo',
    origin: point,
    destination: point,
    ...leg,
    travelClass: { code: '3A', name: 'AC 3 tier' },
    passengers: 1,
  },
  metro: {
    ...base,
    serviceType: 'metro',
    cityName: 'Bengaluru',
    origin: point,
    destination: point,
    legs: [
      {
        line: { id: 'l', name: 'Purple', colour: '#663399' },
        from: point,
        to: point,
        stops: 3,
        durationMinutes: 9,
      },
    ],
    transfers: 0,
    durationMinutes: 9,
    passengers: 3,
  },
  cabs: {
    ...base,
    serviceType: 'cabs',
    vehicleType: 'sedan',
    vehicleLabel: 'Sedan',
    capacity: 4,
    pickup: point,
    dropoff: point,
    pickupAt: '2026-11-10T09:30:00+05:30',
    distanceKm: 12,
    durationMinutes: 30,
    passengers: 2,
  },
  holidays: {
    ...base,
    serviceType: 'holidays',
    packageName: 'P',
    destination: point,
    startDate: '2026-11-10',
    endDate: '2026-11-14',
    nights: 4,
    travellers: 2,
    inclusions: [],
    highlights: [],
    interests: [],
  },
} as unknown as Record<string, SearchResult>;

describe('booking requirements per category (from the offer contract only)', () => {
  it('flights: a name for every passenger, by type', () => {
    const r = bookingRequirementsFor(offers.flights!);
    expect(r.namedTravellers).toEqual([
      { label: 'Adult 1', type: 'adult' },
      { label: 'Adult 2', type: 'adult' },
      { label: 'Child', type: 'child' },
      { label: 'Infant', type: 'infant' },
    ]);
    expect(r.partySize).toBe(4);
    expect(r.contactPhone).toBe('not-needed');
  });

  it('hotels: one lead guest for the whole party; trains: every passenger', () => {
    const hotel = bookingRequirementsFor(offers.hotels!);
    expect(hotel.namedTravellers).toEqual([{ label: 'Lead guest', type: null }]);
    expect(hotel.partySize).toBe(3);
    expect(hotel.note).toMatch(/3 guests in 2 rooms/);
    expect(bookingRequirementsFor(offers.trains!).namedTravellers).toEqual([
      { label: 'Passenger', type: null },
    ]);
  });

  it('cabs: lead passenger and a phone; metro: no names; holidays: every traveller', () => {
    const cab = bookingRequirementsFor(offers.cabs!);
    expect(cab.namedTravellers).toHaveLength(1);
    expect(cab.contactPhone).toBe('required');
    expect(cab.partySize).toBe(2);
    const metro = bookingRequirementsFor(offers.metro!);
    expect(metro.namedTravellers).toEqual([]);
    expect(metro.partySize).toBe(3);
    expect(metro.note).toMatch(/no travel date/);
    expect(bookingRequirementsFor(offers.holidays!).namedTravellers.map((s) => s.label)).toEqual([
      'Traveller 1',
      'Traveller 2',
    ]);
  });

  it('a cab offer cannot carry more passengers than seats', () => {
    expect(cabResultSchema.safeParse(offers.cabs).success).toBe(true);
    expect(cabResultSchema.safeParse({ ...offers.cabs, passengers: 5 }).success).toBe(false);
  });
});

describe('create booking request', () => {
  const valid = {
    serviceType: 'hotels',
    searchId: '01890000-0000-7000-8000-000000000001',
    offerId: 'demo-hotels:goa/1',
    travellers: [{ firstName: '  Asha ', lastName: 'Rao  Menon' }],
    acceptedPrice: { kind: 'total', total: { amountMinor: '100', currency: 'INR' }, perUnit: null },
    acceptDemoTerms: true,
  };

  it('normalizes names and phone numbers conservatively', () => {
    const parsed = createBookingRequestSchema.parse({ ...valid, contactPhone: '+91 98765-43210' });
    expect(parsed.travellers).toEqual([{ firstName: 'Asha', lastName: 'Rao Menon' }]);
    expect(parsed.contactPhone).toBe('+919876543210');
    expect(phoneE164Schema.safeParse('98765 43210').success).toBe(false); // needs the country code
  });

  it('takes the demo or the supplier terms (the server checks which applies), and rejects unknown fields (no client totals, user ids or types)', () => {
    expect(createBookingRequestSchema.safeParse({ ...valid, acceptDemoTerms: false }).success).toBe(
      false,
    );
    const { acceptDemoTerms: _a, ...noTerms } = valid;
    expect(createBookingRequestSchema.safeParse(noTerms).success).toBe(true);
    expect(
      createBookingRequestSchema.safeParse({ ...noTerms, acceptSupplierTerms: true }).success,
    ).toBe(true);
    expect(
      createBookingRequestSchema.safeParse({ ...noTerms, acceptSupplierTerms: false }).success,
    ).toBe(false);
    // Never a client-sent supplier status, reference or refund.
    for (const extra of [
      { reservationStatus: 'confirmed' },
      { supplierReference: 'ABC' },
      { refund: { state: 'succeeded' } },
    ]) {
      expect(createBookingRequestSchema.safeParse({ ...valid, ...extra }).success).toBe(false);
    }
    for (const extra of [{ total: '1' }, { userId: 'x' }, { price: {} }, { status: 'confirmed' }]) {
      expect(createBookingRequestSchema.safeParse({ ...valid, ...extra }).success).toBe(false);
    }
    expect(
      createBookingRequestSchema.safeParse({
        ...valid,
        travellers: [{ firstName: 'A', lastName: 'B', type: 'infant' }],
      }).success,
    ).toBe(false);
    expect(
      createBookingRequestSchema.safeParse({
        ...valid,
        travellers: [{ firstName: 'A1', lastName: 'B' }],
      }).success,
    ).toBe(false);
  });
});

describe('references and list queries', () => {
  it('accepts WYD- (demo) and WY- (supplier, Phase 23) references from the unambiguous alphabet, case-insensitively', () => {
    expect(bookingReferenceSchema.parse(' wyd-7kq2-m9xd ')).toBe('WYD-7KQ2-M9XD');
    expect(bookingReferenceSchema.parse('wy-7kq2-m9xd')).toBe('WY-7KQ2-M9XD');
    for (const bad of [
      'WYS-7KQ2-M9XD',
      'WYD-7KQ2-M9X',
      'WYD-0KQ2-M9XD',
      'WYD-IKQ2-M9XD',
      'PNR-7KQ2-M9XD',
      'x',
    ]) {
      expect(bookingReferenceSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(BOOKING_REFERENCE_ALPHABET).not.toMatch(/[01IOL]/);
  });

  it('pages lists with sane bounds', () => {
    expect(bookingListQuerySchema.parse({})).toEqual({ view: 'upcoming', page: 1, pageSize: 10 });
    expect(bookingListQuerySchema.safeParse({ pageSize: '51' }).success).toBe(false);
    expect(bookingListQuerySchema.safeParse({ view: 'all' }).success).toBe(false);
  });
});

describe('supplier side of a booking (Phase 23)', () => {
  it('reservation, documents, cancellation and refund states are closed sets', () => {
    expect(reservationStateSchema.options).toEqual([
      'requested',
      'in-progress',
      'confirmed',
      'failed',
      'unknown',
      'cancellation-pending',
      'cancelled',
    ]);
    expect(
      bookingReservationSchema.safeParse({
        kind: 'demo',
        state: null,
        supplierReference: null,
        confirmedAt: null,
        priceMismatch: false,
        needsAttention: false,
        explanation: 'Demo booking: no supplier reservation was made.',
      }).success,
    ).toBe(true);
    expect(
      bookingDocumentsSchema.safeParse({
        state: 'issued',
        items: [
          { type: 'pnr', reference: 'X', travellerName: null, issuedAt: '2026-11-01T10:00:00Z' },
        ],
        explanation: '',
      }).success,
    ).toBe(false);
    expect(
      bookingRefundSchema.safeParse({
        state: 'refunded-maybe',
        amount: null,
        demo: true,
        explanation: '',
      }).success,
    ).toBe(false);
    expect(
      bookingRefundSchema.safeParse({
        state: 'pending',
        amount: { amountMinor: '12.5', currency: 'INR' },
        demo: false,
        explanation: '',
      }).success,
    ).toBe(false);
  });
});
