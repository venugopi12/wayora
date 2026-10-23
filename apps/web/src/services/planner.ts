import {
  plannedTripDeletedSchema,
  plannedTripListSchema,
  plannedTripSchema,
  plannerDestinationListSchema,
  suggestionsResponseSchema,
  type CreateItineraryItemInput,
  type CreatePlannedTripInput,
  type PlannedTrip,
  type PlannedTripList,
  type PlannerDestinationList,
  type PlannerInterest,
  type SuggestionsResponse,
  type UpdateItineraryItemInput,
  type UpdatePlannedTripInput,
} from '@wayora/contracts';
import { api } from './api';

/*
 * Trip planner (docs/planner.md#api). Everything is the signed-in user's own
 * (session cookie); nothing here sends a user id. Writes return the whole
 * updated trip. Creating POSTs take an Idempotency-Key: reuse it for retries
 * of the same attempt.
 */

const trip = (id: string) => `/planner/trips/${encodeURIComponent(id)}`;
const opt = (signal?: AbortSignal) => (signal ? { signal } : {});

export function listPlannerDestinations(signal?: AbortSignal): Promise<PlannerDestinationList> {
  return api.request('/planner/destinations', {
    schema: plannerDestinationListSchema,
    ...opt(signal),
  });
}

export function listPlannedTrips(
  query: { page: number; pageSize: number },
  signal?: AbortSignal,
): Promise<PlannedTripList> {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  return api.request(`/planner/trips?${params.toString()}`, {
    schema: plannedTripListSchema,
    ...opt(signal),
  });
}

export function getPlannedTrip(id: string, signal?: AbortSignal): Promise<PlannedTrip> {
  return api.request(trip(id), { schema: plannedTripSchema, ...opt(signal) });
}

export function createPlannedTrip(
  body: CreatePlannedTripInput,
  idempotencyKey: string,
): Promise<PlannedTrip> {
  return api.request('/planner/trips', {
    method: 'POST',
    body,
    schema: plannedTripSchema,
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}

export function updatePlannedTrip(id: string, body: UpdatePlannedTripInput): Promise<PlannedTrip> {
  return api.request(trip(id), { method: 'PATCH', body, schema: plannedTripSchema });
}

export async function deletePlannedTrip(id: string): Promise<void> {
  await api.request(trip(id), { method: 'DELETE', schema: plannedTripDeletedSchema });
}

export function addItineraryItem(
  tripId: string,
  body: CreateItineraryItemInput,
  idempotencyKey: string,
): Promise<PlannedTrip> {
  return api.request(`${trip(tripId)}/items`, {
    method: 'POST',
    body,
    schema: plannedTripSchema,
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}

export function updateItineraryItem(
  tripId: string,
  itemId: string,
  body: UpdateItineraryItemInput,
): Promise<PlannedTrip> {
  return api.request(`${trip(tripId)}/items/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    body,
    schema: plannedTripSchema,
  });
}

export function deleteItineraryItem(tripId: string, itemId: string): Promise<PlannedTrip> {
  return api.request(`${trip(tripId)}/items/${encodeURIComponent(itemId)}`, {
    method: 'DELETE',
    schema: plannedTripSchema,
  });
}

export function duplicateItineraryItem(
  tripId: string,
  itemId: string,
  body: { day?: string },
  idempotencyKey: string,
): Promise<PlannedTrip> {
  return api.request(`${trip(tripId)}/items/${encodeURIComponent(itemId)}/duplicate`, {
    method: 'POST',
    body,
    schema: plannedTripSchema,
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}

export function reorderItineraryDay(
  tripId: string,
  day: string,
  itemIds: string[],
): Promise<PlannedTrip> {
  return api.request(`${trip(tripId)}/days/${encodeURIComponent(day)}/order`, {
    method: 'PUT',
    body: { itemIds },
    schema: plannedTripSchema,
  });
}

export function getSuggestions(
  tripId: string,
  category: PlannerInterest | null,
  signal?: AbortSignal,
): Promise<SuggestionsResponse> {
  const q = category ? `?category=${encodeURIComponent(category)}` : '';
  return api.request(`${trip(tripId)}/suggestions${q}`, {
    schema: suggestionsResponseSchema,
    ...opt(signal),
  });
}
