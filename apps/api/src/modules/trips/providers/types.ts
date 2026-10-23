import { z } from 'zod';
import type { SearchServiceType } from '@wayora/contracts';

/*
 * Travel-status providers (docs/trips.md#providers).
 *
 * A provider answers "what is the status of this booked journey?" in one
 * normalized shape, validated before Wayora uses it, so nothing provider-
 * specific reaches the database or the web app. Provider text is never
 * stored or shown: titles and descriptions are written by Wayora from the
 * normalized fields.
 */

/** A scheduled leg, taken from the booking's offer snapshot (what was booked). */
export interface ScheduledLeg {
  index: number;
  label: string;
  origin: { name: string; code: string | null; cityName: string };
  destination: { name: string; code: string | null; cityName: string };
  /** ISO 8601 with offset, as booked. */
  departAt: string;
  arriveAt: string;
  /** What a provider would look the journey up by (flight numbers, train number, operator). */
  serviceRef: string;
}

export interface StatusQuery {
  reference: string;
  serviceType: SearchServiceType;
  legs: ScheduledLeg[];
}

/** The answer every provider must give (unknown fields: omitted or null). */
const iso = z.iso.datetime({ offset: true });
export const providerReportSchema = z.object({
  /** When the provider's information was true (not when we asked). */
  observedAt: iso,
  legs: z
    .array(
      z.object({
        index: z.number().int().min(0).max(9),
        state: z.enum(['scheduled', 'delayed', 'departed', 'arrived', 'cancelled', 'unknown']),
        estimatedDeparture: iso.nullable().optional(),
        estimatedArrival: iso.nullable().optional(),
        delayMinutes: z.number().int().min(-1440).max(10080).nullable().optional(),
      }),
    )
    .max(10),
  disruptions: z
    .array(
      z.object({
        /** Stable id for the same disruption across polls. */
        key: z.string().min(1).max(128),
        type: z.enum([
          'departure_delay',
          'arrival_delay',
          'cancellation',
          'schedule_change',
          'service_disruption',
          'booking_change',
        ]),
        severity: z.enum(['info', 'minor', 'major', 'severe']),
        state: z.enum(['active', 'resolved']),
        legIndex: z.number().int().min(0).max(9).nullable().optional(),
        newDeparture: iso.nullable().optional(),
        newArrival: iso.nullable().optional(),
        delayMinutes: z.number().int().min(-1440).max(10080).nullable().optional(),
      }),
    )
    .max(20),
});
export type ProviderReport = z.infer<typeof providerReportSchema>;

export interface TravelStatusProvider {
  /** Stable id, stored with every observation (e.g. `demo-status`). */
  readonly id: string;
  /** Shown to travellers ("Wayora demo status (simulated)"). */
  readonly name: string;
  /** `demo` data is simulated and is never presented as verified. */
  readonly kind: 'demo' | 'live';
  supports(serviceType: SearchServiceType): boolean;
  /**
   * Returns the provider's answer (validated by the caller). Throws
   * `TravelStatusError` for known failures; anything else counts as an error.
   * Must honour `signal` (timeouts and shutdown abort it).
   */
  fetchStatus(query: StatusQuery, signal: AbortSignal): Promise<unknown>;
}

/** Normalized failure codes (stored and logged; never provider text). */
export type StatusErrorCode = 'timeout' | 'unavailable' | 'not_found' | 'invalid' | 'error';

export class TravelStatusError extends Error {
  constructor(
    readonly code: StatusErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'TravelStatusError';
  }
}
