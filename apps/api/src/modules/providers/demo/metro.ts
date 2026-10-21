import { findPlace, type MetroResult, type SearchRequestFor } from '@wayora/contracts';
import { singleCategoryProvider, type ProviderResult } from '../provider.js';
import { DEMO_TIMEOUT_MS, DEMO_VERSION, point, totalPrice, validUntil } from './support.js';

/*
 * Demo metro journey planner for Bengaluru (Namma Metro Purple and Green
 * lines) and Delhi (Yellow and Blue lines). Station order follows the real
 * lines for the stations listed (positions count the stations in between);
 * travel times and fares are DEMO ESTIMATES, not operator timetables or
 * tariffs. No timetable is modelled, so no departure times are shown.
 */

interface Line {
  id: string;
  name: string;
  colour: string;
  cityId: string;
  /** station place id → position along the line */
  stations: Readonly<Record<string, number>>;
}

const LINES: readonly Line[] = [
  {
    id: 'blr-purple',
    name: 'Purple Line',
    colour: '#7e3c98',
    cityId: 'bengaluru',
    stations: {
      'metro:blr-whitefield': 0,
      'metro:blr-kr-puram': 11,
      'metro:blr-indiranagar': 15,
      'metro:blr-mg-road': 18,
      'metro:blr-cubbon-park': 19,
      'metro:blr-majestic': 22,
      'metro:blr-vijayanagar': 27,
    },
  },
  {
    id: 'blr-green',
    name: 'Green Line',
    colour: '#2f9e44',
    cityId: 'bengaluru',
    stations: {
      'metro:blr-yeshwanthpur': 0,
      'metro:blr-majestic': 7,
      'metro:blr-lalbagh': 11,
      'metro:blr-jayanagar': 13,
    },
  },
  {
    id: 'del-yellow',
    name: 'Yellow Line',
    colour: '#e3b505',
    cityId: 'delhi',
    stations: {
      'metro:del-kashmere-gate': 0,
      'metro:del-chandni-chowk': 1,
      'metro:del-new-delhi': 3,
      'metro:del-rajiv-chowk': 4,
      'metro:del-central-secretariat': 6,
      'metro:del-hauz-khas': 13,
      'metro:del-qutab-minar': 16,
    },
  },
  {
    id: 'del-blue',
    name: 'Blue Line',
    colour: '#1d5fbf',
    cityId: 'delhi',
    stations: {
      'metro:del-karol-bagh': -3,
      'metro:del-rajiv-chowk': 0,
      'metro:del-mandi-house': 2,
      'metro:del-noida-sector-18': 12,
    },
  },
];

const MINUTES_PER_STOP = 2;
const INTERCHANGE_MINUTES = 6;
/** Demo fare tiers by stations travelled: [up to N stops, rupees]. */
const FARE_TIERS: readonly [number, number][] = [
  [2, 11],
  [5, 21],
  [12, 32],
  [21, 43],
  [32, 54],
];
const MAX_FARE = 64;

type Leg = MetroResult['legs'][number];

function leg(line: Line, from: string, to: string): Leg {
  const stops = Math.abs(line.stations[to]! - line.stations[from]!);
  return {
    line: { id: line.id, name: line.name, colour: line.colour },
    from: point(from),
    to: point(to),
    stops,
    durationMinutes: stops * MINUTES_PER_STOP,
  };
}

/** Journeys with no change, or one change at a shared station. */
function journeys(from: string, to: string): Leg[][] {
  const direct = LINES.filter((l) => from in l.stations && to in l.stations).map((l) => [
    leg(l, from, to),
  ]);
  if (direct.length > 0) return direct;
  const result: Leg[][] = [];
  for (const first of LINES.filter((l) => from in l.stations)) {
    for (const second of LINES.filter((l) => l !== first && to in l.stations)) {
      for (const station of Object.keys(first.stations)) {
        if (station !== from && station !== to && station in second.stations) {
          result.push([leg(first, from, station), leg(second, station, to)]);
        }
      }
    }
  }
  return result;
}

function fare(stops: number): number {
  return FARE_TIERS.find(([max]) => stops <= max)?.[1] ?? MAX_FARE;
}

function search(request: SearchRequestFor<'metro'>, now: Date): ProviderResult<'metro'>[] {
  const { origin, destination, passengers } = request;
  return journeys(origin, destination).map((legs) => {
    const stops = legs.reduce((n, l) => n + l.stops, 0);
    const transfers = legs.length - 1;
    const perPassenger = BigInt(fare(stops));
    const via = transfers > 0 ? ` via ${legs[0]!.to.name}` : '';
    const offerRef = `${legs.map((l) => `${l.line.id}:${l.from.placeId}>${l.to.placeId}`).join('|')}`;
    return {
      serviceType: 'metro',
      id: `demo-metro:${offerRef}`,
      providerId: 'demo-metro',
      source: 'demo',
      title: `${legs.map((l) => l.line.name).join(' → ')}${via}`,
      price: totalPrice(perPassenger * BigInt(passengers), {
        rupees: perPassenger,
        unit: 'passenger',
      }),
      offerRef,
      validUntil: validUntil(now),
      cityName: findPlace(origin)!.cityName,
      origin: point(origin),
      destination: point(destination),
      legs,
      transfers,
      durationMinutes: stops * MINUTES_PER_STOP + transfers * INTERCHANGE_MINUTES,
      passengers,
    };
  });
}

export const demoMetroProvider = singleCategoryProvider({
  id: 'demo-metro',
  name: 'Wayora demo metro planner',
  kind: 'demo',
  version: DEMO_VERSION,
  serviceType: 'metro',
  timeoutMs: DEMO_TIMEOUT_MS,
  search: (request, { now }) => search(request, now),
});
