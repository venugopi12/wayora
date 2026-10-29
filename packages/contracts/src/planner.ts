import { z } from 'zod';
import { travelCategorySlugSchema } from './catalog.js';
import { bookingReferenceSchema, bookingStatusSchema } from './bookings.js';
import { daysBetween, isoDateSchema, offsetDateTimeSchema } from './search/common.js';

/*
 * Trip planner (Phase 18, docs/planner.md): a signed-in user's own planned
 * trips and day-by-day itineraries.
 *
 * Honesty rules built into the shapes:
 * - A planned trip is a plan, never a booking. Nothing here reserves, prices
 *   or confirms anything; `linkedBooking` appears only when the user chose to
 *   link one of their own confirmed bookings.
 * - Suggestions come from a curated SAMPLE dataset ranked by fixed rules
 *   (`source: 'curated-sample'`, `method: 'rules'`). They carry no opening
 *   hours, prices, availability, ratings or travel times.
 * - Itineraries are never travel-time-validated (`travelTimeValidated` is
 *   always false): no routing source exists.
 *
 * Dates and times:
 * - Trip and itinerary dates are calendar dates (`YYYY-MM-DD`) at the
 *   destination. They carry no time zone and are never converted.
 * - Activity times are wall-clock `HH:MM` at the destination, never instants.
 */

export const PLANNER_LIMITS = {
  /** Longest trip, in days (inclusive of both ends). */
  maxTripDays: 30,
  /** How far ahead a trip may start, in days. */
  maxDaysAhead: 730,
  /** Planned trips per account. */
  maxTrips: 50,
  maxItemsPerDay: 20,
  maxItemsPerTrip: 200,
  /** Longest single activity, in minutes. */
  maxDurationMinutes: 720,
} as const;

// ─── Text ────────────────────────────────────────────────────────────────

/*
 * Free text is stored and returned as plain text and rendered as text, never
 * HTML. Control characters and bidirectional overrides (which can make text
 * display differently from what it contains) are refused.
 */
const isForbiddenCodePoint = (code: number, allowLineBreaks: boolean) =>
  (code <= 0x1f && !(allowLineBreaks && (code === 0x09 || code === 0x0a))) ||
  (code >= 0x7f && code <= 0x9f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);

/** True when `value` holds a control character or a bidirectional override. */
export function hasUnsafeTextCharacters(value: string, allowLineBreaks = false): boolean {
  for (const char of value) {
    if (isForbiddenCodePoint(char.codePointAt(0) ?? 0, allowLineBreaks)) return true;
  }
  return false;
}

/** One line of text: trimmed, inner whitespace collapsed. */
export const plannerLine = (label: string, max: number) =>
  z
    .string({ error: `Enter ${label}.` })
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(
      z
        .string()
        .min(1, `Enter ${label}.`)
        .max(max, `Use ${max} characters or fewer.`)
        .refine((v) => !hasUnsafeTextCharacters(v), 'Remove unsupported characters.'),
    );

/** Optional one-line text: blank becomes null. */
const optionalLine = (max: number) =>
  z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(
      z
        .string()
        .max(max, `Use ${max} characters or fewer.`)
        .refine((v) => !hasUnsafeTextCharacters(v), 'Remove unsupported characters.'),
    )
    .transform((v) => (v === '' ? null : v))
    .nullable();

/** Optional multi-line notes: line breaks kept, blank becomes null. */
const optionalNotes = (max: number) =>
  z
    .string()
    .transform((v) => v.replace(/\r\n?/g, '\n').trim())
    .pipe(
      z
        .string()
        .max(max, `Use ${max} characters or fewer.`)
        .refine((v) => !hasUnsafeTextCharacters(v, true), 'Remove unsupported characters.'),
    )
    .transform((v) => (v === '' ? null : v))
    .nullable();

// ─── Preferences ─────────────────────────────────────────────────────────

/** Kinds of activity. Interests are the same list without transport and other. */
export const ACTIVITY_CATEGORIES = [
  'sightseeing',
  'culture',
  'food',
  'nature',
  'beach',
  'adventure',
  'shopping',
  'nightlife',
  'wellness',
  'transport',
  'other',
] as const;
export const activityCategorySchema = z.enum(ACTIVITY_CATEGORIES, {
  error: 'Choose a category.',
});
export type ActivityCategory = z.infer<typeof activityCategorySchema>;

/** Display names (sentence case). */
export const ACTIVITY_CATEGORY_LABELS: Record<ActivityCategory, string> = {
  sightseeing: 'Sightseeing',
  culture: 'Culture',
  food: 'Food',
  nature: 'Nature',
  beach: 'Beach',
  adventure: 'Adventure',
  shopping: 'Shopping',
  nightlife: 'Nightlife',
  wellness: 'Wellness',
  transport: 'Getting around',
  other: 'Other',
};

export const PLANNER_INTERESTS = ACTIVITY_CATEGORIES.filter(
  (c): c is Exclude<ActivityCategory, 'transport' | 'other'> => c !== 'transport' && c !== 'other',
);
export const plannerInterestSchema = z.enum(PLANNER_INTERESTS);
export type PlannerInterest = z.infer<typeof plannerInterestSchema>;

export const planningPaceSchema = z.enum(['relaxed', 'balanced', 'packed']);
export type PlanningPace = z.infer<typeof planningPaceSchema>;
export const planningBudgetSchema = z.enum(['shoestring', 'moderate', 'premium']);
export type PlanningBudget = z.infer<typeof planningBudgetSchema>;
export const planningGroupSchema = z.enum(['solo', 'couple', 'family', 'friends']);
export type PlanningGroup = z.infer<typeof planningGroupSchema>;

/**
 * Optional planning preferences, per trip. Every field may be left unset
 * (null / empty): suggestions then use the default ranking. Nothing here is
 * sensitive, and nothing is inferred — only what the user picks is stored.
 */
export const plannerPreferencesSchema = z
  .object({
    pace: planningPaceSchema.nullable().default(null),
    budget: planningBudgetSchema.nullable().default(null),
    group: planningGroupSchema.nullable().default(null),
    interests: z
      .array(plannerInterestSchema)
      .max(PLANNER_INTERESTS.length)
      .default([])
      .transform((list) => [...new Set(list)]),
  })
  .strict();
export type PlannerPreferences = z.infer<typeof plannerPreferencesSchema>;
export const EMPTY_PLANNER_PREFERENCES: PlannerPreferences = {
  pace: null,
  budget: null,
  group: null,
  interests: [],
};

// ─── Ids and params ──────────────────────────────────────────────────────

export const plannedTripIdSchema = z.uuid({ error: 'Not a valid trip id.' });
export const itineraryItemIdSchema = z.uuid({ error: 'Not a valid activity id.' });
/** Curated destination id (matches the discover dataset), e.g. `goa`. */
export const plannerDestinationIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Not a valid destination.')
  .max(40);
/** Curated suggestion id, `<destination>:<activity>`, e.g. `goa:fort-aguada`. */
export const suggestionIdSchema = z
  .string()
  .regex(/^[a-z0-9-]{1,40}:[a-z0-9-]{1,60}$/, 'Not a valid suggestion.');

export const plannedTripParamsSchema = z.object({ tripId: plannedTripIdSchema });
export const itineraryItemParamsSchema = z.object({
  tripId: plannedTripIdSchema,
  itemId: itineraryItemIdSchema,
});
export const itineraryDayParamsSchema = z.object({
  tripId: plannedTripIdSchema,
  day: isoDateSchema,
});

// ─── Trips: input ────────────────────────────────────────────────────────

const tripDatesRefinement = (
  value: { startDate?: string | undefined; endDate?: string | undefined },
  ctx: z.RefinementCtx,
) => {
  if (!value.startDate || !value.endDate) return;
  const days = daysBetween(value.startDate, value.endDate);
  if (days < 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['endDate'],
      message: 'The end date must be on or after the start date.',
    });
  } else if (days + 1 > PLANNER_LIMITS.maxTripDays) {
    ctx.addIssue({
      code: 'custom',
      path: ['endDate'],
      message: `Plan at most ${PLANNER_LIMITS.maxTripDays} days per trip.`,
    });
  }
};

/**
 * Creating a trip. The destination is either one of the curated sample
 * destinations (`destinationId`, which unlocks sample suggestions) or a
 * free-text name. The owner, ids, timestamps and version are server-set:
 * unknown fields are refused (`strict`), so they can't be mass-assigned.
 * "Not in the past" is checked by the server against its clock.
 */
export const createPlannedTripSchema = z
  .object({
    title: plannerLine('a trip name', 120),
    destinationId: plannerDestinationIdSchema.nullable().optional(),
    destinationName: optionalLine(120).optional(),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    notes: optionalNotes(2000).optional(),
    preferences: plannerPreferencesSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.destinationId && !value.destinationName) {
      ctx.addIssue({
        code: 'custom',
        path: ['destinationName'],
        message: 'Choose or enter a destination.',
      });
    }
    tripDatesRefinement(value, ctx);
  });
export type CreatePlannedTripInput = z.input<typeof createPlannedTripSchema>;
export type CreatePlannedTrip = z.output<typeof createPlannedTripSchema>;

/**
 * Updating trip details. `version` is the version the edit was based on: if
 * the trip changed since (another tab or device), the update is refused with
 * CONFLICT instead of silently overwriting it. `bookingReference: null`
 * unlinks a booking.
 */
export const updatePlannedTripSchema = z
  .object({
    version: z.number().int().min(1),
    title: plannerLine('a trip name', 120).optional(),
    destinationId: plannerDestinationIdSchema.nullable().optional(),
    destinationName: optionalLine(120).optional(),
    startDate: isoDateSchema.optional(),
    endDate: isoDateSchema.optional(),
    notes: optionalNotes(2000).optional(),
    preferences: plannerPreferencesSchema.optional(),
    bookingReference: bookingReferenceSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.startDate === undefined) !== (value.endDate === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [value.startDate === undefined ? 'startDate' : 'endDate'],
        message: 'Send both the start and end dates.',
      });
    }
    tripDatesRefinement(value, ctx);
  });
export type UpdatePlannedTripInput = z.input<typeof updatePlannedTripSchema>;

export const plannedTripListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100).default(1),
    pageSize: z.coerce.number().int().min(1).max(PLANNER_LIMITS.maxTrips).default(20),
  })
  .strict();
export type PlannedTripListQuery = z.infer<typeof plannedTripListQuerySchema>;

// ─── Itinerary items: input ──────────────────────────────────────────────

/** Wall-clock time at the destination, `HH:MM` (24-hour). */
export const localTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 09:30.');

const durationSchema = z
  .number({ error: 'Enter the duration in minutes.' })
  .int('Use whole minutes.')
  .min(5, 'Use at least 5 minutes.')
  .max(
    PLANNER_LIMITS.maxDurationMinutes,
    `Use at most ${PLANNER_LIMITS.maxDurationMinutes / 60} hours.`,
  );

const itemFields = {
  title: plannerLine('a name for the activity', 120),
  category: activityCategorySchema,
  startTime: localTimeSchema.nullable(),
  durationMinutes: durationSchema.nullable(),
  location: optionalLine(160),
  notes: optionalNotes(1000),
};

/**
 * Adding an activity. `day` must fall within the trip's dates. `suggestionId`
 * adds a curated suggestion (server-checked: it must belong to the trip's
 * destination and not already be in the itinerary).
 */
export const createItineraryItemSchema = z
  .object({
    day: isoDateSchema,
    title: itemFields.title,
    category: itemFields.category,
    startTime: itemFields.startTime.optional(),
    durationMinutes: itemFields.durationMinutes.optional(),
    location: itemFields.location.optional(),
    notes: itemFields.notes.optional(),
    suggestionId: suggestionIdSchema.optional(),
  })
  .strict();
export type CreateItineraryItemInput = z.input<typeof createItineraryItemSchema>;

/**
 * Editing an activity. A new `day` moves it to that day (appended last, or at
 * `position`); the old day's order closes up. Only fields sent change.
 * `version` is the activity's version the edit is based on: if someone
 * changed it since, the edit is refused (PLAN_OUT_OF_DATE) instead of
 * overwriting their change.
 */
export const updateItineraryItemSchema = z
  .object({
    version: z.number({ error: 'Send the activity’s version.' }).int().min(1),
    day: isoDateSchema.optional(),
    position: z.number().int().min(0).max(PLANNER_LIMITS.maxItemsPerDay).optional(),
    title: itemFields.title.optional(),
    category: itemFields.category.optional(),
    startTime: itemFields.startTime.optional(),
    durationMinutes: itemFields.durationMinutes.optional(),
    location: itemFields.location.optional(),
    notes: itemFields.notes.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'version'), 'Send at least one change.');
export type UpdateItineraryItemInput = z.input<typeof updateItineraryItemSchema>;

/** Copying an activity, to the same day (default) or another one. */
export const duplicateItineraryItemSchema = z.object({ day: isoDateSchema.optional() }).strict();

const dayOrderSchema = z
  .array(itineraryItemIdSchema)
  .max(PLANNER_LIMITS.maxItemsPerDay)
  .refine((ids) => new Set(ids).size === ids.length, 'Each activity may appear only once.');

/**
 * The new order of one day: every activity on that day, each exactly once.
 * Anything else (a missing, extra or foreign id) is refused, so a stale or
 * forged list can never drop, duplicate or capture activities.
 * `previousOrder` is the order the change was based on: if the day's order
 * changed since (another member reordered it), the reorder is refused
 * (PLAN_OUT_OF_DATE) instead of silently replacing theirs.
 */
export const reorderItineraryDaySchema = z
  .object({
    itemIds: dayOrderSchema,
    previousOrder: dayOrderSchema,
  })
  .strict();
export type ReorderItineraryDay = z.infer<typeof reorderItineraryDaySchema>;

export const suggestionQuerySchema = z
  .object({
    category: plannerInterestSchema.optional(),
  })
  .strict();

// ─── Output ──────────────────────────────────────────────────────────────

export const plannerDestinationSchema = z.object({
  /** Curated destination id, or null for a free-text destination. */
  id: plannerDestinationIdSchema.nullable(),
  name: z.string(),
  country: z.string().nullable(),
  /** IANA zone, for display ("times are local to Goa, Asia/Kolkata"); null when unknown. */
  timeZone: z.string().nullable(),
  /** Has curated sample suggestions. */
  hasSuggestions: z.boolean(),
});
export type PlannerDestination = z.infer<typeof plannerDestinationSchema>;

export const itineraryItemSchema = z.object({
  id: itineraryItemIdSchema,
  day: isoDateSchema,
  /** 0-based order within the day. */
  position: z.number().int().min(0),
  title: z.string(),
  category: activityCategorySchema,
  startTime: localTimeSchema.nullable(),
  durationMinutes: z.number().int().nullable(),
  /** Computed from start and duration; may pass midnight (`endsNextDay`). */
  endTime: localTimeSchema.nullable(),
  endsNextDay: z.boolean(),
  location: z.string().nullable(),
  notes: z.string().nullable(),
  /** The curated sample suggestion it was added from, if any. */
  suggestionId: suggestionIdSchema.nullable(),
  /** Send it back when editing (optimistic concurrency). */
  version: z.number().int().min(1),
  /** Who added it, when known (shared plans show it). */
  addedBy: z.object({ name: z.string(), isYou: z.boolean() }).nullable(),
  createdAt: offsetDateTimeSchema,
  updatedAt: offsetDateTimeSchema,
});
export type ItineraryItem = z.infer<typeof itineraryItemSchema>;

export const itineraryDaySchema = z.object({
  date: isoDateSchema,
  /** 1-based day of the trip. */
  dayNumber: z.number().int().min(1),
  items: z.array(itineraryItemSchema),
});
export type ItineraryDay = z.infer<typeof itineraryDaySchema>;

export const ITINERARY_WARNING_CODES = [
  /** Two timed activities overlap. */
  'overlap',
  /** The activity's day is outside the trip dates (the dates changed). */
  'outside_trip_dates',
  /** The day mixes timed and untimed activities, so its order can't be checked. */
  'missing_start_time',
  /** Timed activities are listed out of time order. */
  'out_of_order',
  /** The activity runs past midnight. */
  'ends_next_day',
  /** The day's activities add up to more than the long-day threshold. */
  'long_day',
] as const;
export const itineraryWarningCodeSchema = z.enum(ITINERARY_WARNING_CODES);
export type ItineraryWarningCode = z.infer<typeof itineraryWarningCodeSchema>;

/** Planned activity time above which a day is flagged as long (no travel time included). */
export const LONG_DAY_MINUTES = 12 * 60;

/**
 * A schedule warning. Never blocks saving; never moves or removes anything.
 * Based only on the user's own times and durations — never on travel times.
 */
export const itineraryWarningSchema = z.object({
  code: itineraryWarningCodeSchema,
  day: isoDateSchema,
  itemIds: z.array(itineraryItemIdSchema),
  message: z.string(),
});
export type ItineraryWarning = z.infer<typeof itineraryWarningSchema>;

export const linkedBookingSchema = z.object({
  reference: bookingReferenceSchema,
  category: travelCategorySlugSchema,
  status: bookingStatusSchema,
  startsOn: isoDateSchema.nullable(),
  endsOn: isoDateSchema.nullable(),
  demo: z.boolean(),
});
export type LinkedBooking = z.infer<typeof linkedBookingSchema>;

/** `owner`: full control; `editor`: can change the plan; `viewer`: can only look. */
export const tripRoleSchema = z.enum(['owner', 'editor', 'viewer']);
export type TripRole = z.infer<typeof tripRoleSchema>;

/** What the signed-in user may do with a plan (the API enforces it; this is for display). */
export const tripAccessSchema = z.object({
  role: tripRoleSchema,
  /** Change the itinerary and the plan's details. */
  canEdit: z.boolean(),
  /** Invite, change roles, remove members, link a booking, delete the plan. */
  canManage: z.boolean(),
});
export type TripAccess = z.infer<typeof tripAccessSchema>;

export const plannedTripSummarySchema = z.object({
  id: plannedTripIdSchema,
  title: z.string(),
  destination: plannerDestinationSchema,
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  dayCount: z.number().int().min(1),
  itemCount: z.number().int().min(0),
  /** The owner's booking, shown to the owner only (null for members). */
  linkedBooking: linkedBookingSchema.nullable(),
  access: tripAccessSchema,
  /** The owner's display name (shared plans show it). */
  owner: z.object({ name: z.string(), isYou: z.boolean() }),
  /** Members other than the owner. */
  memberCount: z.number().int().min(0),
  createdAt: offsetDateTimeSchema,
  updatedAt: offsetDateTimeSchema,
});
export type PlannedTripSummary = z.infer<typeof plannedTripSummarySchema>;

export const plannedTripSchema = plannedTripSummarySchema.extend({
  /** For optimistic concurrency on trip-detail edits. */
  version: z.number().int().min(1),
  /** Bumped by every change to the plan (live updates compare it). */
  revision: z.number().int().min(0),
  notes: z.string().nullable(),
  preferences: plannerPreferencesSchema,
  /** One entry per trip day, in date order, activities in their saved order. */
  days: z.array(itineraryDaySchema),
  /** Activities whose day is no longer within the trip dates (never dropped). */
  outsideDates: z.array(itineraryItemSchema),
  warnings: z.array(itineraryWarningSchema),
  /** Always false: no route or travel-time source exists. */
  travelTimeValidated: z.literal(false),
});
export type PlannedTrip = z.infer<typeof plannedTripSchema>;

export const plannedTripListSchema = z.object({
  items: z.array(plannedTripSummarySchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  /** Planned trips this account may keep. */
  limit: z.number().int(),
});
export type PlannedTripList = z.infer<typeof plannedTripListSchema>;

// ─── Suggestions ─────────────────────────────────────────────────────────

/** Rough cost level from the curated sample: never a price. */
export const costLevelSchema = z.enum(['free-or-low', 'moderate', 'premium']);
export type CostLevel = z.infer<typeof costLevelSchema>;
export const timeOfDaySchema = z.enum(['morning', 'afternoon', 'evening', 'any']);
export type TimeOfDay = z.infer<typeof timeOfDaySchema>;

export const activitySuggestionSchema = z.object({
  id: suggestionIdSchema,
  title: z.string(),
  category: activityCategorySchema,
  /** Neighbourhood or area, for orientation only (not an address). */
  area: z.string(),
  summary: z.string(),
  /** A planning estimate for how long to allow; not a measured visit time. */
  typicalMinutes: z.number().int(),
  costLevel: costLevelSchema,
  /** When it is commonly enjoyed; not opening hours. */
  bestTime: timeOfDaySchema,
  /** Why it is suggested, derived from the rules (never empty). */
  reasons: z.array(z.string()).min(1),
});
export type ActivitySuggestion = z.infer<typeof activitySuggestionSchema>;

export const suggestionsResponseSchema = z.object({
  /** False when there is no curated sample data for the trip's destination. */
  available: z.boolean(),
  source: z.literal('curated-sample'),
  /** Ranked by fixed, documented rules — not AI, not personalised by history. */
  method: z.literal('rules'),
  /** How many activities the trip's length and pace suggest, and how many are planned. */
  capacity: z.object({
    days: z.number().int(),
    perDay: z.number().int(),
    planned: z.number().int(),
  }),
  suggestions: z.array(activitySuggestionSchema),
});
export type SuggestionsResponse = z.infer<typeof suggestionsResponseSchema>;

export const plannedTripDeletedSchema = z.object({ deleted: z.literal(true) });

/** GET /planner/destinations: the curated sample destinations. */
export const plannerDestinationListSchema = z.object({
  items: z.array(plannerDestinationSchema),
  /** Always true: hand-written sample data, not a places provider. */
  sample: z.literal(true),
});
export type PlannerDestinationList = z.infer<typeof plannerDestinationListSchema>;
