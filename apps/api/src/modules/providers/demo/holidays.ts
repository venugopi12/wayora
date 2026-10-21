import type { HolidayInterest, SearchRequestFor } from '@wayora/contracts';
import { singleCategoryProvider, type ProviderResult } from '../provider.js';
import {
  DEMO_TIMEOUT_MS,
  DEMO_VERSION,
  addDays,
  point,
  scaleRupees,
  totalPrice,
  validUntil,
} from './support.js';

/*
 * Demo holiday packages for Kerala, Goa, Jaipur and Bali. PACKAGES ARE
 * FICTIONAL itineraries built around real places; inclusions describe what a
 * package of this kind would contain and are not an offer from any operator.
 * Prices are per traveller (children 70% of the adult price).
 */

interface DemoPackage {
  ref: string;
  destination: string;
  name: string;
  nights: number;
  pricePerAdult: number;
  interests: readonly HolidayInterest[];
  inclusions: readonly string[];
  highlights: readonly string[];
}

const PACKAGES: readonly DemoPackage[] = [
  {
    ref: 'ker-backwaters-hills',
    destination: 'destination:kerala',
    name: 'Backwaters and Hills (demo)',
    nights: 5,
    pricePerAdult: 32_500,
    interests: ['nature', 'wellness'],
    inclusions: [
      'Hotel stays (4 nights)',
      'Houseboat stay (1 night)',
      'Daily breakfast',
      'Private transfers',
    ],
    highlights: ['Fort Kochi', 'Munnar tea country', 'Alappuzha backwaters'],
  },
  {
    ref: 'ker-ayurveda',
    destination: 'destination:kerala',
    name: 'Kovalam Ayurveda Retreat (demo)',
    nights: 6,
    pricePerAdult: 48_000,
    interests: ['wellness', 'beach'],
    inclusions: [
      'Resort stay (6 nights)',
      'All meals',
      'Daily wellness sessions',
      'Airport transfers',
    ],
    highlights: ['Kovalam beach', 'Ayurvedic treatments'],
  },
  {
    ref: 'ker-coast-short',
    destination: 'destination:kerala',
    name: 'Coastal Kerala Short Break (demo)',
    nights: 3,
    pricePerAdult: 18_900,
    interests: ['beach', 'food'],
    inclusions: ['Hotel stay (3 nights)', 'Daily breakfast', 'Kochi food walk'],
    highlights: ['Fort Kochi', 'Cherai beach'],
  },
  {
    ref: 'goa-north-beach',
    destination: 'destination:goa',
    name: 'North Goa Beach Break (demo)',
    nights: 3,
    pricePerAdult: 16_400,
    interests: ['beach', 'food'],
    inclusions: ['Resort stay (3 nights)', 'Daily breakfast', 'Airport transfers'],
    highlights: ['Candolim', 'Fort Aguada', 'Anjuna'],
  },
  {
    ref: 'goa-heritage',
    destination: 'destination:goa',
    name: 'Goa Heritage and Hinterland (demo)',
    nights: 4,
    pricePerAdult: 21_800,
    interests: ['culture', 'nature'],
    inclusions: [
      'Boutique stay (4 nights)',
      'Daily breakfast',
      'Guided Old Goa walk',
      'Spice farm visit',
    ],
    highlights: ['Fontainhas', 'Old Goa churches', 'Dudhsagar viewpoint'],
  },
  {
    ref: 'jai-highlights',
    destination: 'destination:jaipur',
    name: 'Pink City Highlights (demo)',
    nights: 3,
    pricePerAdult: 17_600,
    interests: ['culture', 'food'],
    inclusions: ['Heritage hotel (3 nights)', 'Daily breakfast', 'Guided city tour'],
    highlights: ['Amber Fort', 'Hawa Mahal', 'City Palace'],
  },
  {
    ref: 'jai-ranthambore',
    destination: 'destination:jaipur',
    name: 'Jaipur and Ranthambore (demo)',
    nights: 5,
    pricePerAdult: 39_500,
    interests: ['culture', 'nature', 'adventure'],
    inclusions: [
      'Hotel stays (5 nights)',
      'Daily breakfast',
      'Two jungle safaris',
      'Private car throughout',
    ],
    highlights: ['Amber Fort', 'Ranthambore National Park'],
  },
  {
    ref: 'bali-ubud-seminyak',
    destination: 'destination:bali',
    name: 'Ubud and Seminyak (demo)',
    nights: 6,
    pricePerAdult: 58_000,
    interests: ['culture', 'beach', 'wellness'],
    inclusions: [
      'Villa and hotel stays (6 nights)',
      'Daily breakfast',
      'Airport transfers',
      'Ubud day tour',
    ],
    highlights: ['Ubud rice terraces', 'Seminyak beach'],
  },
  {
    ref: 'bali-explorer',
    destination: 'destination:bali',
    name: 'Bali Island Explorer (demo)',
    nights: 7,
    pricePerAdult: 66_500,
    interests: ['adventure', 'nature', 'beach'],
    inclusions: [
      'Hotel stays (7 nights)',
      'Daily breakfast',
      'Mount Batur sunrise trek',
      'Snorkelling trip',
    ],
    highlights: ['Mount Batur', 'Nusa Penida', 'Uluwatu'],
  },
];

function search(request: SearchRequestFor<'holidays'>, now: Date): ProviderResult<'holidays'>[] {
  const { destination, departureDate, adults, children } = request;
  return PACKAGES.filter((p) => p.destination === destination).map((p) => {
    const perChild = scaleRupees(p.pricePerAdult, 7, 10);
    const total = BigInt(p.pricePerAdult) * BigInt(adults) + perChild * BigInt(children);
    const offerRef = `${p.ref}/${departureDate}`;
    return {
      serviceType: 'holidays',
      id: `demo-holidays:${offerRef}`,
      providerId: 'demo-holidays',
      source: 'demo',
      title: `${p.name}, ${p.nights} nights`,
      price: totalPrice(total, { rupees: BigInt(p.pricePerAdult), unit: 'adult' }),
      offerRef,
      validUntil: validUntil(now),
      packageName: p.name,
      destination: point(p.destination),
      startDate: departureDate,
      endDate: addDays(departureDate, p.nights),
      nights: p.nights,
      travellers: adults + children,
      inclusions: [...p.inclusions],
      highlights: [...p.highlights],
      interests: [...p.interests],
    };
  });
}

export const demoHolidaysProvider = singleCategoryProvider({
  id: 'demo-holidays',
  name: 'Wayora demo holiday packages',
  kind: 'demo',
  version: DEMO_VERSION,
  serviceType: 'holidays',
  timeoutMs: DEMO_TIMEOUT_MS,
  search: (request, { now }) => search(request, now),
});
