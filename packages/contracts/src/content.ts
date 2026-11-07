import { z } from 'zod';
import { offsetDateTimeSchema, paginationSchema } from './search/common.js';
import { plainLine, plainText } from './support.js';

/*
 * Editorial content (Phase 29, docs/seo.md#content-model): travel guides,
 * articles, tips, FAQs, editorial collections and promotional landing pages,
 * managed by staff in the admin dashboard.
 *
 * Bodies are structured blocks, never HTML: the web renders each block as an
 * element, so there is nothing to sanitize and no way to inject markup.
 * Images come from Wayora's own media library (no arbitrary URLs).
 * Destinations themselves stay in the code-reviewed dataset; content links
 * to them by slug.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────

export const CONTENT_TYPES = ['guide', 'article', 'tip', 'faq', 'collection', 'landing'] as const;
export const contentTypeSchema = z.enum(CONTENT_TYPES);
export type ContentType = z.infer<typeof contentTypeSchema>;

export const CONTENT_TYPE_LABEL: Record<ContentType, string> = {
  guide: 'Destination guide',
  article: 'Travel article',
  tip: 'Travel tip',
  faq: 'FAQ',
  collection: 'Editorial collection',
  landing: 'Landing page',
};

export const CONTENT_STATUSES = ['draft', 'published', 'archived'] as const;
export const contentStatusSchema = z.enum(CONTENT_STATUSES);
export type ContentStatus = z.infer<typeof contentStatusSchema>;

/** Public URL of a content entry; FAQs have no page of their own (null). */
export function contentPath(type: ContentType, slug: string): string | null {
  switch (type) {
    case 'guide':
    case 'article':
    case 'tip':
      return `/guides/${slug}`;
    case 'collection':
      return `/collections/${slug}`;
    case 'landing':
      return `/explore/${slug}`;
    case 'faq':
      return null;
  }
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const contentSlugSchema = z
  .string()
  .min(3, 'Slugs need at least 3 characters.')
  .max(80, 'Slugs can be at most 80 characters.')
  .regex(SLUG_PATTERN, 'Use lowercase letters, numbers and single hyphens.');

/** "Goa’s Best Beaches — 2026!" → "goas-best-beaches-2026". Never empty-safe: callers check. */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

// ─── Media library ───────────────────────────────────────────────────────

/**
 * The images content may use: Wayora's own artwork (original illustrations,
 * apps/web/scripts/generate-artwork.mjs). Each has a raster social card in
 * /media/og/ for Open Graph. No uploads and no external URLs.
 */
const DESTINATION_ART = [
  'goa',
  'jaipur',
  'kerala',
  'manali',
  'bengaluru',
  'hyderabad',
  'mumbai',
  'delhi',
  'bali',
  'kyoto',
  'singapore',
  'dubai',
] as const;
export const MEDIA_KEYS = DESTINATION_ART.map((d) => `destination-${d}` as const);
export const mediaKeySchema = z.enum(MEDIA_KEYS as [string, ...string[]]);
export type MediaKey = (typeof MEDIA_KEYS)[number];

export interface MediaAsset {
  key: string;
  src: string;
  width: number;
  height: number;
  /** 1200×630 JPEG for social previews. */
  og: string;
}
export function mediaAsset(key: string): MediaAsset | null {
  if (!(MEDIA_KEYS as readonly string[]).includes(key)) return null;
  return {
    key,
    src: `/media/artwork/${key}.svg`,
    width: 1600,
    height: 1200,
    og: `/media/og/${key}.jpg`,
  };
}

// ─── Body blocks ─────────────────────────────────────────────────────────

const para = plainText(1, 2000, 'Paragraph');
export const contentBlockSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('heading'),
      level: z.union([z.literal(2), z.literal(3)]),
      text: plainLine(2, 120, 'Heading'),
    })
    .strict(),
  z.object({ type: z.literal('paragraph'), text: para }).strict(),
  z
    .object({
      type: z.literal('list'),
      style: z.enum(['bullet', 'number']),
      items: z
        .array(plainLine(1, 300, 'List item'))
        .min(1)
        .max(20),
    })
    .strict(),
  /** A practical tip, highlighted. */
  z.object({ type: z.literal('tip'), text: plainText(1, 600, 'Tip') }).strict(),
  /** A rule set by an airline, hotel, operator or government, not by Wayora. */
  z.object({ type: z.literal('provider'), text: plainText(1, 600, 'Provider note') }).strict(),
  z
    .object({
      type: z.literal('image'),
      media: mediaKeySchema,
      alt: plainLine(5, 200, 'Alt text'),
      caption: plainLine(1, 200, 'Caption').nullable().default(null),
    })
    .strict(),
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

/** Words in the visible text of the blocks (headings, paragraphs, lists, notes, captions). */
export function wordCount(blocks: readonly ContentBlock[], extra: string[] = []): number {
  const text = [
    ...extra,
    ...blocks.flatMap((b) =>
      b.type === 'list' ? b.items : b.type === 'image' ? [b.caption ?? ''] : [b.text],
    ),
  ].join(' ');
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Minutes at 200 words a minute, rounded up (at least 1). Shown for guides, articles and tips. */
export const readingMinutes = (words: number) => Math.max(1, Math.ceil(words / 200));

// ─── Editing ─────────────────────────────────────────────────────────────

export const contentInputSchema = z
  .object({
    type: contentTypeSchema,
    slug: contentSlugSchema,
    /** For FAQs: the question. */
    title: plainLine(5, 120, 'The title'),
    /** Introduction (shown first, and in lists). For FAQs, empty. */
    summary: plainText(0, 400, 'The introduction'),
    body: z.array(contentBlockSchema).max(80, 'At most 80 blocks.'),
    cover: z
      .object({ media: mediaKeySchema, alt: plainLine(5, 200, 'Cover alt text') })
      .strict()
      .nullable()
      .default(null),
    /** Overrides the title in search results and social cards (≤ 60). */
    seoTitle: plainLine(0, 60, 'The SEO title').nullable().default(null),
    metaDescription: plainText(0, 160, 'The meta description').nullable().default(null),
    /** Destination slugs this content is about or features. */
    destinations: z.array(z.string().regex(SLUG_PATTERN)).max(12).default([]),
    /** Other content (by slug) to link to. */
    related: z.array(contentSlugSchema).max(6).default([]),
  })
  .strict();
export type ContentInput = z.input<typeof contentInputSchema>;
export type ContentFields = z.output<typeof contentInputSchema>;

export const contentUpdateSchema = contentInputSchema
  .omit({ type: true })
  .extend({ revision: z.number().int().min(1) })
  .strict();
export type ContentUpdate = z.input<typeof contentUpdateSchema>;

export const contentStatusChangeSchema = z
  .object({
    action: z.enum(['publish', 'archive', 'restore']),
    revision: z.number().int().min(1),
  })
  .strict();

const MIN_WORDS: Partial<Record<ContentType, number>> = {
  guide: 300,
  article: 300,
  tip: 80,
  faq: 20,
  landing: 100,
};

export interface PublishProblem {
  field: string;
  message: string;
}

/**
 * What stops an entry from being published (docs/seo.md#cms-workflow):
 * enough real content (no thin pages), a meta description, a sound heading
 * order and type-specific needs. The server also checks that linked
 * destinations exist and related content is published.
 */
export function publishProblems(e: ContentFields): PublishProblem[] {
  const problems: PublishProblem[] = [];
  const words = wordCount(e.body, [e.summary]);
  const min = MIN_WORDS[e.type];
  if (min && words < min) {
    problems.push({
      field: 'body',
      message: `Needs at least ${min} words to publish (has ${words}).`,
    });
  }
  const meta = e.metaDescription?.trim() ?? '';
  if (e.type !== 'faq' && (meta.length < 50 || meta.length > 160)) {
    problems.push({
      field: 'metaDescription',
      message: 'Write a meta description of 50–160 characters.',
    });
  }
  if (e.type !== 'faq' && e.summary.trim().length < 40) {
    problems.push({
      field: 'summary',
      message: 'Write an introduction of at least 40 characters.',
    });
  }
  let seenH2 = false;
  for (const [i, b] of e.body.entries()) {
    if (b.type !== 'heading') continue;
    if (b.level === 2) seenH2 = true;
    else if (!seenH2) {
      problems.push({
        field: `body.${i}`,
        message: 'A level-3 heading needs a level-2 heading before it.',
      });
    }
  }
  if (e.type === 'collection' && e.destinations.length + e.related.length < 2) {
    problems.push({
      field: 'destinations',
      message: 'A collection needs at least two destinations or entries.',
    });
  }
  if (e.type === 'landing' && e.destinations.length === 0) {
    problems.push({
      field: 'destinations',
      message: 'A landing page needs at least one destination.',
    });
  }
  if (e.type === 'faq' && e.destinations.length === 0) {
    problems.push({
      field: 'destinations',
      message: 'An FAQ needs the destination it answers for.',
    });
  }
  if (e.related.includes(e.slug)) {
    problems.push({ field: 'related', message: 'An entry can’t be related to itself.' });
  }
  return problems;
}

// ─── Public responses ────────────────────────────────────────────────────

const imageOut = z.object({
  src: z.string(),
  alt: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  og: z.string(),
});

export const contentLinkSchema = z.object({
  type: contentTypeSchema,
  slug: z.string(),
  path: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
});
export type ContentLink = z.infer<typeof contentLinkSchema>;

/** A published entry as anyone sees it. */
export const publicContentSchema = z.object({
  type: contentTypeSchema,
  slug: z.string(),
  path: z.string().nullable(),
  title: z.string(),
  seoTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  summary: z.string(),
  body: z.array(contentBlockSchema),
  cover: imageOut.nullable(),
  destinations: z.array(z.string()),
  related: z.array(contentLinkSchema),
  /** The staff author's first name and initial; their role, never an email. */
  author: z.string(),
  publishedAt: offsetDateTimeSchema,
  /** When the published content last changed. */
  updatedAt: offsetDateTimeSchema,
  wordCount: z.number().int(),
  /** For guides, articles and tips; null otherwise. */
  readingMinutes: z.number().int().nullable(),
});
export type PublicContent = z.infer<typeof publicContentSchema>;

export const publicContentListQuerySchema = z
  .object({
    type: z.enum(['guide', 'article', 'tip', 'faq', 'collection', 'landing', 'guides']).optional(),
    destination: z.string().regex(SLUG_PATTERN).optional(),
    page: z.coerce.number().int().min(1).max(200).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(12),
  })
  .strict();
export type PublicContentListQuery = z.input<typeof publicContentListQuerySchema>;

export const publicContentListSchema = z.object({
  /** Without bodies, except for FAQs (the answer is shown where the question is listed). */
  items: z.array(
    publicContentSchema
      .omit({ body: true })
      .extend({ body: z.array(contentBlockSchema).optional() }),
  ),
  pagination: paginationSchema,
});
export type PublicContentList = z.infer<typeof publicContentListSchema>;

/** Every published page, for the web build (prerender and sitemap). */
export const contentFeedSchema = z.object({
  items: z.array(publicContentSchema),
  generatedAt: offsetDateTimeSchema,
});
export type ContentFeed = z.infer<typeof contentFeedSchema>;

// ─── Admin ───────────────────────────────────────────────────────────────

export const adminContentListQuerySchema = z
  .object({
    status: contentStatusSchema.optional(),
    type: contentTypeSchema.optional(),
    q: z.string().trim().max(80).optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type AdminContentListQuery = z.input<typeof adminContentListQuerySchema>;

export const adminContentSummarySchema = z.object({
  id: z.uuid(),
  type: contentTypeSchema,
  slug: z.string(),
  path: z.string().nullable(),
  title: z.string(),
  status: contentStatusSchema,
  revision: z.number().int(),
  author: z.string(),
  editor: z.string(),
  createdAt: offsetDateTimeSchema,
  updatedAt: offsetDateTimeSchema,
  publishedAt: offsetDateTimeSchema.nullable(),
  /** Page views in the last 30 days (first-party daily totals). */
  views30d: z.number().int(),
});
export type AdminContentSummary = z.infer<typeof adminContentSummarySchema>;

export const adminContentListSchema = z.object({
  items: z.array(adminContentSummarySchema),
  pagination: paginationSchema,
});
export type AdminContentList = z.infer<typeof adminContentListSchema>;

export const adminContentSchema = adminContentSummarySchema.extend({
  fields: contentInputSchema.extend({ type: contentTypeSchema }),
  /** What blocks publishing right now (empty: publishable). */
  problems: z.array(z.object({ field: z.string(), message: z.string() })),
  firstPublishedAt: offsetDateTimeSchema.nullable(),
  archivedAt: offsetDateTimeSchema.nullable(),
  revisions: z.array(
    z.object({
      revision: z.number().int(),
      status: contentStatusSchema,
      title: z.string(),
      editor: z.string(),
      note: z.string().nullable(),
      createdAt: offsetDateTimeSchema,
    }),
  ),
  /** The published view, for the preview (built from the current fields). */
  preview: publicContentSchema,
  allowed: z.object({ edit: z.boolean(), publish: z.boolean() }),
});
export type AdminContent = z.infer<typeof adminContentSchema>;

// ─── First-party analytics (docs/seo.md#analytics) ───────────────────────

export const ANALYTICS_EVENTS = [
  'destination_view',
  'content_view',
  /** From a destination page to a travel search. */
  'destination_search_click',
  /** From content to another page (destination, guide, search). */
  'content_link_click',
] as const;
export const analyticsEventSchema = z
  .object({
    event: z.enum(ANALYTICS_EVENTS),
    /** A destination slug, a content slug, or `<destination>:<service>` for search clicks. */
    key: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9-]+)?$/, 'Not a valid key.'),
  })
  .strict();
export type AnalyticsEvent = z.infer<typeof analyticsEventSchema>;

/** Destinations with the most page views (only when there's enough data). */
export const popularDestinationsSchema = z.object({
  basis: z.literal('destination_page_views'),
  days: z.number().int(),
  /** Each listed destination had at least this many views. */
  minimumViews: z.number().int(),
  items: z.array(z.object({ slug: z.string() })),
});
export type PopularDestinations = z.infer<typeof popularDestinationsSchema>;

export const contentStatsSchema = z.object({
  days: z.number().int(),
  totals: z.array(z.object({ event: z.enum(ANALYTICS_EVENTS), count: z.number().int() })),
  topDestinations: z.array(z.object({ key: z.string(), count: z.number().int() })),
  topContent: z.array(z.object({ key: z.string(), count: z.number().int() })),
  searchClicks: z.array(z.object({ key: z.string(), count: z.number().int() })),
});
export type ContentStats = z.infer<typeof contentStatsSchema>;
