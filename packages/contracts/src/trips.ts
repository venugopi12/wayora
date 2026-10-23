import { z } from 'zod';
import { bookingReferenceSchema } from './bookings.js';
import { moneySchema } from './money.js';
import { offsetDateTimeSchema } from './search/common.js';

/*
 * Trip tracking (Phase 17, docs/trips.md): a booking's timeline, its travel
 * status and travel disruptions.
 *
 * Honesty rules built into the shapes:
 * - Every timeline entry, status and disruption says where it came from
 *   (`source`). `demo` means the simulated status provider: never verified
 *   travel information, always shown as simulated.
 * - Status `freshness` is explicit; old information is never presented as
 *   current.
 * - Fields a provider didn't supply are null, never invented (no gates,
 *   terminals, seats or ticket numbers exist in these shapes at all).
 */

/** `wayora`: Wayora's own records; `demo`: the simulated status provider; `live`: a real provider. */
export const tripSourceSchema = z.enum(['wayora', 'demo', 'live']);
export type TripSource = z.infer<typeof tripSourceSchema>;

// ─── Timeline ────────────────────────────────────────────────────────────

export const TRIP_EVENT_TYPES = [
  'booking_created',
  'booking_confirmed',
  'booking_cancelled',
  'booking_expired',
  'booking_failed',
  'payment_succeeded',
  'payment_failed',
  'payment_refund_pending',
  'payment_refunded',
  /** The day before the trip starts (for stays: check-in is tomorrow). */
  'travel_reminder',
  /** Stays: check-out is tomorrow. */
  'check_out_reminder',
  'status_changed',
  'disruption_reported',
  'disruption_updated',
  'disruption_resolved',
] as const;
export const tripEventTypeSchema = z.enum(TRIP_EVENT_TYPES);
export type TripEventType = z.infer<typeof tripEventTypeSchema>;

/** For icons: what the entry is about. */
export const tripEventKindSchema = z.enum([
  'booking',
  'payment',
  'reminder',
  'status',
  'disruption',
]);
export type TripEventKind = z.infer<typeof tripEventKindSchema>;

export const tripEventSchema = z.object({
  id: z.uuid(),
  type: tripEventTypeSchema,
  kind: tripEventKindSchema,
  source: tripSourceSchema,
  /** Written by Wayora from structured data (never provider text). Render as text. */
  title: z.string(),
  description: z.string().nullable(),
  /** When it happened (canonical UTC; show in the viewer's time zone). */
  occurredAt: offsetDateTimeSchema,
  /** When a provider observed it; null for Wayora's own entries. */
  observedAt: offsetDateTimeSchema.nullable(),
  /** Set for payment entries. */
  amount: moneySchema.nullable(),
  /** Set for entries about a payment attempt (links to its page). */
  paymentId: z.uuid().nullable(),
});
export type TripEvent = z.infer<typeof tripEventSchema>;

export const tripTimelineQuerySchema = z
  .object({
    /** Opaque cursor from `nextCursor`. */
    after: z
      .string()
      .regex(/^[0-9]{1,15}_[0-9]{1,19}$/, 'Not a valid cursor.')
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type TripTimelineQuery = z.input<typeof tripTimelineQuerySchema>;

export const tripTimelineSchema = z.object({
  reference: bookingReferenceSchema,
  /** Oldest first. */
  items: z.array(tripEventSchema),
  /** More (newer) entries exist: pass this as `after`. */
  nextCursor: z.string().nullable(),
});
export type TripTimeline = z.infer<typeof tripTimelineSchema>;

// ─── Travel status ───────────────────────────────────────────────────────

/**
 * - `current`: from a provider, observed recently enough to trust.
 * - `stale`: from a provider, but older than the freshness window (or the
 *   latest check failed): shown with its age, never as current.
 * - `pending`: tracking applies but no status has been fetched yet.
 * - `unavailable`: no provider is configured, or it couldn't be reached and
 *   there is nothing earlier to show.
 * - `unsupported`: this booking can't be tracked (category, or its state).
 */
export const tripFreshnessSchema = z.enum([
  'current',
  'stale',
  'pending',
  'unavailable',
  'unsupported',
]);
export type TripFreshness = z.infer<typeof tripFreshnessSchema>;

export const tripLegStateSchema = z.enum([
  'scheduled',
  'delayed',
  'departed',
  'arrived',
  'cancelled',
  'unknown',
]);
export type TripLegState = z.infer<typeof tripLegStateSchema>;

const placeSchema = z.object({
  name: z.string(),
  code: z.string().nullable(),
  cityName: z.string(),
});

export const tripLegSchema = z.object({
  /** "Outbound", "Return", or the route for single-leg trips. */
  label: z.string(),
  origin: placeSchema,
  destination: placeSchema,
  /** From the booking (what was booked). */
  scheduledDeparture: offsetDateTimeSchema,
  scheduledArrival: offsetDateTimeSchema,
  /** From the provider, when it reports one; null otherwise. */
  estimatedDeparture: offsetDateTimeSchema.nullable(),
  estimatedArrival: offsetDateTimeSchema.nullable(),
  /** Minutes late, from the provider or derived from its estimate; null when unknown. */
  delayMinutes: z.number().int().nullable(),
  /** `scheduled` when no provider information exists. */
  state: tripLegStateSchema,
});
export type TripLeg = z.infer<typeof tripLegSchema>;

export const tripStatusSchema = z.object({
  reference: bookingReferenceSchema,
  freshness: tripFreshnessSchema,
  /** One sentence explaining the freshness (shown to the traveller). */
  explanation: z.string(),
  source: tripSourceSchema.nullable(),
  /** The provider's display name, when there is one. */
  providerName: z.string().nullable(),
  /** True for the demo provider: simulated, never verified. */
  simulated: z.boolean(),
  /** When the provider observed the status shown. */
  observedAt: offsetDateTimeSchema.nullable(),
  /** When Wayora last asked the provider. */
  checkedAt: offsetDateTimeSchema.nullable(),
  /** Empty for bookings without scheduled legs (hotels, holidays…). */
  legs: z.array(tripLegSchema),
  refresh: z.object({
    /** Whether asking the provider now is possible. */
    available: z.boolean(),
    /** Earliest time a new check would actually call the provider. */
    nextAllowedAt: offsetDateTimeSchema.nullable(),
  }),
});
export type TripStatus = z.infer<typeof tripStatusSchema>;

// ─── Disruptions ─────────────────────────────────────────────────────────

export const disruptionTypeSchema = z.enum([
  'departure_delay',
  'arrival_delay',
  'cancellation',
  'schedule_change',
  'service_disruption',
  'booking_change',
]);
export type DisruptionType = z.infer<typeof disruptionTypeSchema>;

export const disruptionSeveritySchema = z.enum(['info', 'minor', 'major', 'severe']);
export type DisruptionSeverity = z.infer<typeof disruptionSeveritySchema>;

/**
 * `unknown`: recorded as active, but the latest status isn't current (the
 * provider couldn't be reached since), so it may have changed.
 */
export const disruptionStateSchema = z.enum(['active', 'resolved', 'unknown']);
export type DisruptionState = z.infer<typeof disruptionStateSchema>;

export const tripDisruptionSchema = z.object({
  id: z.uuid(),
  type: disruptionTypeSchema,
  severity: disruptionSeveritySchema,
  state: disruptionStateSchema,
  source: tripSourceSchema,
  simulated: z.boolean(),
  providerName: z.string(),
  /** Written by Wayora from the normalized data. */
  title: z.string(),
  description: z.string(),
  legLabel: z.string().nullable(),
  /** What changed (null where the provider didn't say). */
  changes: z.object({
    scheduledDeparture: offsetDateTimeSchema.nullable(),
    newDeparture: offsetDateTimeSchema.nullable(),
    scheduledArrival: offsetDateTimeSchema.nullable(),
    newArrival: offsetDateTimeSchema.nullable(),
    delayMinutes: z.number().int().nullable(),
  }),
  firstDetectedAt: offsetDateTimeSchema,
  lastObservedAt: offsetDateTimeSchema,
  resolvedAt: offsetDateTimeSchema.nullable(),
});
export type TripDisruption = z.infer<typeof tripDisruptionSchema>;

export const tripDisruptionsQuerySchema = z
  .object({ state: z.enum(['open', 'all']).default('open') })
  .strict();

export const tripDisruptionListSchema = z.object({
  reference: bookingReferenceSchema,
  items: z.array(tripDisruptionSchema),
  /** Wayora never changes a booking because of a disruption; this says so. */
  notice: z.string(),
});
export type TripDisruptionList = z.infer<typeof tripDisruptionListSchema>;

// ─── Live updates (Server-Sent Events) ───────────────────────────────────

/** The `data` of a `trip-event` message on GET /bookings/:reference/events. */
export const tripStreamMessageSchema = z.object({
  /** Event sequence id (also the SSE `id`). Refetch the timeline to read it. */
  seq: z.string(),
  reference: bookingReferenceSchema,
});
export type TripStreamMessage = z.infer<typeof tripStreamMessageSchema>;

/** What the timeline entry types are about. */
export function tripEventKind(type: TripEventType): TripEventKind {
  if (type.startsWith('booking_')) return 'booking';
  if (type.startsWith('payment_')) return 'payment';
  if (type.endsWith('_reminder')) return 'reminder';
  if (type === 'status_changed') return 'status';
  return 'disruption';
}
