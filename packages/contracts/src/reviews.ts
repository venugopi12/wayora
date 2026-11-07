import { z } from 'zod';
import { bookingReferenceSchema } from './bookings.js';
import { isoDateSchema, offsetDateTimeSchema, paginationSchema } from './search/common.js';
import type { SearchResult } from './search/results.js';
import { plainLine, plainText } from './support.js';

/*
 * Reviews, ratings and travel feedback (Phase 28, docs/reviews.md).
 *
 * What can be reviewed is limited to things Wayora can identify reliably:
 *
 * - hotel properties and holiday packages, from a completed booking of
 *   them (the property or package comes from the booking, never the client);
 * - the discover destinations, as unverified traveller feedback.
 *
 * Flights, trains, buses, metro and cabs have no reliable record of the
 * journey actually travelled, so they can't be reviewed.
 *
 * Every booking on Wayora today is a demo booking, so booking reviews are
 * labelled "demo booking", never "verified". `verified_booking` is reserved
 * for completed, supplier-confirmed real bookings, which can't exist yet.
 *
 * The server decides verification, status, aggregates and vote counts; the
 * client never sends them.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────

export const REVIEW_SUBJECT_TYPES = ['hotel', 'holiday_package', 'destination'] as const;
export const reviewSubjectTypeSchema = z.enum(REVIEW_SUBJECT_TYPES);
export type ReviewSubjectType = z.infer<typeof reviewSubjectTypeSchema>;

export const REVIEW_SUBJECT_LABEL: Record<ReviewSubjectType, string> = {
  hotel: 'Hotel',
  holiday_package: 'Holiday package',
  destination: 'Destination',
};

export const REVIEW_STATUSES = ['pending', 'published', 'rejected', 'flagged', 'removed'] as const;
export const reviewStatusSchema = z.enum(REVIEW_STATUSES);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  pending: 'Waiting for moderation',
  published: 'Published',
  rejected: 'Not published',
  flagged: 'Being checked',
  removed: 'Removed',
};

export const REVIEW_VERIFICATIONS = ['verified_booking', 'demo_booking', 'unverified'] as const;
export const reviewVerificationSchema = z.enum(REVIEW_VERIFICATIONS);
export type ReviewVerification = z.infer<typeof reviewVerificationSchema>;

export const REVIEW_VERIFICATION_LABEL: Record<ReviewVerification, string> = {
  verified_booking: 'Verified booking',
  demo_booking: 'Demo booking',
  unverified: 'Not verified',
};

/** Ratings are whole stars, 1 to 5. */
export const RATING_MIN = 1;
export const RATING_MAX = 5;
export const ratingSchema = z
  .number({ error: 'Choose a rating from 1 to 5 stars.' })
  .int('Choose a whole number of stars.')
  .min(RATING_MIN, 'Choose a rating from 1 to 5 stars.')
  .max(RATING_MAX, 'Choose a rating from 1 to 5 stars.');

/** Category ratings ("aspects") each subject type takes; all optional. */
export const REVIEW_ASPECTS = [
  'cleanliness',
  'location',
  'service',
  'comfort',
  'value',
  'experience',
  'organisation',
] as const;
export const reviewAspectSchema = z.enum(REVIEW_ASPECTS);
export type ReviewAspect = z.infer<typeof reviewAspectSchema>;

export const REVIEW_ASPECT_LABEL: Record<ReviewAspect, string> = {
  cleanliness: 'Cleanliness',
  location: 'Location',
  service: 'Service',
  comfort: 'Comfort',
  value: 'Value for money',
  experience: 'Experience',
  organisation: 'Organisation',
};

export const ASPECTS_FOR: Record<ReviewSubjectType, readonly ReviewAspect[]> = {
  hotel: ['cleanliness', 'location', 'service', 'comfort', 'value'],
  holiday_package: ['experience', 'organisation', 'value'],
  destination: [],
};

/** Fewer published reviews than this: counts and the distribution, but no average. */
export const MIN_REVIEWS_FOR_AVERAGE = 3;
/** The same for each category rating. */
export const MIN_ASPECT_RATINGS_FOR_AVERAGE = 3;
/** Authors may edit a review for this many days after writing it. */
export const REVIEW_EDIT_DAYS = 30;

export const REVIEW_TITLE_MIN = 4;
export const REVIEW_TITLE_MAX = 100;
export const REVIEW_BODY_MIN = 30;
export const REVIEW_BODY_MAX = 3000;

export const REPORT_REASONS = [
  'spam',
  'fake_experience',
  'offensive',
  'personal_information',
  'harassment',
  'irrelevant',
  'conflict_of_interest',
  'other',
] as const;
export const reportReasonSchema = z.enum(REPORT_REASONS);
export type ReportReason = z.infer<typeof reportReasonSchema>;

export const REPORT_REASON_LABEL: Record<ReportReason, string> = {
  spam: 'Spam or advertising',
  fake_experience: 'Not a genuine experience',
  offensive: 'Offensive content',
  personal_information: 'Shares personal information',
  harassment: 'Harassment or hate',
  irrelevant: 'Not about this place',
  conflict_of_interest: 'Conflict of interest',
  other: 'Something else',
};

// ─── Subjects ────────────────────────────────────────────────────────────

/** `<providerId>:<ref>` for hotels and packages; a destination slug otherwise. */
export const reviewSubjectKeySchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?$/, 'Not a valid review subject.');

export const reviewSubjectSchema = z
  .object({ type: reviewSubjectTypeSchema, key: reviewSubjectKeySchema })
  .strict();
export type ReviewSubject = z.infer<typeof reviewSubjectSchema>;

/**
 * Providers whose offer references have a known, stable property or package
 * part. Offer references are otherwise opaque, so offers from any other
 * provider aren't reviewable until its adapter declares one.
 */
const STABLE_SUBJECT_REF: Record<
  string,
  { type: ReviewSubjectType; ref: (offerRef: string) => string | null }
> = {
  // `<property>/<checkIn>/<checkOut>/<rooms>` (apps/api/src/modules/providers/demo/hotels.ts)
  'demo-hotels': { type: 'hotel', ref: (r) => firstSegment(r) },
  // `<package>/<departure>` (apps/api/src/modules/providers/demo/holidays.ts)
  'demo-holidays': { type: 'holiday_package', ref: (r) => firstSegment(r) },
};
function firstSegment(offerRef: string): string | null {
  const ref = offerRef.split('/')[0] ?? '';
  return /^[a-z0-9][a-z0-9-]{0,99}$/.test(ref) ? ref : null;
}

/** The reviewable subject of a search result or booked offer, or null if it has none. */
export function reviewSubjectOf(
  result: Pick<SearchResult, 'serviceType' | 'providerId' | 'offerRef'>,
): ReviewSubject | null {
  const known = STABLE_SUBJECT_REF[result.providerId];
  if (!known) return null;
  const expected = known.type === 'hotel' ? 'hotels' : 'holidays';
  if (result.serviceType !== expected) return null;
  const ref = known.ref(result.offerRef);
  return ref ? { type: known.type, key: `${result.providerId}:${ref}` } : null;
}

// ─── Input ───────────────────────────────────────────────────────────────

const aspectsInput = z.partialRecord(reviewAspectSchema, ratingSchema).default({});

const reviewContent = {
  rating: ratingSchema,
  aspects: aspectsInput,
  title: plainLine(REVIEW_TITLE_MIN, REVIEW_TITLE_MAX, 'The title'),
  body: plainText(REVIEW_BODY_MIN, REVIEW_BODY_MAX, 'Your review'),
};

/** A review of a completed booking (hotel or holiday package). */
export const createBookingReviewSchema = z
  .object({
    kind: z.literal('booking'),
    bookingReference: bookingReferenceSchema,
    ...reviewContent,
  })
  .strict();

/** Feedback about a destination: not verified by any booking. */
export const createDestinationReviewSchema = z
  .object({
    kind: z.literal('destination'),
    destination: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Not a valid destination.'),
    /** The month of the visit, if the author wants to say. */
    visitedMonth: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month like 2026-03.')
      .nullable()
      .default(null),
    ...reviewContent,
  })
  .strict();

export const createReviewSchema = z.discriminatedUnion('kind', [
  createBookingReviewSchema,
  createDestinationReviewSchema,
]);
export type CreateReviewInput = z.input<typeof createReviewSchema>;

export const updateReviewSchema = z
  .object({ ...reviewContent, revision: z.number().int().min(1) })
  .strict();
export type UpdateReviewInput = z.input<typeof updateReviewSchema>;

export const reportReviewSchema = z
  .object({
    reason: reportReasonSchema,
    details: plainText(0, 500, 'Details').nullable().default(null),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.reason === 'other' && (v.details ?? '').length < 10) {
      ctx.addIssue({
        code: 'custom',
        path: ['details'],
        message: 'Tell us what’s wrong (at least 10 characters).',
      });
    }
  });
export type ReportReviewInput = z.input<typeof reportReviewSchema>;

export const REVIEW_SORTS = ['recent', 'highest', 'lowest', 'helpful'] as const;
export const reviewSortSchema = z.enum(REVIEW_SORTS);
export type ReviewSort = z.infer<typeof reviewSortSchema>;

export const reviewListQuerySchema = z
  .object({
    type: reviewSubjectTypeSchema,
    key: reviewSubjectKeySchema,
    sort: reviewSortSchema.default('recent'),
    rating: z.coerce.number().int().min(RATING_MIN).max(RATING_MAX).optional(),
    page: z.coerce.number().int().min(1).max(500).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict();
export type ReviewListQuery = z.input<typeof reviewListQuerySchema>;

export const reviewIdParamsSchema = z.object({ id: z.uuid({ error: 'Not a valid review.' }) });

// ─── Responses ───────────────────────────────────────────────────────────

const aspectRatings = z.partialRecord(reviewAspectSchema, z.number().int().min(1).max(5));

/** A published review as everyone sees it: no account ids, emails or booking references. */
export const publicReviewSchema = z.object({
  id: z.uuid(),
  subject: reviewSubjectSchema,
  /** First name and last initial, or "Wayora traveller". */
  author: z.string(),
  verification: reviewVerificationSchema,
  rating: z.number().int().min(1).max(5),
  aspects: aspectRatings,
  title: z.string(),
  /** Plain text: render as text, never as HTML. */
  body: z.string(),
  /** The stay or trip dates, for booking reviews. */
  travelled: z.object({ from: isoDateSchema, to: isoDateSchema.nullable() }).nullable(),
  /** The visit month, for destination feedback (YYYY-MM). */
  visitedMonth: z.string().nullable(),
  publishedAt: offsetDateTimeSchema,
  /** Whether the author changed it after writing it. */
  edited: z.boolean(),
  helpful: z.number().int().min(0),
  /** For the signed-in viewer only. */
  viewer: z
    .object({ own: z.boolean(), votedHelpful: z.boolean(), reported: z.boolean() })
    .nullable(),
});
export type PublicReview = z.infer<typeof publicReviewSchema>;

export const ratingSummarySchema = z.object({
  subject: reviewSubjectSchema,
  /** Published reviews counted (see docs/reviews.md#ratings). */
  count: z.number().int().min(0),
  /** One decimal; null below MIN_REVIEWS_FOR_AVERAGE. */
  average: z.number().nullable(),
  /** Published reviews per star, 1 to 5. */
  distribution: z.tuple([
    z.number().int(),
    z.number().int(),
    z.number().int(),
    z.number().int(),
    z.number().int(),
  ]),
  aspects: z.array(
    z.object({
      aspect: reviewAspectSchema,
      count: z.number().int().min(0),
      average: z.number().nullable(),
    }),
  ),
  byVerification: z.object({
    verified_booking: z.number().int(),
    demo_booking: z.number().int(),
    unverified: z.number().int(),
  }),
  minimumForAverage: z.number().int(),
});
export type RatingSummary = z.infer<typeof ratingSummarySchema>;

export const reviewListSchema = z.object({
  summary: ratingSummarySchema,
  items: z.array(publicReviewSchema),
  pagination: paginationSchema,
});
export type ReviewList = z.infer<typeof reviewListSchema>;

/** The author's own review, whatever its status. */
export const ownReviewSchema = publicReviewSchema.omit({ publishedAt: true, viewer: true }).extend({
  subjectName: z.string(),
  status: reviewStatusSchema,
  /** Why it wasn't published, or was removed (the moderator's words). */
  moderationNote: z.string().nullable(),
  bookingReference: bookingReferenceSchema.nullable(),
  revision: z.number().int(),
  createdAt: offsetDateTimeSchema,
  updatedAt: offsetDateTimeSchema,
  publishedAt: offsetDateTimeSchema.nullable(),
  /** Until when the author may still edit; null when editing isn't possible. */
  editableUntil: offsetDateTimeSchema.nullable(),
});
export type OwnReview = z.infer<typeof ownReviewSchema>;

export const ownReviewListSchema = z.object({
  items: z.array(ownReviewSchema),
  pagination: paginationSchema,
});
export type OwnReviewList = z.infer<typeof ownReviewListSchema>;

/** Whether a booking can be reviewed now, and why not. */
export const bookingReviewStateSchema = z.object({
  bookingReference: bookingReferenceSchema,
  subject: reviewSubjectSchema.nullable(),
  subjectName: z.string().nullable(),
  /** `reviewed`: already has a review (see reviewId). */
  state: z.enum(['eligible', 'reviewed', 'not_yet', 'not_eligible']),
  reason: z.string().nullable(),
  /** From when it can be reviewed (the day after the stay or trip ends). */
  eligibleFrom: isoDateSchema.nullable(),
  verification: reviewVerificationSchema.nullable(),
  reviewId: z.uuid().nullable(),
});
export type BookingReviewState = z.infer<typeof bookingReviewStateSchema>;

export const reviewableBookingListSchema = z.object({
  items: z.array(bookingReviewStateSchema),
});

export const destinationReviewStateSchema = z.object({
  destination: z.string(),
  name: z.string(),
  reviewId: z.uuid().nullable(),
});
export type DestinationReviewState = z.infer<typeof destinationReviewStateSchema>;

// ─── Admin ───────────────────────────────────────────────────────────────

export const MODERATION_ACTIONS = ['publish', 'reject', 'flag', 'remove'] as const;
export const moderationActionSchema = z.enum(MODERATION_ACTIONS);
export type ModerationAction = z.infer<typeof moderationActionSchema>;

/** Which statuses each action may start from. `remove` needs admin.reviews.remove. */
export const MODERATION_FROM: Record<ModerationAction, readonly ReviewStatus[]> = {
  publish: ['pending', 'flagged', 'rejected'],
  reject: ['pending', 'flagged'],
  flag: ['pending', 'published'],
  remove: ['pending', 'published', 'rejected', 'flagged'],
};
export const MODERATION_TO: Record<ModerationAction, ReviewStatus> = {
  publish: 'published',
  reject: 'rejected',
  flag: 'flagged',
  remove: 'removed',
};
export const canModerate = (action: ModerationAction, from: ReviewStatus) =>
  MODERATION_FROM[action].includes(from);

export const moderateReviewSchema = z
  .object({
    action: moderationActionSchema,
    /** Required except for publishing. Shown to the author for reject and remove. */
    reason: plainLine(0, 300, 'The reason').nullable().default(null),
    revision: z.number().int().min(1),
    /** Close the review's open reports as handled by this decision. */
    resolveReports: z.boolean().default(true),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.action !== 'publish' && (v.reason ?? '').length < 5) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'Give a reason (at least 5 characters).',
      });
    }
  });
export type ModerateReviewInput = z.input<typeof moderateReviewSchema>;

export const dismissReportsSchema = z
  .object({ reason: plainLine(5, 300, 'The reason'), revision: z.number().int().min(1) })
  .strict();

export const adminReviewListQuerySchema = z
  .object({
    status: reviewStatusSchema.optional(),
    type: reviewSubjectTypeSchema.optional(),
    verification: reviewVerificationSchema.optional(),
    /** Only reviews with open reports. */
    reported: z.enum(['true', 'false']).optional(),
    rating: z.coerce.number().int().min(1).max(5).optional(),
    /** Subject name or key, or review title. */
    q: z.string().trim().max(80).optional(),
    sort: z.enum(['oldest', 'newest', 'reports']).default('oldest'),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type AdminReviewListQuery = z.input<typeof adminReviewListQuerySchema>;

export const adminReviewSummarySchema = z.object({
  id: z.uuid(),
  subject: reviewSubjectSchema,
  subjectName: z.string(),
  status: reviewStatusSchema,
  verification: reviewVerificationSchema,
  rating: z.number().int(),
  title: z.string(),
  author: z.string(),
  openReports: z.number().int(),
  revision: z.number().int(),
  createdAt: offsetDateTimeSchema,
  updatedAt: offsetDateTimeSchema,
});
export type AdminReviewSummary = z.infer<typeof adminReviewSummarySchema>;

export const adminReviewListSchema = z.object({
  items: z.array(adminReviewSummarySchema),
  pagination: paginationSchema,
});
export type AdminReviewList = z.infer<typeof adminReviewListSchema>;

export const adminReviewSchema = adminReviewSummarySchema.extend({
  authorId: z.uuid(),
  aspects: aspectRatings,
  body: z.string(),
  bookingReference: bookingReferenceSchema.nullable(),
  /** The linked booking's status now (a review counts only while it's confirmed). */
  bookingStatus: z.string().nullable(),
  travelled: publicReviewSchema.shape.travelled,
  visitedMonth: z.string().nullable(),
  helpful: z.number().int(),
  publishedAt: offsetDateTimeSchema.nullable(),
  moderationNote: z.string().nullable(),
  revisions: z.array(
    z.object({
      revision: z.number().int(),
      rating: z.number().int(),
      aspects: aspectRatings,
      title: z.string(),
      body: z.string(),
      createdAt: offsetDateTimeSchema,
    }),
  ),
  history: z.array(
    z.object({
      at: offsetDateTimeSchema,
      actor: z.object({ kind: z.enum(['author', 'staff', 'system']), name: z.string() }),
      event: z.enum(['submitted', 'edited', 'moderated', 'reports_dismissed']),
      from: reviewStatusSchema.nullable(),
      to: reviewStatusSchema.nullable(),
      reason: z.string().nullable(),
    }),
  ),
  /** Reporter identities are never shown, even to staff. */
  reports: z.array(
    z.object({
      id: z.uuid(),
      reason: reportReasonSchema,
      details: z.string().nullable(),
      status: z.enum(['open', 'actioned', 'dismissed']),
      createdAt: offsetDateTimeSchema,
      resolvedAt: offsetDateTimeSchema.nullable(),
    }),
  ),
  allowed: z.object({
    actions: z.array(moderationActionSchema),
    dismissReports: z.boolean(),
    /** Staff can't moderate their own reviews. */
    ownReview: z.boolean(),
  }),
});
export type AdminReview = z.infer<typeof adminReviewSchema>;

export const reviewMetricsQuerySchema = z
  .object({ range: z.enum(['7d', '30d', '90d']).default('30d') })
  .strict();
export type ReviewMetricsRange = z.infer<typeof reviewMetricsQuerySchema>['range'];

export const reviewMetricsSchema = z.object({
  range: z.enum(['7d', '30d', '90d']),
  generatedAt: offsetDateTimeSchema,
  /** Current counts, all time. */
  byStatus: z.record(reviewStatusSchema, z.number().int()),
  /** Published reviews by verification. */
  publishedByVerification: z.record(reviewVerificationSchema, z.number().int()),
  openReports: z.number().int(),
  reviewsWithOpenReports: z.number().int(),
  /** Waiting for moderation: oldest first. */
  pending: z.object({
    count: z.number().int(),
    oldestAt: offsetDateTimeSchema.nullable(),
    olderThan48h: z.number().int(),
  }),
  /** Published reviews per star (all subjects). */
  distribution: ratingSummarySchema.shape.distribution,
  /** Reviews written per day in the range (India dates). */
  submissions: z.array(z.object({ day: isoDateSchema, count: z.number().int() })),
  /** Moderation decisions in the range, per moderator. */
  moderators: z.array(
    z.object({ name: z.string(), decisions: z.number().int(), published: z.number().int() }),
  ),
});
export type ReviewMetrics = z.infer<typeof reviewMetricsSchema>;

export const adminReviewSubjectsQuerySchema = z
  .object({
    type: reviewSubjectTypeSchema.optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const adminReviewSubjectsSchema = z.object({
  items: z.array(
    z.object({
      subject: reviewSubjectSchema,
      subjectName: z.string(),
      published: z.number().int(),
      average: z.number().nullable(),
      pending: z.number().int(),
      flagged: z.number().int(),
    }),
  ),
  pagination: paginationSchema,
});
export type AdminReviewSubjects = z.infer<typeof adminReviewSubjectsSchema>;
