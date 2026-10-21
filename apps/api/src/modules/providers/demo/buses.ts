import { findPlace, type BusType, type SearchRequestFor } from '@wayora/contracts';
import { singleCategoryProvider, type ProviderResult } from '../provider.js';
import {
  DEMO_TIMEOUT_MS,
  DEMO_VERSION,
  hm,
  namedPoint,
  runsOn,
  totalPrice,
  validUntil,
  zoned,
  type RunsOn,
} from './support.js';

/*
 * Demo intercity buses between Bengaluru, Hyderabad, Chennai and Pune.
 * OPERATORS ARE FICTIONAL. Boarding and drop-off points are real
 * neighbourhoods. Seat maps and seat availability are not modelled.
 */

const BUS_TYPE_NAMES: Record<BusType, string> = {
  'ac-sleeper': 'AC sleeper',
  'ac-seater': 'AC seater',
  'non-ac-sleeper': 'Non-AC sleeper',
  'non-ac-seater': 'Non-AC seater',
};

interface DemoBus {
  ref: string;
  operator: string;
  busType: BusType;
  from: string;
  to: string;
  boarding: string;
  dropping: string;
  departs: number;
  minutes: number;
  fare: number;
  amenities: readonly string[];
  days: RunsOn;
}

const DECCAN = 'Deccan Demo Travels';
const COASTAL = 'Coastal Demo Lines';
const KONKAN = 'Konkan Demo Coaches';

const bus = (
  ref: string,
  operator: string,
  busType: BusType,
  [from, boarding]: [string, string],
  [to, dropping]: [string, string],
  departs: string,
  minutes: number,
  fare: number,
  amenities: readonly string[] = [],
  days: RunsOn = 'daily',
): DemoBus => ({
  ref,
  operator,
  busType,
  from: `city:${from}`,
  to: `city:${to}`,
  boarding,
  dropping,
  departs: hm(departs),
  minutes,
  fare,
  amenities,
  days,
});

const COMFORT = ['Charging point', 'Blanket', 'Water bottle'];

const BUSES: readonly DemoBus[] = [
  bus(
    'ddt-blr-hyd-2130',
    DECCAN,
    'ac-sleeper',
    ['bengaluru', 'Madiwala'],
    ['hyderabad', 'Lakdikapul'],
    '21:30',
    630,
    1_450,
    COMFORT,
  ),
  bus(
    'cdl-blr-hyd-2215',
    COASTAL,
    'non-ac-sleeper',
    ['bengaluru', 'Majestic'],
    ['hyderabad', 'Ameerpet'],
    '22:15',
    660,
    980,
  ),
  bus(
    'ddt-blr-hyd-0900',
    DECCAN,
    'ac-seater',
    ['bengaluru', 'Hebbal'],
    ['hyderabad', 'Miyapur'],
    '09:00',
    600,
    1_120,
    ['Charging point'],
    [5, 6, 0],
  ),
  bus(
    'ddt-hyd-blr-2045',
    DECCAN,
    'ac-sleeper',
    ['hyderabad', 'Lakdikapul'],
    ['bengaluru', 'Madiwala'],
    '20:45',
    640,
    1_450,
    COMFORT,
  ),
  bus(
    'cdl-hyd-blr-2200',
    COASTAL,
    'non-ac-sleeper',
    ['hyderabad', 'Ameerpet'],
    ['bengaluru', 'Majestic'],
    '22:00',
    670,
    980,
  ),
  bus(
    'cdl-blr-chn-0630',
    COASTAL,
    'ac-seater',
    ['bengaluru', 'Majestic'],
    ['chennai', 'Koyambedu'],
    '06:30',
    360,
    690,
    ['Charging point'],
  ),
  bus(
    'cdl-blr-chn-2300',
    COASTAL,
    'ac-sleeper',
    ['bengaluru', 'Silk Board'],
    ['chennai', 'Guindy'],
    '23:00',
    375,
    950,
    COMFORT,
  ),
  bus(
    'ddt-blr-chn-1400',
    DECCAN,
    'non-ac-seater',
    ['bengaluru', 'Majestic'],
    ['chennai', 'Koyambedu'],
    '14:00',
    390,
    480,
  ),
  bus(
    'cdl-chn-blr-0700',
    COASTAL,
    'ac-seater',
    ['chennai', 'Koyambedu'],
    ['bengaluru', 'Majestic'],
    '07:00',
    360,
    690,
    ['Charging point'],
  ),
  bus(
    'cdl-chn-blr-2245',
    COASTAL,
    'ac-sleeper',
    ['chennai', 'Guindy'],
    ['bengaluru', 'Silk Board'],
    '22:45',
    380,
    950,
    COMFORT,
  ),
  bus(
    'kdc-blr-pnq-1600',
    KONKAN,
    'ac-sleeper',
    ['bengaluru', 'Yeshwanthpur'],
    ['pune', 'Swargate'],
    '16:00',
    840,
    1_890,
    COMFORT,
  ),
  bus(
    'kdc-pnq-blr-1530',
    KONKAN,
    'ac-sleeper',
    ['pune', 'Wakad'],
    ['bengaluru', 'Yeshwanthpur'],
    '15:30',
    850,
    1_890,
    COMFORT,
  ),
  bus(
    'kdc-hyd-pnq-2000',
    KONKAN,
    'ac-sleeper',
    ['hyderabad', 'Miyapur'],
    ['pune', 'Wakad'],
    '20:00',
    600,
    1_350,
    COMFORT,
  ),
  bus(
    'kdc-pnq-hyd-2100',
    KONKAN,
    'ac-sleeper',
    ['pune', 'Swargate'],
    ['hyderabad', 'Miyapur'],
    '21:00',
    610,
    1_350,
    COMFORT,
  ),
  bus(
    'ddt-hyd-chn-1930',
    DECCAN,
    'ac-sleeper',
    ['hyderabad', 'Lakdikapul'],
    ['chennai', 'Koyambedu'],
    '19:30',
    690,
    1_390,
    COMFORT,
  ),
  bus(
    'ddt-chn-hyd-1900',
    DECCAN,
    'ac-sleeper',
    ['chennai', 'Koyambedu'],
    ['hyderabad', 'Lakdikapul'],
    '19:00',
    700,
    1_390,
    COMFORT,
  ),
];

function search(request: SearchRequestFor<'buses'>, now: Date): ProviderResult<'buses'>[] {
  const { origin, destination, departureDate: date, adults, children } = request;
  const passengers = adults + children;
  const city = (placeId: string) => findPlace(placeId)!.cityName;
  return BUSES.filter((b) => b.from === origin && b.to === destination && runsOn(b.days, date)).map(
    (b) => {
      const offerRef = `${b.ref}/${date}`;
      return {
        serviceType: 'buses',
        id: `demo-buses:${offerRef}`,
        providerId: 'demo-buses',
        source: 'demo',
        title: `${b.operator} · ${BUS_TYPE_NAMES[b.busType]}`,
        price: totalPrice(BigInt(b.fare) * BigInt(passengers), {
          rupees: BigInt(b.fare),
          unit: 'passenger',
        }),
        offerRef,
        validUntil: validUntil(now),
        operatorName: b.operator,
        busType: b.busType,
        origin: namedPoint(b.boarding, city(b.from)),
        destination: namedPoint(b.dropping, city(b.to)),
        departAt: zoned(date, b.departs),
        arriveAt: zoned(date, b.departs + b.minutes),
        durationMinutes: b.minutes,
        passengers,
        amenities: [...b.amenities],
      };
    },
  );
}

export const demoBusesProvider = singleCategoryProvider({
  id: 'demo-buses',
  name: 'Wayora demo buses',
  kind: 'demo',
  version: DEMO_VERSION,
  serviceType: 'buses',
  timeoutMs: DEMO_TIMEOUT_MS,
  search: (request, { now }) => search(request, now),
});
