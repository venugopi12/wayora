import { z } from 'zod';
import { currencyCodeSchema } from './money.js';
import { searchServiceTypeSchema } from './search/common.js';

/*
 * Analytics and business insights (Phase 31, docs/analytics.md).
 *
 * Event definitions, the shared report query (date range, granularity) and
 * the report shapes. Every figure is computed on the server from recorded
 * data; null always means "not available" (not tracked yet, nothing to
 * divide by, or not shown to this role), never zero.
 */

// ─── Events ──────────────────────────────────────────────────────────────

/**
 * Where each event is recorded (docs/analytics.md#event-catalogue):
 * - `trigger`: a database trigger on the authoritative row, in the same transaction
 * - `api`: the API, after the request it describes, best effort and idempotent
 * - `client`: the web app (behavioural only; never when the visitor declined tracking)
 * - `search_events`: one row per search request (Phase 15, extended in Phase 31)
 * - `content_counts`: cookieless daily totals (Phase 29)
 */
export type AnalyticsEventSourceKind =
  'trigger' | 'api' | 'client' | 'search_events' | 'content_counts';

export interface AnalyticsEventDefinition {
  group: 'user' | 'search' | 'booking' | 'payment' | 'engagement';
  recordedBy: AnalyticsEventSourceKind;
  /** Business-critical: authoritative, deduplicated by entity, never client-side. */
  critical: boolean;
  description: string;
}

export const ANALYTICS_EVENT_DEFINITIONS = {
  'user.registered': {
    group: 'user',
    recordedBy: 'trigger',
    critical: true,
    description: 'A customer account was created.',
  },
  'user.login': {
    group: 'user',
    recordedBy: 'api',
    critical: false,
    description: 'A customer signed in with their password (one per new session).',
  },
  'user.logout': {
    group: 'user',
    recordedBy: 'api',
    critical: false,
    description: 'A customer signed out (one per session).',
  },
  'user.active': {
    group: 'user',
    recordedBy: 'api',
    critical: false,
    description:
      'A signed-in customer used Wayora on a reporting day (at most one per customer per day; automatic polling excluded).',
  },
  'user.profile_completed': {
    group: 'user',
    recordedBy: 'trigger',
    critical: false,
    description: 'The profile had a name and at least one saved traveller for the first time.',
  },
  'search.initiated': {
    group: 'search',
    recordedBy: 'search_events',
    critical: false,
    description: 'A search request reached the API (every row of search_events).',
  },
  'search.completed': {
    group: 'search',
    recordedBy: 'search_events',
    critical: false,
    description: 'A search returned results (outcome success or partial).',
  },
  'search.no_results': {
    group: 'search',
    recordedBy: 'search_events',
    critical: false,
    description: 'A search answered with no matching results (outcome empty).',
  },
  'search.filter_applied': {
    group: 'search',
    recordedBy: 'search_events',
    critical: false,
    description: 'A search request used one or more filters (field names only).',
  },
  'search.sort_applied': {
    group: 'search',
    recordedBy: 'search_events',
    critical: false,
    description: 'A search request asked for a sort order.',
  },
  'offer.viewed': {
    group: 'search',
    recordedBy: 'api',
    critical: false,
    description: 'An offer page loaded one result of a search (once per search and offer).',
  },
  'offer.selected': {
    group: 'search',
    recordedBy: 'client',
    critical: false,
    description: 'The visitor chose to book an offer (once per search and offer).',
  },
  'booking.initiated': {
    group: 'booking',
    recordedBy: 'api',
    critical: false,
    description: 'A booking was submitted (once per Idempotency-Key), whether or not it succeeded.',
  },
  'booking.created': {
    group: 'booking',
    recordedBy: 'trigger',
    critical: true,
    description: 'A booking record was created.',
  },
  'reservation.confirmed': {
    group: 'booking',
    recordedBy: 'trigger',
    critical: true,
    description: 'The supplier confirmed a reservation (real supplier bookings only).',
  },
  'reservation.failed': {
    group: 'booking',
    recordedBy: 'trigger',
    critical: true,
    description: 'The supplier reservation failed (real supplier bookings only).',
  },
  'booking.cancelled': {
    group: 'booking',
    recordedBy: 'trigger',
    critical: true,
    description: 'A booking was cancelled.',
  },
  'payment.initiated': {
    group: 'payment',
    recordedBy: 'trigger',
    critical: true,
    description: 'A payment attempt was created.',
  },
  'payment.succeeded': {
    group: 'payment',
    recordedBy: 'trigger',
    critical: true,
    description: 'A payment attempt succeeded (a demo payment moves no money).',
  },
  'payment.failed': {
    group: 'payment',
    recordedBy: 'trigger',
    critical: true,
    description: 'A payment attempt failed.',
  },
  'refund.initiated': {
    group: 'payment',
    recordedBy: 'trigger',
    critical: true,
    description: 'A refund was created (required or requested; not yet money returned).',
  },
  'refund.completed': {
    group: 'payment',
    recordedBy: 'trigger',
    critical: true,
    description: 'A refund succeeded.',
  },
  'destination.viewed': {
    group: 'engagement',
    recordedBy: 'content_counts',
    critical: false,
    description: 'A destination page was viewed (daily total, no visitor identity).',
  },
  'guide.viewed': {
    group: 'engagement',
    recordedBy: 'content_counts',
    critical: false,
    description: 'A guide, article or other content page was viewed (daily total).',
  },
  'coupon.applied': {
    group: 'engagement',
    recordedBy: 'trigger',
    critical: true,
    description: 'A coupon code was accepted for a booking (applied is not redeemed).',
  },
  'rewards.redeemed': {
    group: 'engagement',
    recordedBy: 'trigger',
    critical: true,
    description: 'Points or travel credit were used by a successful payment.',
  },
  'support.ticket_created': {
    group: 'engagement',
    recordedBy: 'trigger',
    critical: true,
    description: 'A support ticket was opened.',
  },
  'review.submitted': {
    group: 'engagement',
    recordedBy: 'trigger',
    critical: true,
    description: 'A review was submitted (published or not).',
  },
} as const satisfies Record<string, AnalyticsEventDefinition>;

export type AnalyticsEventType = keyof typeof ANALYTICS_EVENT_DEFINITIONS;
export const ANALYTICS_EVENT_TYPES = Object.keys(
  ANALYTICS_EVENT_DEFINITIONS,
) as AnalyticsEventType[];

/** Event types stored in analytics_events (the others live in search_events or content counts). */
export const STORED_EVENT_TYPES = ANALYTICS_EVENT_TYPES.filter((t) => {
  const by = ANALYTICS_EVENT_DEFINITIONS[t].recordedBy;
  return by === 'trigger' || by === 'api' || by === 'client';
});

/**
 * Behavioural events the web app may send (POST /analytics/interactions).
 * Only `offer.selected`: everything else is recorded on the server.
 */
export const analyticsInteractionSchema = z
  .object({
    type: z.literal('offer.selected'),
    serviceType: searchServiceTypeSchema,
    searchId: z.uuid(),
    offerId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\x21-\x7e]+$/, 'Not a valid offer id.'),
  })
  .strict();
export type AnalyticsInteraction = z.infer<typeof analyticsInteractionSchema>;

export const analyticsInteractionsSchema = z
  .object({ events: z.array(analyticsInteractionSchema).min(1).max(10) })
  .strict();
export type AnalyticsInteractions = z.infer<typeof analyticsInteractionsSchema>;

// ─── Report query ────────────────────────────────────────────────────────

export const ANALYTICS_PRESETS = [
  'today',
  'last_7_days',
  'last_30_days',
  'this_month',
  'last_month',
  'custom',
] as const;
export const analyticsPresetSchema = z.enum(ANALYTICS_PRESETS);
export type AnalyticsPreset = z.infer<typeof analyticsPresetSchema>;

export const analyticsGranularitySchema = z.enum(['day', 'week', 'month']);
export type AnalyticsGranularity = z.infer<typeof analyticsGranularitySchema>;

/** The longest range a report covers (custom ranges). */
export const ANALYTICS_MAX_DAYS = 366;

const localDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

/**
 * A reporting period. Days are calendar days in the reporting timezone
 * (docs/analytics.md#timezone); `to` is inclusive. Calendar checks against
 * "today" happen on the server, which knows the timezone.
 */
export const analyticsQuerySchema = z
  .object({
    preset: analyticsPresetSchema.default('last_30_days'),
    from: localDay.optional(),
    to: localDay.optional(),
    /** Defaults by length: day up to 62 days, week up to 186, month beyond. */
    granularity: analyticsGranularitySchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.preset === 'custom') {
      if (!v.from)
        ctx.addIssue({ code: 'custom', path: ['from'], message: 'Choose a start date.' });
      if (!v.to) ctx.addIssue({ code: 'custom', path: ['to'], message: 'Choose an end date.' });
    } else if (v.from || v.to) {
      ctx.addIssue({
        code: 'custom',
        path: ['preset'],
        message: 'Dates go with the custom range only.',
      });
    }
  });
export type AnalyticsQuery = z.input<typeof analyticsQuerySchema>;

export const ANALYTICS_REPORTS = [
  'overview',
  'revenue',
  'funnel',
  'search',
  'customers',
  'providers',
  'marketing',
  'support',
] as const;
export const analyticsReportSchema = z.enum(ANALYTICS_REPORTS);
export type AnalyticsReport = z.infer<typeof analyticsReportSchema>;

// ─── Shared shapes ───────────────────────────────────────────────────────

export const analyticsPeriodSchema = z.object({
  /** First and last local day (inclusive). */
  from: localDay,
  to: localDay,
  /** The exact instants covered: [start, end). `end` is "now" for a period that hasn't ended. */
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  days: z.number().int().min(1),
  /** The period includes today, so its figures can still change. */
  partial: z.boolean(),
});
export type AnalyticsPeriod = z.infer<typeof analyticsPeriodSchema>;

export const reportMetaSchema = z.object({
  timezone: z.string(),
  period: analyticsPeriodSchema,
  /** The comparison period: the same number of days immediately before. */
  previous: analyticsPeriodSchema,
  granularity: analyticsGranularitySchema,
  generatedAt: z.iso.datetime(),
});
export type ReportMeta = z.infer<typeof reportMetaSchema>;

/** A count or rate with its comparison value. null = not available. */
export const comparedSchema = z.object({
  value: z.number().nullable(),
  previous: z.number().nullable(),
});
export type Compared = z.infer<typeof comparedSchema>;

const minor = z.string().regex(/^-?(0|[1-9]\d*)$/);

/** An amount in one currency with its comparison value (minor units, strings). */
export const comparedMoneySchema = z.object({
  currency: currencyCodeSchema,
  amountMinor: minor,
  previousMinor: minor.nullable(),
});
export type ComparedMoney = z.infer<typeof comparedMoneySchema>;

/** A note shown with a report: something not available, or how to read a figure. */
export const analyticsNoteSchema = z.object({ metric: z.string(), reason: z.string() });
export type AnalyticsNote = z.infer<typeof analyticsNoteSchema>;

/** Where a group of figures comes from and since when it is complete. */
export const coverageSchema = z.object({
  /** First record of this kind (null: none yet). */
  since: z.iso.datetime().nullable(),
  /** Records exist for the whole selected period. */
  complete: z.boolean(),
});
export type Coverage = z.infer<typeof coverageSchema>;

const bucket = z.object({ start: localDay, label: z.string() });

/** A time series: one value per bucket, null where the data wasn't recorded yet. */
export const seriesSchema = z.object({
  key: z.string(),
  label: z.string(),
  points: z.array(z.number().nullable()),
});
export type Series = z.infer<typeof seriesSchema>;

export const trendSchema = z.object({
  buckets: z.array(bucket),
  series: z.array(seriesSchema),
  /** The same series over the previous period, bucket by bucket (comparison). */
  previous: z.array(seriesSchema),
});
export type Trend = z.infer<typeof trendSchema>;

/** Demo and real side by side: never added together. */
export const splitSchema = z.object({ real: z.number().int(), demo: z.number().int() });
export type Split = z.infer<typeof splitSchema>;

export const modeSchema = z.enum(['real', 'demo']);
export type AnalyticsMode = z.infer<typeof modeSchema>;

// ─── Overview ────────────────────────────────────────────────────────────

const rateSchema = z.object({
  numerator: z.number().int(),
  denominator: z.number().int(),
  /** numerator / denominator, null when the denominator is 0. */
  value: z.number().min(0).max(1).nullable(),
  previous: z.number().min(0).max(1).nullable(),
});
export type AnalyticsRate = z.infer<typeof rateSchema>;
export { rateSchema as analyticsRateSchema };

export const overviewMoneySchema = z.object({
  mode: modeSchema,
  grossBookingValue: z.array(comparedMoneySchema),
  collected: z.array(comparedMoneySchema),
  refunded: z.array(comparedMoneySchema),
  averageBookingValue: z.array(comparedMoneySchema),
});

export const overviewReportSchema = reportMetaSchema.extend({
  users: z.object({
    /** Customer accounts that existed at the end of the period (staff excluded). */
    total: z.number().int(),
    new: comparedSchema,
    active: comparedSchema,
    activeCoverage: coverageSchema,
  }),
  searches: z.object({
    /** Distinct search sessions plus failed requests (refinements of one search count once). */
    total: comparedSchema,
    requests: z.number().int(),
    coverage: coverageSchema,
  }),
  conversion: rateSchema,
  bookings: z.object({
    created: z.object({ real: comparedSchema, demo: comparedSchema }),
    cancelled: splitSchema,
    /** Supplier reservations confirmed in the period (real only: demo bookings contact no supplier). */
    supplierConfirmed: comparedSchema,
  }),
  payments: z.object({
    /** Succeeded / (succeeded + failed + cancelled), attempts finished in the period. */
    successRate: z.object({ real: rateSchema, demo: rateSchema }),
  }),
  /** Money figures; null for roles without analytics.financial. */
  money: z.array(overviewMoneySchema).nullable(),
  trend: trendSchema,
  notes: z.array(analyticsNoteSchema),
});
export type OverviewReport = z.infer<typeof overviewReportSchema>;

// ─── Revenue ─────────────────────────────────────────────────────────────

export const revenueLineSchema = z.object({
  currency: currencyCodeSchema,
  /** Original offer price of bookings confirmed in the period (before any discount). */
  grossBookingValue: comparedMoneySchema,
  confirmedBookings: comparedSchema,
  /** Confirmed bookings without a fixed price (cab fare ranges): not in booking value. */
  unpricedBookings: z.number().int(),
  promotionDiscount: comparedMoneySchema,
  couponDiscount: comparedMoneySchema,
  pointsRedeemed: comparedMoneySchema,
  travelCreditUsed: comparedMoneySchema,
  /** Payments that succeeded in the period (a later refund doesn't undo the success). */
  paymentsSucceeded: comparedMoneySchema,
  refundsCompleted: comparedMoneySchema,
  /** Refunds created but not yet succeeded, as of now. Not deducted. */
  refundsPending: z.object({ amountMinor: minor, count: z.number().int() }),
  /** paymentsSucceeded − refundsCompleted. */
  netCollected: comparedMoneySchema,
  averageBookingValue: comparedMoneySchema,
});
export type RevenueLine = z.infer<typeof revenueLineSchema>;

export const revenueReportSchema = reportMetaSchema.extend({
  modes: z.array(z.object({ mode: modeSchema, lines: z.array(revenueLineSchema) })),
  /** Collected and refunded per bucket, per mode and currency. */
  trends: z.array(z.object({ mode: modeSchema, currency: currencyCodeSchema, trend: trendSchema })),
  notes: z.array(analyticsNoteSchema),
});
export type RevenueReport = z.infer<typeof revenueReportSchema>;

// ─── Funnel ──────────────────────────────────────────────────────────────

export const FUNNEL_STAGES = [
  'search_initiated',
  'results_returned',
  'offer_viewed',
  'offer_selected',
  'booking_initiated',
  'booking_created',
  'payment_completed',
  'supplier_confirmed',
] as const;
export const funnelStageKeySchema = z.enum(FUNNEL_STAGES);
export type FunnelStageKey = z.infer<typeof funnelStageKeySchema>;

export const funnelStageSchema = z.object({
  key: funnelStageKeySchema,
  label: z.string(),
  /** Searches that reached this stage or a later one. */
  count: z.number().int(),
  /** Of those, recorded directly at this stage (the rest are implied by a later stage). */
  observed: z.number().int(),
  /** count / previous stage's count; null for the first stage or when it is 0. */
  conversion: z.number().min(0).max(1).nullable(),
  /** Previous stage's count − this count. */
  dropOff: z.number().int().nullable(),
  /** Demo / real split, for the booking, payment and supplier stages. */
  split: splitSchema.nullable(),
});
export type FunnelStage = z.infer<typeof funnelStageSchema>;

export const funnelReportSchema = reportMetaSchema.extend({
  coverage: z.object({ searches: coverageSchema, events: coverageSchema }),
  stages: z.array(funnelStageSchema),
  byCategory: z.array(
    z.object({ category: searchServiceTypeSchema, counts: z.array(z.number().int()) }),
  ),
  trend: trendSchema,
  notes: z.array(analyticsNoteSchema),
});
export type FunnelReport = z.infer<typeof funnelReportSchema>;

// ─── Search ──────────────────────────────────────────────────────────────

export const searchReportSchema = reportMetaSchema.extend({
  coverage: z.object({ searches: coverageSchema, details: coverageSchema, offers: coverageSchema }),
  byCategory: z.array(
    z.object({
      category: searchServiceTypeSchema,
      searches: z.number().int(),
      requests: z.number().int(),
      noResults: z.number().int(),
      failed: z.number().int(),
    }),
  ),
  noResultsRate: rateSchema,
  /** Searches with results where at least one offer page was opened. */
  searchToOffer: rateSchema,
  /** Searches with results that went no further (no offer opened, nothing booked). */
  abandonment: rateSchema,
  /** Only pairs searched at least `minimumCount` times are listed. */
  minimumCount: z.number().int(),
  routes: z.array(
    z.object({
      category: searchServiceTypeSchema,
      origin: z.string().nullable(),
      originName: z.string().nullable(),
      destination: z.string(),
      destinationName: z.string(),
      searches: z.number().int(),
    }),
  ),
  travelMonths: z.array(z.object({ month: z.string(), searches: z.number().int() })),
  filters: z.array(z.object({ filter: z.string(), requests: z.number().int() })),
  sorts: z.array(z.object({ sort: z.string(), requests: z.number().int() })),
  /** Destination page views (Phase 29 daily totals, UTC days). */
  destinationViews: z.array(
    z.object({ slug: z.string(), name: z.string(), views: z.number().int() }),
  ),
  trend: trendSchema,
  notes: z.array(analyticsNoteSchema),
});
export type SearchReport = z.infer<typeof searchReportSchema>;

// ─── Customers ───────────────────────────────────────────────────────────

export const customersReportSchema = reportMetaSchema.extend({
  activeCoverage: coverageSchema,
  registrations: comparedSchema,
  active: comparedSchema,
  /** Active in the period with an account created before it. */
  returning: comparedSchema,
  /** Per mode: customers with a confirmed booking in the period, repeat rate, frequency. */
  booking: z.array(
    z.object({
      mode: modeSchema,
      customers: comparedSchema,
      /** Of those, customers with two or more confirmed bookings ever (to the period's end). */
      repeat: rateSchema,
      /** Confirmed bookings in the period per booking customer. */
      frequency: z.number().nullable(),
    }),
  ),
  /** Share of the previous period's active customers who were active again. */
  retention: rateSchema.nullable(),
  tiers: z.array(z.object({ mode: modeSchema, tier: z.string(), accounts: z.number().int() })),
  rewards: z.array(
    z.object({
      mode: modeSchema,
      earners: z.number().int(),
      redeemers: z.number().int(),
      accounts: z.number().int(),
    }),
  ),
  trend: trendSchema,
  notes: z.array(analyticsNoteSchema),
});
export type CustomersReport = z.infer<typeof customersReportSchema>;

// ─── Providers ───────────────────────────────────────────────────────────

export const analyticsProviderKindSchema = z.enum(['live', 'demo', 'unknown']);

export const providersReportSchema = reportMetaSchema.extend({
  coverage: coverageSchema,
  search: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: analyticsProviderKindSchema,
      calls: comparedSchema,
      byOutcome: z.record(z.string(), z.number().int()),
      /** (success + empty) / calls: the share of calls that answered. Not an uptime figure. */
      answerRate: rateSchema,
      timeoutRate: rateSchema,
      averageMs: z.number().nullable(),
      p95Ms: z.number().nullable(),
    }),
  ),
  reservations: z.array(
    z.object({
      provider: z.string(),
      kind: analyticsProviderKindSchema,
      /** Reservations started in the period, by their current state. */
      started: z.number().int(),
      byStatus: z.record(z.string(), z.number().int()),
      /** confirmed / (confirmed + failed): settled outcomes only. */
      successRate: rateSchema,
      errorCategories: z.record(z.string(), z.number().int()),
    }),
  ),
  notes: z.array(analyticsNoteSchema),
});
export type ProvidersReport = z.infer<typeof providersReportSchema>;

// ─── Marketing ───────────────────────────────────────────────────────────

const amountsSchema = z.array(z.object({ currency: currencyCodeSchema, amountMinor: minor }));

export const marketingReportSchema = reportMetaSchema.extend({
  /** Bookings with at least one redeemed promotion, counted once however many applied. */
  promotedBookings: z.object({ real: comparedSchema, demo: comparedSchema }),
  promotions: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      kind: z.enum(['coupon', 'automatic']),
      code: z.string().nullable(),
      /** Active now and within its dates. */
      live: z.boolean(),
      /** Applied to a booking in the period (reserved), redeemed (paid), released or reversed. */
      applied: z.number().int(),
      redeemed: splitSchema,
      released: z.number().int(),
      discount: z.object({ real: amountsSchema, demo: amountsSchema }),
    }),
  ),
  /** Coupon code acceptances → redemptions (bookings paid with that coupon). */
  couponConversion: rateSchema,
  loyalty: z.array(
    z.object({
      mode: modeSchema,
      pointsEarned: z.string(),
      pointsRedeemed: z.string(),
      pointsExpired: z.string(),
      creditIssued: amountsSchema,
      creditUsed: amountsSchema,
      creditExpired: amountsSchema,
    }),
  ),
  notes: z.array(analyticsNoteSchema),
});
export type MarketingReport = z.infer<typeof marketingReportSchema>;

// ─── Support and reviews ─────────────────────────────────────────────────

export const supportReportSchema = reportMetaSchema.extend({
  /** null for roles without support access. */
  tickets: z
    .object({
      created: comparedSchema,
      resolved: comparedSchema,
      escalated: z.number().int(),
      openNow: z.number().int(),
      /** First staff reply (automated acknowledgements aren't replies), tickets created in the period. */
      firstResponse: z.object({
        count: z.number().int(),
        averageMinutes: z.number().nullable(),
        medianMinutes: z.number().nullable(),
      }),
      resolution: z.object({
        count: z.number().int(),
        averageMinutes: z.number().nullable(),
        medianMinutes: z.number().nullable(),
      }),
      byCategory: z.array(z.object({ category: z.string(), created: z.number().int() })),
      workload: z.array(z.object({ name: z.string(), active: z.number().int() })),
    })
    .nullable(),
  /** null for roles without review access. */
  reviews: z
    .object({
      submitted: comparedSchema,
      /** Reviews published in the period: average of their overall rating. */
      averagePublishedRating: comparedSchema,
      publishedInPeriod: z.number().int(),
      byVerification: z.record(z.string(), z.number().int()),
      pendingNow: z.number().int(),
      flaggedNow: z.number().int(),
      openReportsNow: z.number().int(),
    })
    .nullable(),
  trend: trendSchema,
  notes: z.array(analyticsNoteSchema),
});
export type SupportReport = z.infer<typeof supportReportSchema>;

export const ANALYTICS_REPORT_SCHEMAS = {
  overview: overviewReportSchema,
  revenue: revenueReportSchema,
  funnel: funnelReportSchema,
  search: searchReportSchema,
  customers: customersReportSchema,
  providers: providersReportSchema,
  marketing: marketingReportSchema,
  support: supportReportSchema,
} as const satisfies Record<AnalyticsReport, z.ZodType>;

export interface AnalyticsReports {
  overview: OverviewReport;
  revenue: RevenueReport;
  funnel: FunnelReport;
  search: SearchReport;
  customers: CustomersReport;
  providers: ProvidersReport;
  marketing: MarketingReport;
  support: SupportReport;
}
