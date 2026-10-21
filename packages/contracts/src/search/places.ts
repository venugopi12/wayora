import { z } from 'zod';

/*
 * Search place directory (Phase 9).
 *
 * Reference data, not inventory: the airports, rail stations, cities, metro
 * stations, localities and holiday destinations that search forms offer and
 * the API accepts. Codes are public identifiers (IATA airport codes, Indian
 * Railways station codes). Nothing here says that any trip, room or fare
 * exists; that is the providers' job.
 *
 * The list is small on purpose: it matches the demo providers' coverage. Real
 * supplier integrations will need a place-lookup service instead (docs/search.md).
 */

export const placeKindSchema = z.enum([
  'airport',
  'rail-station',
  'city',
  'metro-station',
  'locality',
  'destination',
]);
export type PlaceKind = z.infer<typeof placeKindSchema>;

/** `kind:slug`, e.g. `airport:BLR`, `city:goa`, `metro:blr-majestic`. */
export const placeIdSchema = z
  .string({ error: 'Choose a place.' })
  .min(1, 'Choose a place.')
  .max(64)
  .regex(/^[a-z]+:[A-Za-z0-9-]+$/, 'Not a valid place.');
export type PlaceId = z.infer<typeof placeIdSchema>;

export const placeSchema = z.object({
  id: placeIdSchema,
  kind: placeKindSchema,
  /** Full name, e.g. "Kempegowda International Airport". */
  name: z.string().min(1),
  /** Public code where one exists: IATA (BLR) or station code (SBC). */
  code: z.string().min(1).nullable(),
  /** The city or area this place belongs to, for display and same-city rules. */
  cityId: z.string().min(1),
  cityName: z.string().min(1),
  /** ISO 3166-1 alpha-2. */
  country: z.string().length(2),
  /** IANA time zone; local times in results use this zone's offset. */
  timeZone: z.string().min(1),
});
export type Place = z.infer<typeof placeSchema>;

const IST = 'Asia/Kolkata';

const place = (
  id: string,
  kind: PlaceKind,
  name: string,
  cityId: string,
  cityName: string,
  code: string | null = null,
  { country = 'IN', timeZone = IST }: { country?: string; timeZone?: string } = {},
): Place => ({ id, kind, name, code, cityId, cityName, country, timeZone });

export const SEARCH_PLACES: readonly Place[] = [
  // Airports (IATA codes)
  place(
    'airport:BLR',
    'airport',
    'Kempegowda International Airport',
    'bengaluru',
    'Bengaluru',
    'BLR',
  ),
  place('airport:DEL', 'airport', 'Indira Gandhi International Airport', 'delhi', 'Delhi', 'DEL'),
  place(
    'airport:BOM',
    'airport',
    'Chhatrapati Shivaji Maharaj International Airport',
    'mumbai',
    'Mumbai',
    'BOM',
  ),
  place(
    'airport:HYD',
    'airport',
    'Rajiv Gandhi International Airport',
    'hyderabad',
    'Hyderabad',
    'HYD',
  ),
  place('airport:GOI', 'airport', 'Goa International Airport, Dabolim', 'goa', 'Goa', 'GOI'),

  // Rail stations (Indian Railways station codes)
  place(
    'station:SBC',
    'rail-station',
    'KSR Bengaluru City Junction',
    'bengaluru',
    'Bengaluru',
    'SBC',
  ),
  place('station:MAS', 'rail-station', 'Chennai Central', 'chennai', 'Chennai', 'MAS'),
  place('station:NDLS', 'rail-station', 'New Delhi', 'delhi', 'Delhi', 'NDLS'),
  place('station:CSMT', 'rail-station', 'Mumbai CSMT', 'mumbai', 'Mumbai', 'CSMT'),
  place('station:SC', 'rail-station', 'Secunderabad Junction', 'hyderabad', 'Hyderabad', 'SC'),
  place('station:PUNE', 'rail-station', 'Pune Junction', 'pune', 'Pune', 'PUNE'),
  place('station:JP', 'rail-station', 'Jaipur Junction', 'jaipur', 'Jaipur', 'JP'),

  // Cities and areas (bus routes, hotel destinations)
  place('city:bengaluru', 'city', 'Bengaluru', 'bengaluru', 'Bengaluru'),
  place('city:hyderabad', 'city', 'Hyderabad', 'hyderabad', 'Hyderabad'),
  place('city:chennai', 'city', 'Chennai', 'chennai', 'Chennai'),
  place('city:pune', 'city', 'Pune', 'pune', 'Pune'),
  place('city:goa', 'city', 'Goa', 'goa', 'Goa'),
  place('city:jaipur', 'city', 'Jaipur', 'jaipur', 'Jaipur'),
  place('city:kochi', 'city', 'Kochi, Kerala', 'kochi', 'Kochi'),

  // Metro stations: Bengaluru (Namma Metro) and Delhi
  place('metro:blr-whitefield', 'metro-station', 'Whitefield (Kadugodi)', 'bengaluru', 'Bengaluru'),
  place(
    'metro:blr-kr-puram',
    'metro-station',
    'Krishnarajapura (KR Puram)',
    'bengaluru',
    'Bengaluru',
  ),
  place('metro:blr-indiranagar', 'metro-station', 'Indiranagar', 'bengaluru', 'Bengaluru'),
  place('metro:blr-mg-road', 'metro-station', 'MG Road', 'bengaluru', 'Bengaluru'),
  place('metro:blr-cubbon-park', 'metro-station', 'Cubbon Park', 'bengaluru', 'Bengaluru'),
  place(
    'metro:blr-majestic',
    'metro-station',
    'Nadaprabhu Kempegowda Station, Majestic',
    'bengaluru',
    'Bengaluru',
  ),
  place('metro:blr-vijayanagar', 'metro-station', 'Vijayanagar', 'bengaluru', 'Bengaluru'),
  place('metro:blr-yeshwanthpur', 'metro-station', 'Yeshwanthpur', 'bengaluru', 'Bengaluru'),
  place('metro:blr-lalbagh', 'metro-station', 'Lalbagh', 'bengaluru', 'Bengaluru'),
  place('metro:blr-jayanagar', 'metro-station', 'Jayanagar', 'bengaluru', 'Bengaluru'),
  place('metro:del-kashmere-gate', 'metro-station', 'Kashmere Gate', 'delhi', 'Delhi'),
  place('metro:del-chandni-chowk', 'metro-station', 'Chandni Chowk', 'delhi', 'Delhi'),
  place('metro:del-new-delhi', 'metro-station', 'New Delhi', 'delhi', 'Delhi'),
  place('metro:del-rajiv-chowk', 'metro-station', 'Rajiv Chowk', 'delhi', 'Delhi'),
  place('metro:del-central-secretariat', 'metro-station', 'Central Secretariat', 'delhi', 'Delhi'),
  place('metro:del-hauz-khas', 'metro-station', 'Hauz Khas', 'delhi', 'Delhi'),
  place('metro:del-qutab-minar', 'metro-station', 'Qutab Minar', 'delhi', 'Delhi'),
  place('metro:del-karol-bagh', 'metro-station', 'Karol Bagh', 'delhi', 'Delhi'),
  place('metro:del-mandi-house', 'metro-station', 'Mandi House', 'delhi', 'Delhi'),
  place('metro:del-noida-sector-18', 'metro-station', 'Noida Sector 18', 'delhi', 'Delhi'),

  // Cab pick-up and drop-off localities (airports above are also allowed)
  place('locality:blr-mg-road', 'locality', 'MG Road', 'bengaluru', 'Bengaluru'),
  place('locality:blr-koramangala', 'locality', 'Koramangala', 'bengaluru', 'Bengaluru'),
  place('locality:blr-whitefield', 'locality', 'Whitefield', 'bengaluru', 'Bengaluru'),
  place('locality:blr-electronic-city', 'locality', 'Electronic City', 'bengaluru', 'Bengaluru'),
  place('locality:del-connaught-place', 'locality', 'Connaught Place', 'delhi', 'Delhi'),
  place('locality:del-aerocity', 'locality', 'Aerocity', 'delhi', 'Delhi'),
  place('locality:del-cyber-city', 'locality', 'Cyber City, Gurugram', 'delhi', 'Delhi'),
  place('locality:bom-bkc', 'locality', 'Bandra Kurla Complex', 'mumbai', 'Mumbai'),
  place('locality:bom-colaba', 'locality', 'Colaba', 'mumbai', 'Mumbai'),
  place('locality:bom-andheri', 'locality', 'Andheri', 'mumbai', 'Mumbai'),

  // Holiday destinations (same slugs as Discover)
  place('destination:kerala', 'destination', 'Kerala', 'kerala', 'Kerala'),
  place('destination:goa', 'destination', 'Goa', 'goa', 'Goa'),
  place('destination:jaipur', 'destination', 'Jaipur', 'jaipur', 'Jaipur'),
  place('destination:bali', 'destination', 'Bali', 'bali', 'Bali', null, {
    country: 'ID',
    timeZone: 'Asia/Makassar',
  }),
];

const BY_ID: ReadonlyMap<string, Place> = new Map(SEARCH_PLACES.map((p) => [p.id, p]));

export function findPlace(id: string | null | undefined): Place | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** Places of the given kinds, in directory order. */
export function placesOfKind(...kinds: PlaceKind[]): Place[] {
  return SEARCH_PLACES.filter((p) => kinds.includes(p.kind));
}
