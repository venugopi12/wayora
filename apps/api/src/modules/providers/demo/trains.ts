import { TRAIN_CLASS_NAMES, type SearchRequestFor, type TrainClass } from '@wayora/contracts';
import { singleCategoryProvider, type ProviderResult } from '../provider.js';
import {
  DEMO_TIMEOUT_MS,
  DEMO_VERSION,
  hm,
  point,
  runsOn,
  totalPrice,
  validUntil,
  zoned,
  type RunsOn,
} from './support.js';

/*
 * Demo trains between major Indian cities. Stations and station codes are
 * real; the TRAINS ARE FICTIONAL ("D"-prefixed numbers, "Demo" in every
 * name) so none can be confused with an Indian Railways service. Seat
 * availability is never shown: the demo data doesn't know it.
 */

interface DemoTrain {
  number: string;
  name: string;
  from: string;
  to: string;
  departs: number;
  minutes: number;
  /** Fare per passenger, whole rupees, for each class this train has. */
  fares: Partial<Record<TrainClass, number>>;
  days: RunsOn;
}

const train = (
  number: string,
  name: string,
  from: string,
  to: string,
  departs: string,
  minutes: number,
  fares: DemoTrain['fares'],
  days: RunsOn = 'daily',
): DemoTrain => ({
  number,
  name,
  from: `station:${from}`,
  to: `station:${to}`,
  departs: hm(departs),
  minutes,
  fares,
  days,
});

const SLEEPER = (sl: number, a3: number, a2: number, a1?: number) => ({
  SL: sl,
  '3A': a3,
  '2A': a2,
  ...(a1 ? { '1A': a1 } : {}),
});

const TRAINS: readonly DemoTrain[] = [
  train('D2601', 'Cauvery Demo Express', 'SBC', 'MAS', '06:00', 345, { CC: 1_050, EC: 2_010 }),
  train('D2605', 'Lalbagh Demo Intercity', 'SBC', 'MAS', '13:30', 330, { CC: 780 }),
  train('D2603', 'Bay Demo Mail', 'SBC', 'MAS', '22:40', 380, SLEEPER(320, 840, 1_190, 1_990)),
  train('D2602', 'Cauvery Demo Express', 'MAS', 'SBC', '06:05', 345, { CC: 1_050, EC: 2_010 }),
  train('D2606', 'Lalbagh Demo Intercity', 'MAS', 'SBC', '15:30', 330, { CC: 780 }),
  train('D2604', 'Bay Demo Mail', 'MAS', 'SBC', '23:00', 375, SLEEPER(320, 840, 1_190, 1_990)),
  train('D1201', 'Capital Demo Rajdhani', 'NDLS', 'CSMT', '16:55', 950, {
    '3A': 3_290,
    '2A': 4_560,
    '1A': 5_650,
  }),
  train(
    'D1203',
    'Western Demo Express',
    'NDLS',
    'CSMT',
    '21:30',
    1_210,
    SLEEPER(735, 1_940, 2_790),
    [1, 3, 5, 0],
  ),
  train('D1202', 'Capital Demo Rajdhani', 'CSMT', 'NDLS', '17:05', 955, {
    '3A': 3_290,
    '2A': 4_560,
    '1A': 5_650,
  }),
  train(
    'D1204',
    'Western Demo Express',
    'CSMT',
    'NDLS',
    '11:20',
    1_220,
    SLEEPER(735, 1_940, 2_790),
    [2, 4, 6, 0],
  ),
  train('D1701', 'Deccan Demo Express', 'SBC', 'SC', '20:20', 690, SLEEPER(470, 1_240, 1_760)),
  train('D1703', 'Charminar Demo Superfast', 'SBC', 'SC', '17:30', 700, {
    '3A': 1_310,
    '2A': 1_850,
    '1A': 3_050,
  }),
  train('D1702', 'Deccan Demo Express', 'SC', 'SBC', '17:50', 680, SLEEPER(470, 1_240, 1_760)),
  train('D1704', 'Charminar Demo Superfast', 'SC', 'SBC', '19:10', 705, {
    '3A': 1_310,
    '2A': 1_850,
    '1A': 3_050,
  }),
  train('D1401', 'Pink City Demo Chair Car', 'NDLS', 'JP', '06:05', 270, { CC: 870, EC: 1_680 }),
  train('D1403', 'Aravalli Demo Express', 'NDLS', 'JP', '15:10', 290, SLEEPER(260, 690, 960)),
  train('D1402', 'Pink City Demo Chair Car', 'JP', 'NDLS', '17:45', 275, { CC: 870, EC: 1_680 }),
  train('D1404', 'Aravalli Demo Express', 'JP', 'NDLS', '06:40', 300, SLEEPER(260, 690, 960)),
  train('D1101', 'Sahyadri Demo Chair Car', 'CSMT', 'PUNE', '07:10', 195, { CC: 520, EC: 1_080 }),
  train('D1103', 'Konkan Demo Passenger', 'CSMT', 'PUNE', '17:30', 205, { SL: 165, '3A': 560 }),
  train('D1102', 'Sahyadri Demo Chair Car', 'PUNE', 'CSMT', '15:15', 190, { CC: 520, EC: 1_080 }),
  train('D1104', 'Konkan Demo Passenger', 'PUNE', 'CSMT', '06:25', 210, { SL: 165, '3A': 560 }),
  train('D1801', 'Godavari Demo Express', 'SC', 'MAS', '17:40', 765, SLEEPER(520, 1_360, 1_920)),
  train('D1802', 'Godavari Demo Express', 'MAS', 'SC', '16:45', 770, SLEEPER(520, 1_360, 1_920)),
];

function search(request: SearchRequestFor<'trains'>, now: Date): ProviderResult<'trains'>[] {
  const { origin, destination, departureDate: date, adults, children } = request;
  const passengers = adults + children;
  return TRAINS.filter(
    (t) => t.from === origin && t.to === destination && runsOn(t.days, date),
  ).flatMap((t) =>
    (Object.entries(t.fares) as [TrainClass, number][]).map(
      ([code, fare]): ProviderResult<'trains'> => {
        const offerRef = `${t.number}/${date}/${code}`;
        return {
          serviceType: 'trains',
          id: `demo-trains:${offerRef}`,
          providerId: 'demo-trains',
          source: 'demo',
          title: `${t.number} ${t.name} · ${TRAIN_CLASS_NAMES[code]}`,
          price: totalPrice(BigInt(fare) * BigInt(passengers), {
            rupees: BigInt(fare),
            unit: 'passenger',
          }),
          offerRef,
          validUntil: validUntil(now),
          trainNumber: t.number,
          trainName: t.name,
          origin: point(t.from),
          destination: point(t.to),
          departAt: zoned(date, t.departs),
          arriveAt: zoned(date, t.departs + t.minutes),
          durationMinutes: t.minutes,
          travelClass: { code, name: TRAIN_CLASS_NAMES[code] },
          passengers,
        };
      },
    ),
  );
}

export const demoTrainsProvider = singleCategoryProvider({
  id: 'demo-trains',
  name: 'Wayora demo trains',
  kind: 'demo',
  version: DEMO_VERSION,
  serviceType: 'trains',
  timeoutMs: DEMO_TIMEOUT_MS,
  search: (request, { now }) => search(request, now),
});
