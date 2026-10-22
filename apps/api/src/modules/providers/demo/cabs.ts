import type { SearchRequestFor, VehicleType } from '@wayora/contracts';
import { singleCategoryProvider, type ProviderResult } from '../provider.js';
import { DEMO_TIMEOUT_MS, DEMO_VERSION, inr, point, validUntil } from './support.js';

/*
 * Demo cab fare estimates in Bengaluru, Delhi and Mumbai. Distances are
 * approximate road distances between the listed places; fares are a DEMO
 * formula (base + per km, shown as a range). Real cab prices depend on live
 * traffic and demand, which demo data cannot know, so no ETA or driver
 * availability is ever shown.
 */

/** Approximate road distance in km for each pair (either direction). */
const DISTANCES: readonly [string, string, number][] = [
  ['airport:BLR', 'locality:blr-mg-road', 35],
  ['airport:BLR', 'locality:blr-koramangala', 40],
  ['airport:BLR', 'locality:blr-whitefield', 40],
  ['airport:BLR', 'locality:blr-electronic-city', 55],
  ['locality:blr-mg-road', 'locality:blr-koramangala', 7],
  ['locality:blr-mg-road', 'locality:blr-whitefield', 18],
  ['locality:blr-mg-road', 'locality:blr-electronic-city', 20],
  ['locality:blr-koramangala', 'locality:blr-whitefield', 18],
  ['locality:blr-koramangala', 'locality:blr-electronic-city', 13],
  ['locality:blr-whitefield', 'locality:blr-electronic-city', 30],
  ['airport:DEL', 'locality:del-connaught-place', 16],
  ['airport:DEL', 'locality:del-aerocity', 3],
  ['airport:DEL', 'locality:del-cyber-city', 12],
  ['locality:del-connaught-place', 'locality:del-aerocity', 15],
  ['locality:del-connaught-place', 'locality:del-cyber-city', 28],
  ['locality:del-aerocity', 'locality:del-cyber-city', 11],
  ['airport:BOM', 'locality:bom-bkc', 9],
  ['airport:BOM', 'locality:bom-colaba', 27],
  ['airport:BOM', 'locality:bom-andheri', 5],
  ['locality:bom-bkc', 'locality:bom-colaba', 19],
  ['locality:bom-bkc', 'locality:bom-andheri', 10],
  ['locality:bom-colaba', 'locality:bom-andheri', 30],
];

interface Vehicle {
  type: VehicleType;
  label: string;
  capacity: number;
  base: number;
  perKm: number;
}

/** Generic classes only: no brand or specific car is promised. */
const VEHICLES: readonly Vehicle[] = [
  { type: 'hatchback', label: 'Hatchback (compact)', capacity: 3, base: 80, perKm: 14 },
  { type: 'sedan', label: 'Sedan (compact saloon)', capacity: 4, base: 100, perKm: 17 },
  { type: 'suv', label: 'SUV (6-seater)', capacity: 6, base: 150, perKm: 23 },
  { type: 'premium', label: 'Premium sedan', capacity: 4, base: 250, perKm: 32 },
];

/** Average city speed used for the drive-time estimate. */
const MINUTES_PER_KM = 2.6;
/** Upper end of the estimate range is 20% above the lower, rounded up to ₹10. */
function estimate(vehicle: Vehicle, km: number): [bigint, bigint] {
  const low = BigInt(vehicle.base + vehicle.perKm * km);
  const high = ((low * 12n + 99n) / 100n) * 10n;
  const lowRounded = ((low + 9n) / 10n) * 10n;
  return [lowRounded, high];
}

function distance(a: string, b: string): number | undefined {
  return DISTANCES.find(([x, y]) => (x === a && y === b) || (x === b && y === a))?.[2];
}

function search(request: SearchRequestFor<'cabs'>, now: Date): ProviderResult<'cabs'>[] {
  const { pickup, dropoff, pickupAt, passengers } = request;
  const km = distance(pickup, dropoff);
  if (km === undefined) return [];
  return VEHICLES.filter((v) => v.capacity >= passengers).map((v) => {
    const [low, high] = estimate(v, km);
    const offerRef = `${v.type}/${pickup}>${dropoff}/${pickupAt}`;
    return {
      serviceType: 'cabs',
      id: `demo-cabs:${offerRef}`,
      providerId: 'demo-cabs',
      source: 'demo',
      title: `${v.label}, up to ${v.capacity} passengers`,
      price: { kind: 'range', min: inr(low), max: inr(high) },
      offerRef,
      validUntil: validUntil(now),
      vehicleType: v.type,
      vehicleLabel: v.label,
      capacity: v.capacity,
      pickup: point(pickup),
      dropoff: point(dropoff),
      pickupAt,
      distanceKm: km,
      durationMinutes: Math.round(km * MINUTES_PER_KM) + 5,
      passengers,
    };
  });
}

export const demoCabsProvider = singleCategoryProvider({
  id: 'demo-cabs',
  name: 'Wayora demo cab estimates',
  kind: 'demo',
  version: DEMO_VERSION,
  serviceType: 'cabs',
  timeoutMs: DEMO_TIMEOUT_MS,
  search: (request, { now }) => search(request, now),
});
