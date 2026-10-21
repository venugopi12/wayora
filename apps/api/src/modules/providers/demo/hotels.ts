import { daysBetween, findPlace, type HotelResult, type SearchRequestFor } from '@wayora/contracts';
import { singleCategoryProvider, type ProviderResult } from '../provider.js';
import { DEMO_TIMEOUT_MS, DEMO_VERSION, totalPrice, validUntil } from './support.js';

/*
 * Demo hotels in Goa, Jaipur, Bengaluru and Kochi (Kerala). The PROPERTIES
 * ARE FICTIONAL; neighbourhood names are real places so results read
 * naturally. Nightly rates are fixed per room; no ratings or reviews exist.
 */

type HotelFixture = Omit<
  HotelResult,
  | 'id'
  | 'providerId'
  | 'source'
  | 'title'
  | 'price'
  | 'offerRef'
  | 'validUntil'
  | 'serviceType'
  | 'checkIn'
  | 'checkOut'
  | 'nights'
  | 'rooms'
  | 'guests'
> & {
  ref: string;
  cityPlaceId: string;
  nightlyRate: number;
  /** Most adults one room takes. */
  maxAdultsPerRoom: number;
};

const hotel = (
  ref: string,
  cityPlaceId: string,
  name: string,
  propertyType: HotelFixture['property']['propertyType'],
  area: string,
  roomType: string,
  nightlyRate: number,
  amenities: HotelFixture['amenities'],
  { breakfast = false, maxAdults = 2 }: { breakfast?: boolean; maxAdults?: number } = {},
): HotelFixture => ({
  ref,
  cityPlaceId,
  property: { name, propertyType, area, cityName: findPlace(cityPlaceId)!.cityName },
  roomType,
  nightlyRate,
  amenities,
  breakfastIncluded: breakfast,
  maxAdultsPerRoom: maxAdults,
});

const HOTELS: readonly HotelFixture[] = [
  hotel(
    'goa-casa-lagoa',
    'city:goa',
    'Casa Lagoa (demo)',
    'boutique',
    'Assagao',
    'Garden double room',
    7_800,
    ['wifi', 'pool', 'breakfast'],
    { breakfast: true },
  ),
  hotel(
    'goa-palm-tide',
    'city:goa',
    'Palm Tide Resort (demo)',
    'resort',
    'Candolim',
    'Sea-view room',
    11_400,
    ['wifi', 'pool', 'spa', 'gym', 'parking'],
    { maxAdults: 3 },
  ),
  hotel(
    'goa-red-roof',
    'city:goa',
    'Red Roof Homestay (demo)',
    'homestay',
    'Palolem',
    'Family room',
    3_900,
    ['wifi', 'parking'],
    { maxAdults: 3 },
  ),
  hotel(
    'jai-haveli-sol',
    'city:jaipur',
    'Haveli Sol (demo)',
    'boutique',
    'C-Scheme',
    'Heritage room',
    8_600,
    ['wifi', 'breakfast', 'parking'],
    { breakfast: true },
  ),
  hotel(
    'jai-amber-court',
    'city:jaipur',
    'Amber Court Hotel (demo)',
    'hotel',
    'Amer Road',
    'Deluxe twin',
    5_200,
    ['wifi', 'pool', 'gym', 'parking'],
  ),
  hotel(
    'jai-step-well',
    'city:jaipur',
    'Stepwell Retreat (demo)',
    'resort',
    'Jhalana',
    'Courtyard suite',
    14_900,
    ['wifi', 'pool', 'spa', 'breakfast', 'gym'],
    { breakfast: true, maxAdults: 3 },
  ),
  hotel(
    'blr-cubbon-stay',
    'city:bengaluru',
    'Cubbon Stay (demo)',
    'hotel',
    'MG Road',
    'Business king',
    6_900,
    ['wifi', 'gym', 'breakfast'],
    { breakfast: true },
  ),
  hotel(
    'blr-indira-loft',
    'city:bengaluru',
    'Indira Lofts (demo)',
    'boutique',
    'Indiranagar',
    'Studio loft',
    5_600,
    ['wifi'],
  ),
  hotel(
    'blr-white-oak',
    'city:bengaluru',
    'White Oak Suites (demo)',
    'hotel',
    'Whitefield',
    'One-bedroom suite',
    7_400,
    ['wifi', 'pool', 'gym', 'parking'],
    { maxAdults: 3 },
  ),
  hotel(
    'cok-harbour-house',
    'city:kochi',
    'Harbour House (demo)',
    'boutique',
    'Fort Kochi',
    'Colonial double',
    6_300,
    ['wifi', 'breakfast'],
    { breakfast: true },
  ),
  hotel(
    'cok-backwater',
    'city:kochi',
    'Backwater Bay Resort (demo)',
    'resort',
    'Kumbalangi',
    'Lagoon cottage',
    9_800,
    ['wifi', 'pool', 'spa', 'parking'],
    { maxAdults: 3 },
  ),
  hotel(
    'cok-marine-view',
    'city:kochi',
    'Marine View Hotel (demo)',
    'hotel',
    'Marine Drive',
    'City-view room',
    4_700,
    ['wifi', 'gym', 'parking'],
  ),
];

function search(request: SearchRequestFor<'hotels'>, now: Date): ProviderResult<'hotels'>[] {
  const { destination, checkIn, checkOut, rooms, adults, children } = request;
  const nights = daysBetween(checkIn, checkOut);
  return HOTELS.filter(
    (h) => h.cityPlaceId === destination && adults <= h.maxAdultsPerRoom * rooms,
  ).map(({ ref, cityPlaceId: _city, nightlyRate, maxAdultsPerRoom: _max, ...details }) => {
    const perNight = BigInt(nightlyRate) * BigInt(rooms);
    const offerRef = `${ref}/${checkIn}/${checkOut}/${rooms}`;
    return {
      serviceType: 'hotels',
      id: `demo-hotels:${offerRef}`,
      providerId: 'demo-hotels',
      source: 'demo',
      title: `${details.property.name}, ${details.property.area}`,
      price: totalPrice(perNight * BigInt(nights), { rupees: perNight, unit: 'night' }),
      offerRef,
      validUntil: validUntil(now),
      ...details,
      checkIn,
      checkOut,
      nights,
      rooms,
      guests: adults + children,
    };
  });
}

export const demoHotelsProvider = singleCategoryProvider({
  id: 'demo-hotels',
  name: 'Wayora demo hotels',
  kind: 'demo',
  version: DEMO_VERSION,
  serviceType: 'hotels',
  timeoutMs: DEMO_TIMEOUT_MS,
  search: (request, { now }) => search(request, now),
});
