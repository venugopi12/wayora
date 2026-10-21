import { z } from 'zod';

/**
 * Destination discovery contract.
 *
 * Phase 6 ships a curated, bundled SAMPLE dataset (apps/web/src/features/discover/data.ts)
 * that is validated against these schemas in tests. A future discovery API
 * returns the same shape, so the UI does not change when real content arrives.
 *
 * Deliberately absent: prices, fares, availability, ratings, reviews and
 * deals. Those belong to provider-backed inventory contracts, not to
 * editorial destination content.
 */

/** Broad areas used for regional browsing. */
export const destinationRegionSchema = z.enum([
  'india',
  'southeast-asia',
  'east-asia',
  'middle-east',
]);
export type DestinationRegion = z.infer<typeof destinationRegionSchema>;

/** Travel moods (themes) a destination can belong to. */
export const travelMoodSlugSchema = z.enum([
  'beach-escapes',
  'mountain-retreats',
  'cultural-journeys',
  'nature-wellness',
  'city-breaks',
  'weekend-getaways',
]);
export type TravelMoodSlug = z.infer<typeof travelMoodSlugSchema>;

const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase words separated by hyphens');

export const destinationImageSchema = z.object({
  /** Path under the web app's public folder, or an absolute URL once a CDN exists. */
  src: z.string().min(1),
  /** Describes the scene. Required: destination images are informative. */
  alt: z.string().min(1),
  /** CSS object-position, e.g. "55% 40%", so the subject survives responsive crops. */
  focalPoint: z
    .string()
    .regex(/^\d{1,3}% \d{1,3}%$/)
    .optional(),
  /** Dominant colour (#rrggbb) shown while loading or if the file is missing. */
  tone: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .optional(),
  /** `artwork` = original illustration; `photo` requires a credit. */
  kind: z.enum(['artwork', 'photo']),
  /** Source and licence, required for photos. */
  credit: z.string().min(1).optional(),
});
export type DestinationImage = z.infer<typeof destinationImageSchema>;

export const destinationHighlightSchema = z.object({
  title: z.string().min(1).max(60),
  text: z.string().min(1).max(220),
});
export type DestinationHighlight = z.infer<typeof destinationHighlightSchema>;

const destinationObject = z.object({
  id: slugSchema,
  slug: slugSchema,
  name: z.string().min(1),
  country: z.string().min(1),
  /** Regional browsing bucket. */
  region: destinationRegionSchema,
  /** State, prefecture or area shown with the name, e.g. "Rajasthan". */
  locality: z.string().min(1).optional(),
  /** One or two sentences for cards. */
  description: z.string().min(1).max(200),
  /** Editorial introduction for the detail page. */
  intro: z.string().min(1),
  /** "Why it's worth exploring": a few short, experiential points. */
  highlights: z.array(destinationHighlightSchema).min(1).max(4),
  /** Missing image = branded placeholder, never a broken image. */
  image: destinationImageSchema.optional(),
  categories: z.array(travelMoodSlugSchema).min(1),
  featured: z.boolean(),
  /** Extra search terms: older names, airport codes, nearby towns. */
  aliases: z.array(z.string().min(1)).default([]),
  /**
   * Marks bundled demonstration content. Live content from a future API
   * will not carry this flag, so the UI can label sample data honestly.
   */
  sample: z.literal(true).optional(),
});

const photosNeedCredit = {
  check: (d: { image?: DestinationImage }) => d.image?.kind !== 'photo' || Boolean(d.image.credit),
  params: { message: 'Photos need a source and licence credit', path: ['image', 'credit'] },
};

/** A full destination, as shown on its detail page. */
export const destinationSchema = destinationObject.refine(
  photosNeedCredit.check,
  photosNeedCredit.params,
);
export type Destination = z.infer<typeof destinationSchema>;
/** Shape for authoring content (defaults not yet applied). */
export type DestinationInput = z.input<typeof destinationSchema>;

/**
 * What lists, cards and search need: everything except the long-form copy.
 * Lets clients load summaries first and the detail copy on demand.
 */
export const destinationSummarySchema = destinationObject
  .omit({ intro: true, highlights: true })
  .refine(photosNeedCredit.check, photosNeedCredit.params);
export type DestinationSummary = z.infer<typeof destinationSummarySchema>;
export type DestinationSummaryInput = z.input<typeof destinationSummarySchema>;

export const destinationListSchema = z
  .array(destinationSchema)
  .refine((list) => new Set(list.map((d) => d.slug)).size === list.length, {
    message: 'Destination slugs must be unique',
  })
  .refine((list) => new Set(list.map((d) => d.id)).size === list.length, {
    message: 'Destination ids must be unique',
  });
