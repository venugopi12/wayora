import { z } from 'zod';

/** The seven travel verticals Wayora is designed to support. */
export const travelCategorySlugSchema = z.enum([
  'flights',
  'hotels',
  'trains',
  'buses',
  'metro',
  'cabs',
  'holidays',
]);
export type TravelCategorySlug = z.infer<typeof travelCategorySlugSchema>;

/**
 * - `planned` – no search or booking yet.
 * - `beta`    – demo search only: results come from Wayora's built-in sample
 *               providers, prices are illustrative, nothing can be booked.
 * - `live`    – real supplier inventory and booking (no category is live yet).
 */
export const categoryAvailabilitySchema = z.enum(['planned', 'beta', 'live']);
export type CategoryAvailability = z.infer<typeof categoryAvailabilitySchema>;

export const travelCategorySchema = z.object({
  slug: travelCategorySlugSchema,
  name: z.string().min(1),
  tagline: z.string().min(1),
  description: z.string().min(1),
  availability: categoryAvailabilitySchema,
});
export type TravelCategory = z.infer<typeof travelCategorySchema>;

export const travelCategoryListSchema = z.array(travelCategorySchema);

export const listCategoriesQuerySchema = z
  .object({
    availability: categoryAvailabilitySchema.optional(),
  })
  .strict();
export type ListCategoriesQuery = z.infer<typeof listCategoriesQuerySchema>;

export const categoryParamsSchema = z.object({
  slug: travelCategorySlugSchema,
});

/** Shown wherever a `beta` category is offered, so demo search is never mistaken for booking. */
export const DEMO_SEARCH_NOTICE =
  'Demo search: sample results with illustrative prices. Nothing can be booked yet.';

/**
 * Source of truth for the catalog. Served by the API and bundled into the web
 * app as an offline fallback. Descriptions say only what the category does
 * today (since Phase 9: a demo search); no booking functionality is implied.
 */
export const TRAVEL_CATEGORIES: readonly TravelCategory[] = [
  {
    slug: 'flights',
    name: 'Flights',
    tagline: 'Domestic and international air travel',
    description:
      'Search sample one-way and return flights between five Indian airports, with filters and sorting.',
    availability: 'beta',
  },
  {
    slug: 'hotels',
    name: 'Hotels',
    tagline: 'Stays from boutique to business',
    description:
      'Search sample stays in a few Indian cities, with nightly prices, amenities and filters.',
    availability: 'beta',
  },
  {
    slug: 'trains',
    name: 'Trains',
    tagline: 'Intercity and long-distance rail',
    description: 'Search sample intercity trains, with classes, timings and fares.',
    availability: 'beta',
  },
  {
    slug: 'buses',
    name: 'Buses',
    tagline: 'Comfortable road journeys',
    description: 'Search sample intercity buses, with operators, bus types, timings and fares.',
    availability: 'beta',
  },
  {
    slug: 'metro',
    name: 'Metro',
    tagline: 'Fast urban transit',
    description:
      'Plan sample metro journeys in Bengaluru and Delhi, with line changes and travel times.',
    availability: 'beta',
  },
  {
    slug: 'cabs',
    name: 'Cabs',
    tagline: 'Airport transfers and city rides',
    description:
      'Compare sample airport transfers and city rides, with vehicles, seats and fare estimates.',
    availability: 'beta',
  },
  {
    slug: 'holidays',
    name: 'Holiday packages',
    tagline: 'Curated multi-day journeys',
    description:
      'Browse sample multi-day packages for four destinations, by trip length and interests.',
    availability: 'beta',
  },
] as const;
