import {
  utcDateFromToday,
  type BusResult,
  type CabResult,
  type FlightResult,
  type HolidayResult,
  type HotelResult,
  type MetroResult,
  type SearchFacets,
  type SearchResult,
  type TrainResult,
} from '@wayora/contracts';

/*
 * Hand-written results, one shape per category, that satisfy the shared
 * result contract. They stand in for API responses in web tests; the API's
 * real demo data is tested in apps/api.
 */

export const DATE = utcDateFromToday(20);
export const DATE_PLUS_3 = utcDateFromToday(23);

const inr = (rupees: number) => ({ amountMinor: String(rupees * 100), currency: 'INR' });
const total = (rupees: number, per: number, unit: 'adult' | 'night' | 'passenger') => ({
  kind: 'total' as const,
  total: inr(rupees),
  perUnit: { amount: inr(per), unit },
});
const base = (providerId: string, offerRef: string, title: string) => ({
  id: `${providerId}:${offerRef}`,
  providerId,
  source: 'demo' as const,
  title,
  offerRef,
  validUntil: '2030-01-01T10:00:00Z',
});
/** Local IST date-time `minutes` after midnight of `date` (rolls over into the next day). */
const at = (date: string, minutes: number) => {
  const local = new Date(Date.parse(`${date}T00:00:00Z`) + minutes * 60_000);
  return `${local.toISOString().slice(0, 16)}:00+05:30`;
};

const BLR = {
  placeId: 'airport:BLR',
  code: 'BLR',
  name: 'Kempegowda International Airport',
  cityName: 'Bengaluru',
};
const DEL = {
  placeId: 'airport:DEL',
  code: 'DEL',
  name: 'Indira Gandhi International Airport',
  cityName: 'Delhi',
};
const HYD = {
  placeId: 'airport:HYD',
  code: 'HYD',
  name: 'Rajiv Gandhi International Airport',
  cityName: 'Hyderabad',
};

/** A nonstop BLR→DEL flight departing at `departs` (minutes after midnight). */
export function flight(
  number: string,
  departs: number,
  rupees: number,
  { carrier = ['CDA', 'Coral Demo Air'] as [string, string], minutes = 165 } = {},
): FlightResult {
  const leg = {
    departAt: at(DATE, departs),
    arriveAt: at(DATE, departs + minutes),
    durationMinutes: minutes,
  };
  const ref = `${number.replace(' ', '')}@${DATE}/economy`;
  return {
    serviceType: 'flights',
    ...base('demo-flights', ref, `${number} · Nonstop`),
    price: total(rupees, rupees, 'adult'),
    cabinClass: 'economy',
    itineraries: [
      {
        direction: 'outbound',
        stops: 0,
        ...leg,
        segments: [
          {
            carrier: { code: carrier[0], name: carrier[1] },
            flightNumber: number,
            origin: BLR,
            destination: DEL,
            ...leg,
          },
        ],
      },
    ],
  };
}

/** A one-stop BLR→HYD→DEL connection. */
export function connectingFlight(rupees: number): FlightResult {
  const first = {
    departAt: at(DATE, 8 * 60),
    arriveAt: at(DATE, 9 * 60 + 15),
    durationMinutes: 75,
  };
  const second = {
    departAt: at(DATE, 11 * 60),
    arriveAt: at(DATE, 13 * 60 + 15),
    durationMinutes: 135,
  };
  const ref = `KDA431@${DATE}+KDA462@${DATE}/economy`;
  return {
    serviceType: 'flights',
    ...base('demo-flights', ref, 'KDA 431, KDA 462 · 1 stop'),
    price: total(rupees, rupees, 'adult'),
    cabinClass: 'economy',
    itineraries: [
      {
        direction: 'outbound',
        stops: 1,
        departAt: first.departAt,
        arriveAt: second.arriveAt,
        durationMinutes: 315,
        segments: [
          {
            carrier: { code: 'KDA', name: 'Kestrel Demo Airways' },
            flightNumber: 'KDA 431',
            origin: BLR,
            destination: HYD,
            ...first,
          },
          {
            carrier: { code: 'KDA', name: 'Kestrel Demo Airways' },
            flightNumber: 'KDA 462',
            origin: HYD,
            destination: DEL,
            ...second,
          },
        ],
      },
    ],
  };
}

export const hotel: HotelResult = {
  serviceType: 'hotels',
  ...base('demo-hotels', `goa-casa-lagoa/${DATE}/${DATE_PLUS_3}/1`, 'Casa Lagoa (demo), Assagao'),
  price: total(23_400, 7_800, 'night'),
  property: {
    name: 'Casa Lagoa (demo)',
    propertyType: 'boutique',
    area: 'Assagao',
    cityName: 'Goa',
  },
  roomType: 'Garden double room',
  checkIn: DATE,
  checkOut: DATE_PLUS_3,
  nights: 3,
  rooms: 1,
  guests: 2,
  amenities: ['wifi', 'pool', 'breakfast'],
  breakfastIncluded: true,
};

export const train: TrainResult = {
  serviceType: 'trains',
  ...base('demo-trains', `D2601@${DATE}/CC`, 'Cauvery Demo Express (D2601) · CC'),
  price: total(1_190, 1_190, 'passenger'),
  trainNumber: 'D2601',
  trainName: 'Cauvery Demo Express',
  origin: {
    placeId: 'station:SBC',
    code: 'SBC',
    name: 'KSR Bengaluru City Junction',
    cityName: 'Bengaluru',
  },
  destination: {
    placeId: 'station:MAS',
    code: 'MAS',
    name: 'Chennai Central',
    cityName: 'Chennai',
  },
  departAt: at(DATE, 6 * 60),
  arriveAt: at(DATE, 11 * 60),
  durationMinutes: 300,
  travelClass: { code: 'CC', name: 'AC Chair Car' },
  passengers: 1,
};

export const bus: BusResult = {
  serviceType: 'buses',
  ...base('demo-buses', `DDT-01@${DATE}`, 'Deccan Demo Travels · AC sleeper'),
  price: total(1_450, 1_450, 'passenger'),
  operatorName: 'Deccan Demo Travels',
  busType: 'ac-sleeper',
  origin: { placeId: null, code: null, name: 'Majestic bus stand', cityName: 'Bengaluru' },
  destination: { placeId: null, code: null, name: 'Ameerpet', cityName: 'Hyderabad' },
  departAt: at(DATE, 21 * 60 + 30),
  arriveAt: at(DATE, 24 * 60 + 6 * 60),
  durationMinutes: 510,
  passengers: 1,
  amenities: ['Charging point', 'Blanket'],
};

export const metro: MetroResult = {
  serviceType: 'metro',
  ...base('demo-metro', 'blr-whitefield/blr-lalbagh', 'Purple Line → Green Line via Majestic'),
  price: total(60, 60, 'passenger'),
  cityName: 'Bengaluru',
  origin: {
    placeId: 'metro:blr-whitefield',
    code: null,
    name: 'Whitefield (Kadugodi)',
    cityName: 'Bengaluru',
  },
  destination: { placeId: 'metro:blr-lalbagh', code: null, name: 'Lalbagh', cityName: 'Bengaluru' },
  legs: [
    {
      line: { id: 'blr-purple', name: 'Purple Line', colour: '#7e3c98' },
      from: {
        placeId: 'metro:blr-whitefield',
        code: null,
        name: 'Whitefield (Kadugodi)',
        cityName: 'Bengaluru',
      },
      to: { placeId: 'metro:blr-majestic', code: null, name: 'Majestic', cityName: 'Bengaluru' },
      stops: 21,
      durationMinutes: 46,
    },
    {
      line: { id: 'blr-green', name: 'Green Line', colour: '#2e9a48' },
      from: { placeId: 'metro:blr-majestic', code: null, name: 'Majestic', cityName: 'Bengaluru' },
      to: { placeId: 'metro:blr-lalbagh', code: null, name: 'Lalbagh', cityName: 'Bengaluru' },
      stops: 4,
      durationMinutes: 9,
    },
  ],
  transfers: 1,
  durationMinutes: 60,
  passengers: 1,
};

export const cab: CabResult = {
  serviceType: 'cabs',
  ...base(
    'demo-cabs',
    'airport:BLR/locality:blr-koramangala/sedan',
    'Sedan (compact saloon), up to 4 passengers',
  ),
  price: { kind: 'range', min: inr(840), max: inr(1_020) },
  vehicleType: 'sedan',
  vehicleLabel: 'Sedan (compact saloon)',
  capacity: 4,
  pickup: BLR,
  dropoff: {
    placeId: 'locality:blr-koramangala',
    code: null,
    name: 'Koramangala',
    cityName: 'Bengaluru',
  },
  pickupAt: at(utcDateFromToday(5), 9 * 60 + 30),
  distanceKm: 42,
  durationMinutes: 70,
};

export const holiday: HolidayResult = {
  serviceType: 'holidays',
  ...base('demo-holidays', `ker-backwaters-hills/${DATE}`, 'Backwaters and Hills (demo), 5 nights'),
  price: total(130_000, 32_500, 'adult'),
  packageName: 'Backwaters and Hills (demo)',
  destination: { placeId: 'destination:kerala', code: null, name: 'Kerala', cityName: 'Kerala' },
  startDate: DATE,
  endDate: DATE_PLUS_3,
  nights: 5,
  travellers: 4,
  inclusions: ['Hotel stays (4 nights)', 'Houseboat stay (1 night)', 'Daily breakfast'],
  highlights: ['Fort Kochi', 'Munnar tea country'],
  interests: ['nature', 'wellness'],
};

/** Facets as the API would compute them for flight results (carriers, stops, price, duration). */
export function flightFacets(results: readonly FlightResult[]): SearchFacets {
  if (results.length === 0) return { price: null, durationMinutes: null, options: {} };
  const carriers = new Map<string, { label: string; count: number }>();
  const stops = new Map<number, number>();
  for (const r of results) {
    for (const s of new Map(
      r.itineraries.flatMap((i) => i.segments.map((x) => [x.carrier.code, x.carrier.name])),
    )) {
      const entry = carriers.get(s[0]);
      carriers.set(s[0], { label: s[1], count: (entry?.count ?? 0) + 1 });
    }
    const n = Math.max(...r.itineraries.map((i) => i.stops));
    stops.set(n, (stops.get(n) ?? 0) + 1);
  }
  const amounts = results.map((r) =>
    BigInt(r.price!.kind === 'total' ? r.price!.total.amountMinor : '0'),
  );
  const durations = results.map((r) => Math.max(...r.itineraries.map((i) => i.durationMinutes)));
  const min = amounts.reduce((a, b) => (b < a ? b : a));
  const max = amounts.reduce((a, b) => (b > a ? b : a));
  return {
    price: {
      min: { amountMinor: min.toString(), currency: 'INR' },
      max: { amountMinor: max.toString(), currency: 'INR' },
      basis: 'total',
    },
    durationMinutes: { min: Math.min(...durations), max: Math.max(...durations) },
    options: {
      stops: [...stops]
        .sort(([a], [b]) => a - b)
        .map(([n, count]) => ({
          value: String(n),
          label: n === 0 ? 'Nonstop' : `${n} stop`,
          count,
        })),
      carriers: [...carriers].map(([value, { label, count }]) => ({ value, label, count })),
    },
  };
}

export const ALL_CATEGORY_RESULTS: SearchResult[] = [hotel, train, bus, metro, cab, holiday];
