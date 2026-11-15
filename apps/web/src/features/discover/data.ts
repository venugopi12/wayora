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
 * Images are photographs from Unsplash (Unsplash License), downloaded into
 * public/media/photos by `npm run photos`; each was taken in the place it
 * illustrates. Sources and photographers: scripts/photos.manifest.json and
 * docs/media-assets.md.
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

const PHOTOS = '/media/photos';

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
      src: `${PHOTOS}/destination-goa.webp`,
      alt: 'A turquoise bay and sandy beach lined with palms and beach huts in Goa',
      focalPoint: '50% 50%',
      tone: '#2f8fb5',
      kind: 'photo',
      credit: 'Photo by alexey turenkov on Unsplash',
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
      src: `${PHOTOS}/destination-jaipur.webp`,
      alt: 'The pink, honeycombed facade of the Hawa Mahal in Jaipur under a blue sky',
      focalPoint: '50% 55%',
      tone: '#c9805a',
      kind: 'photo',
      credit: 'Photo by Roberto Reposo on Unsplash',
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
      src: `${PHOTOS}/destination-kerala.webp`,
      alt: 'A traditional houseboat on the palm-lined backwaters of Alappuzha, Kerala',
      focalPoint: '55% 55%',
      tone: '#6f9a86',
      kind: 'photo',
      credit: 'Photo by Abhishek Prasad on Unsplash',
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
      src: `${PHOTOS}/destination-manali.webp`,
      alt: 'A small town below snow-covered mountains and clouds near Manali',
      focalPoint: '50% 45%',
      tone: '#7f8fa3',
      kind: 'photo',
      credit: 'Photo by Naman jaswani on Unsplash',
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
      src: `${PHOTOS}/destination-bengaluru.webp`,
      alt: 'The domed Vidhana Soudha building in Bengaluru under a bright, cloudy sky',
      focalPoint: '50% 60%',
      tone: '#8fa3b8',
      kind: 'photo',
      credit: 'Photo by zablanca_clicks on Unsplash',
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
      src: `${PHOTOS}/destination-hyderabad.webp`,
      alt: 'The Charminar and its four minarets above a busy street in Hyderabad',
      focalPoint: '50% 50%',
      tone: '#b79a78',
      kind: 'photo',
      credit: 'Photo by Kanishq Kancharla on Unsplash',
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
      src: `${PHOTOS}/destination-mumbai.webp`,
      alt: 'The lights of Mumbai’s curving seafront reflected in the bay at dusk',
      focalPoint: '45% 55%',
      tone: '#2b2f4a',
      kind: 'photo',
      credit: 'Photo by Nishith Parikh on Unsplash',
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
      src: `${PHOTOS}/destination-delhi.webp`,
      alt: 'Humayun’s Tomb in Delhi reflected in the water channel of its garden',
      focalPoint: '50% 50%',
      tone: '#a8785a',
      kind: 'photo',
      credit: 'Photo by Shubham Sharma on Unsplash',
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
      src: `${PHOTOS}/destination-bali.webp`,
      alt: 'Green rice terraces in morning mist below Mount Agung in Sidemen, Bali',
      focalPoint: '50% 55%',
      tone: '#6f8a4a',
      kind: 'photo',
      credit: 'Photo by Geio Tischler on Unsplash',
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
      src: `${PHOTOS}/destination-kyoto.webp`,
      alt: 'A five-storey pagoda at the end of a street of traditional wooden houses in Kyoto',
      focalPoint: '50% 55%',
      tone: '#5a5f66',
      kind: 'photo',
      credit: 'Photo by Leo Bayard on Unsplash',
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
      src: `${PHOTOS}/destination-singapore.webp`,
      alt: 'Singapore’s Marina Bay skyline and observation wheel across the water',
      focalPoint: '50% 45%',
      tone: '#5f7f96',
      kind: 'photo',
      credit: 'Photo by Danny de Groot on Unsplash',
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
      src: `${PHOTOS}/destination-dubai.webp`,
      alt: 'The Burj Khalifa and Dubai’s skyscrapers above a highway interchange at sunset',
      focalPoint: '50% 45%',
      tone: '#a88a80',
      kind: 'photo',
      credit: 'Photo by David Rodrigo on Unsplash',
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
  /** Photographer and source. */
  credit: string;
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
      src: `${PHOTOS}/mood-beach-escapes.webp`,
      alt: 'A quiet sandy cove with rocks and a palm frond on the Karnataka coast',
      focalPoint: '50% 60%',
      tone: '#9aa3a0',
      credit: 'Photo by Shashank Hegade on Unsplash',
    },
    accent: '#f4c9b1',
  },
  {
    slug: 'mountain-retreats',
    title: 'Mountain retreats',
    line: 'Thin air, pine forests and mornings that start above the clouds.',
    image: {
      src: `${PHOTOS}/mood-mountain-retreats.webp`,
      alt: 'Snow-capped Himalayan peaks under a deep blue sky with white clouds',
      focalPoint: '50% 60%',
      tone: '#2f5fa8',
      credit: 'Photo by Jonathan Charles on Unsplash',
    },
    accent: '#dde1f7',
  },
  {
    slug: 'cultural-journeys',
    title: 'Cultural journeys',
    line: 'Old quarters, grand architecture and traditions best explored on foot.',
    image: {
      src: `${PHOTOS}/mood-cultural-cities.webp`,
      alt: 'An ornate brass door set in a carved, arched palace wall in Jaipur',
      focalPoint: '50% 55%',
      tone: '#b9a48a',
      credit: 'Photo by Annie Spratt on Unsplash',
    },
    accent: '#d99aa6',
  },
  {
    slug: 'nature-wellness',
    title: 'Nature & wellness',
    line: 'Green landscapes, slower rhythms and time to properly rest.',
    image: {
      src: `${PHOTOS}/mood-nature-wellness.webp`,
      alt: 'A waterfall seen through green forest leaves',
      focalPoint: '55% 55%',
      tone: '#3f6a3a',
      credit: 'Photo by Varad Parulekar on Unsplash',
    },
    accent: '#cfdcd2',
  },
  {
    slug: 'city-breaks',
    title: 'City breaks',
    line: 'Food streets, skylines and neighbourhoods worth a few full days.',
    image: {
      src: `${PHOTOS}/mood-city-breaks.webp`,
      alt: 'A city at night with lit towers and a highway bridge beside a lake',
      focalPoint: '50% 65%',
      tone: '#1f2233',
      credit: 'Photo by Zoshua Colah on Unsplash',
    },
    accent: '#bcc3ec',
  },
  {
    slug: 'weekend-getaways',
    title: 'Weekend getaways',
    line: 'Two days, one change of scenery, and a route home in time for Monday.',
    image: {
      src: `${PHOTOS}/mood-weekend-getaways.webp`,
      alt: 'An empty road curving through tall trees in the hills near Nainital',
      focalPoint: '50% 60%',
      tone: '#3f5a55',
      credit: 'Photo by Shivansh Singh on Unsplash',
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
