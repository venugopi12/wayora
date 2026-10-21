import type { CabinClass, FlightResult, SearchRequestFor } from '@wayora/contracts';
import { singleCategoryProvider, type ProviderResult } from '../provider.js';
import {
  DEMO_TIMEOUT_MS,
  DEMO_VERSION,
  hm,
  point,
  runsOn,
  scaleRupees,
  totalPrice,
  validUntil,
  zoned,
  type RunsOn,
} from './support.js';

/*
 * Demo flights between Bengaluru, Delhi, Mumbai, Hyderabad and Goa.
 * Airports and approximate block times are real; the CARRIERS ARE FICTIONAL
 * ("Coral Demo Air", "Kestrel Demo Airways") so no fixture can be mistaken for
 * a real airline's schedule or fare.
 */

const CARRIERS = {
  CDA: 'Coral Demo Air',
  KDA: 'Kestrel Demo Airways',
} as const;
type Carrier = keyof typeof CARRIERS;

interface DemoFlight {
  carrier: Carrier;
  number: string;
  from: string;
  to: string;
  /** Local departure time. */
  departs: number;
  minutes: number;
  /** Economy fare per adult, whole rupees. */
  fare: number;
  /** Premium economy and business cabins are offered. */
  premiumCabins: boolean;
  days: RunsOn;
}

type Row = [Carrier, number, string, number, { premium?: boolean; days?: RunsOn }?];

function route(a: string, b: string, minutes: number, out: Row[], back: Row[]): DemoFlight[] {
  const make =
    (from: string, to: string) =>
    ([carrier, num, time, fare, opts = {}]: Row): DemoFlight => ({
      carrier,
      number: `${carrier} ${num}`,
      from: `airport:${from}`,
      to: `airport:${to}`,
      departs: hm(time),
      minutes,
      fare,
      premiumCabins: opts.premium ?? false,
      days: opts.days ?? 'daily',
    });
  return [...out.map(make(a, b)), ...back.map(make(b, a))];
}

const FLIGHTS: readonly DemoFlight[] = [
  ...route(
    'BLR',
    'DEL',
    165,
    [
      ['CDA', 101, '06:10', 5420],
      ['KDA', 401, '09:45', 6180, { premium: true }],
      ['CDA', 105, '18:30', 5890, { premium: true }],
    ],
    [
      ['KDA', 402, '07:05', 5610, { premium: true }],
      ['CDA', 102, '13:20', 5340],
      ['KDA', 406, '20:15', 6420, { days: [0, 5, 6] }],
    ],
  ),
  ...route(
    'BLR',
    'BOM',
    105,
    [
      ['CDA', 121, '07:15', 3890],
      ['KDA', 421, '12:40', 4210, { premium: true }],
      ['CDA', 125, '19:05', 4460],
    ],
    [
      ['CDA', 122, '06:35', 4020],
      ['KDA', 422, '15:10', 3950],
      ['CDA', 126, '21:20', 4380, { premium: true }],
    ],
  ),
  ...route(
    'BLR',
    'HYD',
    75,
    [
      ['KDA', 431, '08:20', 2890],
      ['CDA', 131, '16:45', 3120],
    ],
    [
      ['CDA', 132, '10:05', 2940],
      ['KDA', 432, '19:30', 3260],
    ],
  ),
  ...route(
    'BLR',
    'GOI',
    75,
    [
      ['CDA', 141, '09:10', 3480],
      ['KDA', 441, '14:35', 3720, { days: [1, 3, 5] }],
    ],
    [
      ['CDA', 142, '11:15', 3560],
      ['KDA', 442, '17:00', 3810, { days: [1, 3, 5] }],
    ],
  ),
  ...route(
    'DEL',
    'BOM',
    130,
    [
      ['KDA', 451, '06:00', 4980, { premium: true }],
      ['CDA', 151, '10:30', 5260],
      ['KDA', 455, '17:45', 5590, { premium: true }],
    ],
    [
      ['CDA', 152, '08:10', 5120, { premium: true }],
      ['KDA', 452, '14:00', 4870],
      ['CDA', 156, '21:00', 5340],
    ],
  ),
  ...route('DEL', 'HYD', 135, [['CDA', 161, '07:40', 5180]], [['KDA', 462, '11:30', 5070]]),
  ...route(
    'DEL',
    'GOI',
    150,
    [['KDA', 471, '11:25', 6240, { days: [0, 2, 4, 6] }]],
    [['KDA', 472, '15:20', 6380, { days: [0, 2, 4, 6] }]],
  ),
  ...route('BOM', 'HYD', 85, [['CDA', 171, '09:30', 3340]], [['CDA', 172, '12:30', 3410]]),
  ...route(
    'BOM',
    'GOI',
    70,
    [
      ['CDA', 181, '08:00', 3150],
      ['KDA', 485, '11:40', 3390],
    ],
    [
      ['CDA', 182, '10:05', 3240],
      ['KDA', 486, '20:20', 3460],
    ],
  ),
  ...route(
    'HYD',
    'GOI',
    80,
    [['KDA', 491, '13:10', 3690, { days: [1, 4, 6] }]],
    [['KDA', 492, '15:35', 3770, { days: [1, 4, 6] }]],
  ),
];

const MIN_CONNECTION = 60;
const MAX_CONNECTION = 240;
/** Cabin price multipliers, as numerator / 10. */
const CABIN_FACTOR: Record<CabinClass, number | null> = {
  economy: 10,
  'premium-economy': 16,
  business: 31,
  first: null, // no demo flight sells first class
};
/** Children pay 75% of the adult fare; infants a flat fee. */
const INFANT_FARE = 1_500;

type Option = readonly DemoFlight[];

function offers(cabin: CabinClass, flights: Option): boolean {
  return cabin === 'economy' || flights.every((f) => f.premiumCabins);
}

/** Direct flights and one-stop connections from → to on `date`. */
function options(from: string, to: string, date: string, cabin: CabinClass): Option[] {
  const today = FLIGHTS.filter((f) => runsOn(f.days, date));
  const direct = today.filter((f) => f.from === from && f.to === to).map((f) => [f]);
  const connecting: Option[] = [];
  for (const first of today.filter((f) => f.from === from && f.to !== to)) {
    for (const second of today.filter((f) => f.from === first.to && f.to === to)) {
      const layover = second.departs - (first.departs + first.minutes);
      if (layover >= MIN_CONNECTION && layover <= MAX_CONNECTION) connecting.push([first, second]);
    }
  }
  return [...direct, ...connecting].filter((o) => offers(cabin, o));
}

function itinerary(option: Option, date: string, direction: 'outbound' | 'return') {
  const segments = option.map((f) => ({
    carrier: { code: f.carrier, name: CARRIERS[f.carrier] },
    flightNumber: f.number,
    origin: point(f.from),
    destination: point(f.to),
    departAt: zoned(date, f.departs),
    arriveAt: zoned(date, f.departs + f.minutes),
    durationMinutes: f.minutes,
  }));
  const first = option[0]!;
  const last = option[option.length - 1]!;
  return {
    direction,
    segments,
    stops: option.length - 1,
    departAt: zoned(date, first.departs),
    arriveAt: zoned(date, last.departs + last.minutes),
    durationMinutes: last.departs + last.minutes - first.departs,
  };
}

/** Per-adult fare of one option in the requested cabin (connections are 8% cheaper than the sum). */
function adultFare(option: Option, cabin: CabinClass): bigint {
  const factor = CABIN_FACTOR[cabin] ?? 0;
  const sum = option.reduce((total, f) => total + f.fare, 0);
  return option.length > 1 ? scaleRupees(sum, factor * 92, 1000) : scaleRupees(sum, factor, 10);
}

const key = (option: Option, date: string) =>
  option.map((f) => `${f.number.replace(' ', '')}@${date}`).join('+');

function search(request: SearchRequestFor<'flights'>, now: Date): ProviderResult<'flights'>[] {
  const { origin, destination, departureDate, returnDate, cabinClass, adults, children, infants } =
    request;
  if (CABIN_FACTOR[cabinClass] === null) return [];

  const outbound = options(origin, destination, departureDate, cabinClass);
  const inbound = returnDate ? options(destination, origin, returnDate, cabinClass) : [null];
  const results: ProviderResult<'flights'>[] = [];

  for (const out of outbound) {
    for (const back of inbound) {
      if (back && returnDate === departureDate) {
        // Same-day return: leave at least two hours after landing.
        const lands = out[out.length - 1]!;
        if (back[0]!.departs < lands.departs + lands.minutes + 120) continue;
      }
      const perAdult = adultFare(out, cabinClass) + (back ? adultFare(back, cabinClass) : 0n);
      const perChild = scaleRupees(Number(perAdult), 3, 4);
      const total =
        perAdult * BigInt(adults) +
        perChild * BigInt(children) +
        BigInt(INFANT_FARE) * BigInt(infants) * (back ? 2n : 1n);
      const itineraries: FlightResult['itineraries'] = [itinerary(out, departureDate, 'outbound')];
      if (back && returnDate) itineraries.push(itinerary(back, returnDate, 'return'));

      const offerRef = `${key(out, departureDate)}${back && returnDate ? `/${key(back, returnDate)}` : ''}/${cabinClass}`;
      const stops = out.length - 1;
      results.push({
        serviceType: 'flights',
        id: `demo-flights:${offerRef}`,
        providerId: 'demo-flights',
        source: 'demo',
        title: `${out.map((f) => f.number).join(', ')}${back ? ` · return ${back.map((f) => f.number).join(', ')}` : ''} · ${stops === 0 ? 'Nonstop' : `${stops} stop`}`,
        price: totalPrice(total, { rupees: perAdult, unit: 'adult' }),
        offerRef,
        validUntil: validUntil(now),
        cabinClass,
        itineraries,
        dedupeKey: offerRef,
      });
    }
  }
  return results;
}

export const demoFlightsProvider = singleCategoryProvider({
  id: 'demo-flights',
  name: 'Wayora demo flights',
  kind: 'demo',
  version: DEMO_VERSION,
  serviceType: 'flights',
  timeoutMs: DEMO_TIMEOUT_MS,
  search: (request, { now }) => search(request, now),
});
