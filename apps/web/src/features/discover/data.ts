/**
 * Destination discovery content.
 *
 * SAMPLE DATA. This is a small, curated demonstration dataset bundled with the
 * web app until a discovery API exists. It is editorial inspiration only: no
 * prices, fares, availability, ratings, reviews or deals are attached or
 * implied, and every destination carries `sample: true`. The shape is the
 * shared contract in @wayora/contracts (`destinationSchema`); the test suite
 * validates this file against it.
 *
 * Images are original artwork (apps/web/scripts/generate-artwork.mjs). To swap
 * in licensed photography, see docs/media-assets.md.
 *
 * Adding a destination: append a summary below (unique id/slug, at least one
 * category), its intro and highlights in ./details.ts, add its image, and run
 * `npm test`.
 */
import type {
  DestinationRegion,
  DestinationSummary,
  DestinationSummaryInput,
  TravelMoodSlug,
} from '@wayora/contracts';

const ART = '/media/artwork';

const destinationInputs = [
  {
    id: 'goa',
    slug: 'goa',
    name: 'Goa',
    country: 'India',
    region: 'india',
    locality: 'West coast',
    description: 'Sunset beaches, fishing villages and a coastline made for slowing down.',
    image: {
      src: `${ART}/destination-goa.svg`,
      alt: 'Illustration of fishing boats on a sunset sea between coconut palms',
      focalPoint: '55% 55%',
      tone: '#a2789c',
      kind: 'artwork',
    },
    categories: ['beach-escapes', 'weekend-getaways'],
    featured: true,
    aliases: ['panaji', 'goi'],
    sample: true,
  },
  {
    id: 'jaipur',
    slug: 'jaipur',
    name: 'Jaipur',
    country: 'India',
    region: 'india',
    locality: 'Rajasthan',
    description:
      'Palaces in shades of pink, hilltop forts and bazaars that hum late into the evening.',
    image: {
      src: `${ART}/destination-jaipur.svg`,
      alt: 'Illustration of a tiered pink palace facade below a hilltop fort wall',
      focalPoint: '62% 50%',
      tone: '#c98a92',
      kind: 'artwork',
    },
    categories: ['cultural-journeys', 'weekend-getaways'],
    featured: true,
    aliases: ['pink city', 'jai'],
    sample: true,
  },
  {
    id: 'kerala',
    slug: 'kerala',
    name: 'Kerala',
    country: 'India',
    region: 'india',
    locality: 'South-west coast',
    description:
      'Backwaters lined with coconut palms, best seen slowly from the deck of a houseboat.',
    image: {
      src: `${ART}/destination-kerala.svg`,
      alt: 'Illustration of a houseboat on still backwaters lined with coconut palms',
      focalPoint: '58% 60%',
      tone: '#9db8b3',
      kind: 'artwork',
    },
    categories: ['nature-wellness', 'beach-escapes'],
    featured: true,
    aliases: ['backwaters', 'alleppey', 'alappuzha', 'kochi', 'cochin', 'munnar'],
    sample: true,
  },
  {
    id: 'manali',
    slug: 'manali',
    name: 'Manali',
    country: 'India',
    region: 'india',
    locality: 'Himachal Pradesh',
    description: 'Snow peaks, cedar forests and valley roads that climb toward the high Himalaya.',
    image: {
      src: `${ART}/destination-manali.svg`,
      alt: 'Illustration of snow-capped Himalayan peaks above cedar-covered slopes',
      focalPoint: '52% 40%',
      tone: '#a6aedc',
      kind: 'artwork',
    },
    categories: ['mountain-retreats', 'nature-wellness'],
    featured: true,
    aliases: ['kullu', 'himalaya', 'solang'],
    sample: true,
  },
  {
    id: 'bengaluru',
    slug: 'bengaluru',
    name: 'Bengaluru',
    country: 'India',
    region: 'india',
    locality: 'Karnataka',
    description: 'Leafy parks, a restless food scene and the energy of India’s technology capital.',
    image: {
      src: `${ART}/destination-bengaluru.svg`,
      alt: 'Illustration of a modern skyline at dusk rising behind the broad canopies of rain trees',
      focalPoint: '50% 55%',
      tone: '#7f86bf',
      kind: 'artwork',
    },
    categories: ['city-breaks'],
    featured: false,
    aliases: ['bangalore', 'blr', 'garden city'],
    sample: true,
  },
  {
    id: 'hyderabad',
    slug: 'hyderabad',
    name: 'Hyderabad',
    country: 'India',
    region: 'india',
    locality: 'Telangana',
    description: 'Centuries-old bazaars, a hilltop fort and a cuisine people travel for.',
    image: {
      src: `${ART}/destination-hyderabad.svg`,
      alt: 'Illustration of an arched gateway monument with four minarets above a lamp-lit street',
      focalPoint: '50% 50%',
      tone: '#b88a9e',
      kind: 'artwork',
    },
    categories: ['cultural-journeys', 'city-breaks'],
    featured: false,
    aliases: ['hyd', 'city of pearls', 'secunderabad'],
    sample: true,
  },
  {
    id: 'mumbai',
    slug: 'mumbai',
    name: 'Mumbai',
    country: 'India',
    region: 'india',
    locality: 'Maharashtra',
    description: 'Sea-facing promenades, grand old landmarks and neighbourhoods that never pause.',
    image: {
      src: `${ART}/destination-mumbai.svg`,
      alt: 'Illustration of a curving seafront promenade lit at night, with city towers across the bay',
      focalPoint: '55% 50%',
      tone: '#3a4076',
      kind: 'artwork',
    },
    categories: ['city-breaks', 'cultural-journeys'],
    featured: false,
    aliases: ['bombay', 'bom'],
    sample: true,
  },
  {
    id: 'delhi',
    slug: 'delhi',
    name: 'Delhi',
    country: 'India',
    region: 'india',
    locality: 'National Capital Territory',
    description: 'Monuments from many dynasties, old bazaars and the broad avenues of the capital.',
    image: {
      src: `${ART}/destination-delhi.svg`,
      alt: 'Illustration of a domed garden tomb on an arched plinth, reflected in a long water channel',
      focalPoint: '50% 45%',
      tone: '#d4a59e',
      kind: 'artwork',
    },
    categories: ['cultural-journeys', 'city-breaks'],
    featured: false,
    aliases: ['new delhi', 'del'],
    sample: true,
  },
  {
    id: 'bali',
    slug: 'bali',
    name: 'Bali',
    country: 'Indonesia',
    region: 'southeast-asia',
    description:
      'Terraced rice fields, island temples and beaches on the edge of the Indian Ocean.',
    image: {
      src: `${ART}/destination-bali.svg`,
      alt: 'Illustration of terraced rice fields beneath a distant volcano, framed by palms and a split stone gateway',
      focalPoint: '55% 55%',
      tone: '#8fae9c',
      kind: 'artwork',
    },
    categories: ['beach-escapes', 'nature-wellness', 'cultural-journeys'],
    featured: true,
    aliases: ['ubud', 'denpasar', 'dps'],
    sample: true,
  },
  {
    id: 'kyoto',
    slug: 'kyoto',
    name: 'Kyoto',
    country: 'Japan',
    region: 'east-asia',
    locality: 'Kansai',
    description: 'Temples, quiet gardens and wooden streets that change with every season.',
    image: {
      src: `${ART}/destination-kyoto.svg`,
      alt: 'Illustration of a five-storey wooden pagoda among autumn trees and misty hills',
      focalPoint: '45% 50%',
      tone: '#c79aa8',
      kind: 'artwork',
    },
    categories: ['cultural-journeys', 'nature-wellness'],
    featured: true,
    aliases: ['kansai', 'kyōto'],
    sample: true,
  },
  {
    id: 'singapore',
    slug: 'singapore',
    name: 'Singapore',
    country: 'Singapore',
    region: 'southeast-asia',
    description:
      'A garden city on the water, with hawker centres and neighbourhoods close together.',
    image: {
      src: `${ART}/destination-singapore.svg`,
      alt: 'Illustration of a city skyline over a calm bay at night, framed by tropical trees',
      focalPoint: '50% 50%',
      tone: '#2c3466',
      kind: 'artwork',
    },
    categories: ['city-breaks'],
    featured: false,
    aliases: ['sin', 'changi'],
    sample: true,
  },
  {
    id: 'dubai',
    slug: 'dubai',
    name: 'Dubai',
    country: 'United Arab Emirates',
    region: 'middle-east',
    description: 'Desert light, a skyline of record-breaking towers and long Gulf beaches.',
    image: {
      src: `${ART}/destination-dubai.svg`,
      alt: 'Illustration of desert dunes at sunset with a skyline of slender towers on the horizon',
      focalPoint: '60% 55%',
      tone: '#d9a58f',
      kind: 'artwork',
    },
    categories: ['city-breaks', 'beach-escapes'],
    featured: false,
    aliases: ['dxb', 'uae'],
    sample: true,
  },
] satisfies DestinationSummaryInput[];

/**
 * All sample destinations (summaries), in curated display order. Long-form
 * copy (intro, highlights) lives in ./details.ts, which only the lazily loaded
 * Discover pages import, so the homepage and header search stay light.
 */
export const DESTINATIONS: readonly DestinationSummary[] = destinationInputs.map(
  (d: DestinationSummaryInput): DestinationSummary => ({ ...d, aliases: d.aliases ?? [] }),
);

/** A destination slug. References to slugs in this file are checked by the test suite. */
export type DestinationSlug = string;

/**
 * Discover's "Editor's picks", in bento order (lead tile first). It opens with
 * places the homepage doesn't feature, so the two pages don't repeat.
 */
export const DISCOVER_PICKS: readonly DestinationSlug[] = [
  'kyoto',
  'bali',
  'kerala',
  'manali',
  'goa',
  'jaipur',
];

/** Shown on the homepage, in this order (lead tile first). */
export const HOMEPAGE_FEATURED: readonly DestinationSlug[] = ['kerala', 'goa', 'jaipur', 'manali'];

// ─── Moods ────────────────────────────────────────────────────────────────

export interface MoodImage {
  src: string;
  alt: string;
  focalPoint?: string;
  tone: string;
}

export interface Mood {
  slug: TravelMoodSlug;
  title: string;
  /** One line for tiles. */
  line: string;
  image: MoodImage;
  /** Accent for the mood's tile and filter chip. */
  accent: string;
}

export const MOODS: readonly Mood[] = [
  {
    slug: 'beach-escapes',
    title: 'Beach escapes',
    line: 'Warm water, slow afternoons and sunsets you plan the day around.',
    image: {
      src: `${ART}/mood-beach-escapes.svg`,
      alt: 'Illustration of a calm sea at sunset, framed by coconut palms on a sandy shore',
      focalPoint: '45% 50%',
      tone: '#9a8fbf',
    },
    accent: '#f4c9b1',
  },
  {
    slug: 'mountain-retreats',
    title: 'Mountain retreats',
    line: 'Thin air, pine forests and mornings that start above the clouds.',
    image: {
      src: `${ART}/mood-mountain-retreats.svg`,
      alt: 'Illustration of snow-dusted peaks above misty valleys and pine forests',
      focalPoint: '50% 45%',
      tone: '#b7bee4',
    },
    accent: '#dde1f7',
  },
  {
    slug: 'cultural-journeys',
    title: 'Cultural journeys',
    line: 'Old quarters, grand architecture and traditions best explored on foot.',
    image: {
      src: `${ART}/mood-cultural-cities.svg`,
      alt: 'Illustration of a domed skyline at dusk, seen through a tall pointed arch',
      focalPoint: '50% 55%',
      tone: '#6a5f9e',
    },
    accent: '#d99aa6',
  },
  {
    slug: 'nature-wellness',
    title: 'Nature & wellness',
    line: 'Green landscapes, slower rhythms and time to properly rest.',
    image: {
      src: `${ART}/mood-nature-wellness.svg`,
      alt: 'Illustration of a waterfall falling into a misty, forested valley',
      focalPoint: '50% 50%',
      tone: '#8fb0aa',
    },
    accent: '#cfdcd2',
  },
  {
    slug: 'city-breaks',
    title: 'City breaks',
    line: 'Food streets, skylines and neighbourhoods worth a few full days.',
    image: {
      src: `${ART}/mood-city-breaks.svg`,
      alt: 'Illustration of a city skyline at dusk with a bridge across a river',
      focalPoint: '50% 55%',
      tone: '#5b5f9e',
    },
    accent: '#bcc3ec',
  },
  {
    slug: 'weekend-getaways',
    title: 'Weekend getaways',
    line: 'Two days, one change of scenery, and a route home in time for Monday.',
    image: {
      src: `${ART}/mood-weekend-getaways.svg`,
      alt: 'Illustration of a winding road through rolling hills toward a low sun',
      focalPoint: '55% 55%',
      tone: '#b3a3c8',
    },
    accent: '#f7dccb',
  },
];

/** The four moods shown on the homepage. */
export const HOMEPAGE_MOODS: readonly TravelMoodSlug[] = [
  'beach-escapes',
  'mountain-retreats',
  'cultural-journeys',
  'weekend-getaways',
];

/** Old homepage links used `cultural-cities`; keep them working. */
const MOOD_ALIASES: Record<string, TravelMoodSlug> = { 'cultural-cities': 'cultural-journeys' };

export function findMood(slug: string | null | undefined): Mood | undefined {
  if (!slug) return undefined;
  const resolved = MOOD_ALIASES[slug] ?? slug;
  return MOODS.find((m) => m.slug === resolved);
}

export const moodBySlug = Object.fromEntries(MOODS.map((m) => [m.slug, m])) as Record<
  TravelMoodSlug,
  Mood
>;

// ─── Regions ──────────────────────────────────────────────────────────────

export interface Region {
  slug: DestinationRegion;
  name: string;
  line: string;
}

export const REGIONS: readonly Region[] = [
  {
    slug: 'india',
    name: 'India',
    line: 'Coastlines, mountain valleys and cities layered with centuries of history.',
  },
  {
    slug: 'southeast-asia',
    name: 'Southeast Asia',
    line: 'Island temples, green terraces and bright, food-loving cities.',
  },
  {
    slug: 'east-asia',
    name: 'East Asia',
    line: 'Quiet gardens, old wooden streets and seasonal colour.',
  },
  {
    slug: 'middle-east',
    name: 'Middle East',
    line: 'Desert light, modern skylines and evenings on the coast.',
  },
];

export function findRegion(slug: string | null | undefined): Region | undefined {
  return slug ? REGIONS.find((r) => r.slug === slug) : undefined;
}

export const regionBySlug = Object.fromEntries(REGIONS.map((r) => [r.slug, r])) as Record<
  DestinationRegion,
  Region
>;

// ─── Inspiration ──────────────────────────────────────────────────────────

export interface Pairing {
  title: string;
  text: string;
  /** Two destination slugs, in travel order. */
  stops: readonly [DestinationSlug, DestinationSlug];
}

/** Editorial ideas for combining two sample destinations in one trip. */
export const PAIRINGS: readonly Pairing[] = [
  {
    title: 'A capital, then a palace city',
    text: "Start with Delhi's monuments and markets, then trade the capital's pace for Jaipur's forts and bazaars.",
    stops: ['delhi', 'jaipur'],
  },
  {
    title: 'City energy, then the coast',
    text: "Pair Mumbai's seafront and street food with slower days on Goa's beaches.",
    stops: ['mumbai', 'goa'],
  },
  {
    title: 'From the Garden City to the backwaters',
    text: "Begin in Bengaluru's parks and cafés, then head south-west for Kerala's canals and tea hills.",
    stops: ['bengaluru', 'kerala'],
  },
];
