import { z } from 'zod';
import { travelCategorySlugSchema, type TravelCategorySlug } from '../catalog.js';
import { moneySchema } from '../money.js';

/*
 * Building blocks shared by every search category (Phase 9).
 *
 * Date and time conventions:
 * - Travel dates (departure, check-in, holiday start) are calendar dates,
 *   `YYYY-MM-DD`, in the local time of the place they refer to. They carry no
 *   time zone on purpose: "the 12th in Goa" is the 12th whatever the server's zone.
 * - Instants (cab pick-up time, departure/arrival times in results,
 *   `generatedAt`) are ISO 8601 date-times WITH an explicit UTC offset, e.g.
 *   `2026-11-12T06:15:00+05:30`. Results use the local offset of the place.
 */

/** The service type of a search is the catalog slug (`flights`, `hotels`, …). */
export const searchServiceTypeSchema = travelCategorySlugSchema;
export type SearchServiceType = TravelCategorySlug;

/** Currencies a search may ask prices in. Providers that can't price in it say so. */
export const SEARCH_CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD'] as const;
export const searchCurrencySchema = z.enum(SEARCH_CURRENCIES, {
  error: `Currency must be one of ${SEARCH_CURRENCIES.join(', ')}.`,
});
export type SearchCurrency = z.infer<typeof searchCurrencySchema>;

export const MAX_PAGE = 100;
export const MAX_PAGE_SIZE = 50;
export const DEFAULT_PAGE_SIZE = 10;
/** How far ahead travel can be searched. */
export const MAX_DAYS_AHEAD = 365;

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC calendar date `days` from now, as YYYY-MM-DD. */
export function utcDateFromToday(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (both YYYY-MM-DD). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** A real calendar date, `YYYY-MM-DD`. */
export const isoDateSchema = z
  .string({ error: 'Choose a date.' })
  .regex(ISO_DATE, { error: 'Use the format YYYY-MM-DD.', abort: true })
  .refine(
    (v) => {
      const d = new Date(`${v}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
    },
    { error: 'Enter a real date.', abort: true },
  );

/**
 * A travel date: not in the past and at most a year ahead. "Today" is taken
 * generously (yesterday in UTC is still allowed) so a traveller whose local
 * date is ahead of or behind UTC is never rejected for searching today.
 */
export const travelDateSchema = isoDateSchema
  .refine((v) => v >= utcDateFromToday(-1), { error: 'That date has already passed.', abort: true })
  .refine((v) => v <= utcDateFromToday(MAX_DAYS_AHEAD), {
    error: `Choose a date within the next ${MAX_DAYS_AHEAD} days.`,
  });

/** An instant with an explicit UTC offset, e.g. `2026-11-12T06:15:00+05:30`. */
export const offsetDateTimeSchema = z.iso.datetime({
  offset: true,
  error: 'Use an ISO 8601 date and time with a UTC offset, like 2026-11-12T06:15:00+05:30.',
});

/** Price ceiling in minor units of the request currency (e.g. paise), as an integer string. */
export const maxPriceMinorSchema = z
  .string()
  .regex(/^[1-9]\d{0,12}$/, 'Enter a whole amount above zero.');

export const pageSchema = z.coerce.number().int().min(1).max(MAX_PAGE).default(1);
export const pageSizeSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_SIZE)
  .default(DEFAULT_PAGE_SIZE);

/** Time-of-day buckets for departure filters, in the departure place's local time. */
export const departureWindowSchema = z.enum([
  'early-morning',
  'morning',
  'afternoon',
  'evening',
  'night',
]);
export type DepartureWindow = z.infer<typeof departureWindowSchema>;
/** [start hour inclusive, end hour exclusive] in local time. */
export const DEPARTURE_WINDOW_HOURS: Record<DepartureWindow, readonly [number, number]> = {
  'early-morning': [0, 6],
  morning: [6, 12],
  afternoon: [12, 17],
  evening: [17, 21],
  night: [21, 24],
};

/**
 * Prices. `total` is what the whole search party would pay for this option,
 * with an optional per-unit figure; `range` is an estimate (cabs). All values
 * share one currency; providers never mix currencies inside a price.
 */
export const searchPriceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('total'),
      total: moneySchema,
      /** Per traveller, per night or per passenger, as `unit` says. */
      perUnit: z
        .object({ amount: moneySchema, unit: z.enum(['traveller', 'adult', 'night', 'passenger']) })
        .nullable(),
    })
    .refine((p) => !p.perUnit || p.perUnit.amount.currency === p.total.currency, {
      message: 'A price must use one currency throughout.',
      path: ['perUnit', 'amount', 'currency'],
    }),
  z
    .object({
      kind: z.literal('range'),
      min: moneySchema,
      max: moneySchema,
    })
    .refine((p) => p.min.currency === p.max.currency, {
      message: 'A price must use one currency throughout.',
      path: ['max', 'currency'],
    })
    // Exact integer comparison of minor units (never floats).
    .refine(
      (p) =>
        p.min.currency !== p.max.currency || BigInt(p.min.amountMinor) <= BigInt(p.max.amountMinor),
      {
        message: 'A price range must not end below its start.',
        path: ['max', 'amountMinor'],
      },
    ),
]);
export type SearchPrice = z.infer<typeof searchPriceSchema>;

/** Where a result came from. `demo` results are fixtures: not live; bookable only as demo bookings. */
export const dataSourceSchema = z.enum(['demo', 'live']);
export type DataSource = z.infer<typeof dataSourceSchema>;

export const providerKindSchema = dataSourceSchema;
export type ProviderKind = DataSource;

/**
 * Outcome of one provider for one search.
 * - success: returned at least one valid result
 * - empty: answered, nothing matched
 * - timeout: didn't answer within its time limit
 * - unavailable: disabled, not configured, or reported itself unavailable
 * - error: failed, or returned only unusable data
 */
export const providerOutcomeSchema = z.enum([
  'success',
  'empty',
  'timeout',
  'unavailable',
  'error',
]);
export type ProviderOutcome = z.infer<typeof providerOutcomeSchema>;

export const providerStatusSchema = z.object({
  providerId: z.string().min(1),
  providerName: z.string().min(1),
  kind: providerKindSchema,
  status: providerOutcomeSchema,
  /** Valid results this provider contributed (before filters). */
  resultCount: z.number().int().min(0),
  durationMs: z.number().int().min(0),
  /** Safe, user-facing explanation for non-success outcomes. */
  message: z.string().nullable(),
});
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

export const searchWarningSchema = z.object({
  code: z.enum([
    'DEMO_DATA',
    'PARTIAL_RESULTS',
    'CURRENCY_NOT_CONVERTED',
    'INVALID_PROVIDER_RESULTS',
    'PRICE_FILTER_CURRENCY',
  ]),
  message: z.string().min(1),
});
export type SearchWarning = z.infer<typeof searchWarningSchema>;

export const paginationSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  totalResults: z.number().int().min(0),
  totalPages: z.number().int().min(0),
});
export type Pagination = z.infer<typeof paginationSchema>;

export const DEMO_DATA_DISCLAIMER =
  'Demo data: these results come from Wayora’s built-in sample fixtures, not from airlines, hotels or other travel providers. Prices, times and services are illustrative, availability is not checked, and bookings are demo bookings only: no real reservation, ticket or payment is made.';
