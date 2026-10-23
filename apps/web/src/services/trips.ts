import {
  API_V1_PREFIX,
  tripDisruptionListSchema,
  tripStatusSchema,
  tripTimelineSchema,
  type TripDisruptionList,
  type TripStatus,
  type TripTimeline,
} from '@wayora/contracts';
import { publicEnv } from '../lib/env';
import { api } from './api';

/*
 * Trip tracking (docs/trips.md#api). The booking is addressed by its
 * reference; whose it is comes from the session cookie on the server.
 */

const base = (reference: string) => `/bookings/${encodeURIComponent(reference)}`;
const opts = (signal?: AbortSignal) => (signal ? { signal } : {});

export function getTripTimeline(
  reference: string,
  after: string | null,
  signal?: AbortSignal,
): Promise<TripTimeline> {
  const query = after ? `?${new URLSearchParams({ after }).toString()}` : '';
  return api.request(`${base(reference)}/timeline${query}`, {
    schema: tripTimelineSchema,
    ...opts(signal),
  });
}

export function getTripStatus(reference: string, signal?: AbortSignal): Promise<TripStatus> {
  return api.request(`${base(reference)}/status`, { schema: tripStatusSchema, ...opts(signal) });
}

export function refreshTripStatus(reference: string): Promise<TripStatus> {
  return api.request(`${base(reference)}/status/refresh`, {
    method: 'POST',
    schema: tripStatusSchema,
    timeoutMs: 20_000,
  });
}

export function getTripDisruptions(
  reference: string,
  signal?: AbortSignal,
): Promise<TripDisruptionList> {
  return api.request(`${base(reference)}/disruptions?state=open`, {
    schema: tripDisruptionListSchema,
    ...opts(signal),
  });
}

/** Server-Sent Events URL for live updates (cookies are sent: withCredentials). */
export function tripEventsUrl(reference: string): string {
  return `${publicEnv.apiBaseUrl}${API_V1_PREFIX}${base(reference)}/events`;
}
