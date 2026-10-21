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
 * `planned` – architecture boundary exists, no booking flow yet.
 * `beta`/`live` are reserved for later phases.
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

/**
 * Source of truth for the Phase 1 catalog. Served by the API and bundled into
 * the web app as an offline fallback. No booking functionality is implied.
 */
export const TRAVEL_CATEGORIES: readonly TravelCategory[] = [
  {
    slug: 'flights',
    name: 'Flights',
    tagline: 'Domestic and international air travel',
    description: 'Fare search, seat selection and e-ticketing across carriers.',
    availability: 'planned',
  },
  {
    slug: 'hotels',
    name: 'Hotels',
    tagline: 'Stays from boutique to business',
    description: 'Room inventory, rate plans and instant confirmation.',
    availability: 'planned',
  },
  {
    slug: 'trains',
    name: 'Trains',
    tagline: 'Intercity and long-distance rail',
    description: 'Seat availability, class selection and PNR tracking.',
    availability: 'planned',
  },
  {
    slug: 'buses',
    name: 'Buses',
    tagline: 'Comfortable road journeys',
    description: 'Operator search, seat layouts and boarding points.',
    availability: 'planned',
  },
  {
    slug: 'metro',
    name: 'Metro',
    tagline: 'Fast urban transit',
    description: 'City metro tickets and journey planning.',
    availability: 'planned',
  },
  {
    slug: 'cabs',
    name: 'Cabs',
    tagline: 'Airport transfers and city rides',
    description: 'Point-to-point and hourly rentals with upfront fares.',
    availability: 'planned',
  },
  {
    slug: 'holidays',
    name: 'Holiday packages',
    tagline: 'Curated multi-day journeys',
    description: 'Bundled travel, stays and experiences in one itinerary.',
    availability: 'planned',
  },
] as const;
