import {
  balancesSchema,
  budgetOverviewSchema,
  expenseDeletedSchema,
  expenseListSchema,
  expenseSchema,
  type Balances,
  type BudgetOverview,
  type CreateExpenseInput,
  type CreateSettlementInput,
  type Expense,
  type ExpenseList,
  type PutBudgetInput,
  type UpdateExpenseInput,
  API_V1_PREFIX,
  invitationResponseSchema,
  memberRemovedSchema,
  plannerActivityListSchema,
  receivedInvitationListSchema,
  receivedInvitationSchema,
  sentInvitationSchema,
  tripMembersSchema,
  type CreateTripInvitationInput,
  type InvitationResponse,
  type MemberRole,
  type PlannerActivityList,
  type ReceivedInvitation,
  type ReceivedInvitationList,
  type SentInvitation,
  type TripMembers,
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
import { publicEnv } from '../lib/env';
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

/** Sets one day's order; `previousOrder` is the order the change was based on. */
export function reorderItineraryDay(
  tripId: string,
  day: string,
  itemIds: string[],
  previousOrder: string[],
): Promise<PlannedTrip> {
  return api.request(`${trip(tripId)}/days/${encodeURIComponent(day)}/order`, {
    method: 'PUT',
    body: { itemIds, previousOrder },
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

// ─── Collaboration (Phase 19) ───────────────────────────────────────────

export function getTripMembers(tripId: string, signal?: AbortSignal): Promise<TripMembers> {
  return api.request(`${trip(tripId)}/members`, { schema: tripMembersSchema, ...opt(signal) });
}

export function inviteToTrip(
  tripId: string,
  body: CreateTripInvitationInput,
): Promise<SentInvitation> {
  return api.request(`${trip(tripId)}/invitations`, {
    method: 'POST',
    body,
    schema: sentInvitationSchema,
  });
}

export function revokeInvitation(tripId: string, invitationId: string): Promise<SentInvitation> {
  return api.request(`${trip(tripId)}/invitations/${encodeURIComponent(invitationId)}`, {
    method: 'DELETE',
    schema: sentInvitationSchema,
  });
}

export function changeMemberRole(
  tripId: string,
  memberId: string,
  role: MemberRole,
): Promise<TripMembers> {
  return api.request(`${trip(tripId)}/members/${encodeURIComponent(memberId)}`, {
    method: 'PATCH',
    body: { role },
    schema: tripMembersSchema,
  });
}

/** Removes a member (owner), or leaves the plan (your own membership). */
export async function removeMember(tripId: string, memberId: string): Promise<void> {
  await api.request(`${trip(tripId)}/members/${encodeURIComponent(memberId)}`, {
    method: 'DELETE',
    schema: memberRemovedSchema,
  });
}

export function getPlanActivity(
  tripId: string,
  before: number | null,
  signal?: AbortSignal,
): Promise<PlannerActivityList> {
  const q = before ? `?before=${before}` : '';
  return api.request(`${trip(tripId)}/activity${q}`, {
    schema: plannerActivityListSchema,
    ...opt(signal),
  });
}

export function listReceivedInvitations(signal?: AbortSignal): Promise<ReceivedInvitationList> {
  return api.request('/planner/invitations', {
    schema: receivedInvitationListSchema,
    ...opt(signal),
  });
}

export function getReceivedInvitation(
  invitationId: string,
  signal?: AbortSignal,
): Promise<ReceivedInvitation> {
  return api.request(`/planner/invitations/${encodeURIComponent(invitationId)}`, {
    schema: receivedInvitationSchema,
    ...opt(signal),
  });
}

export function respondToInvitation(
  invitationId: string,
  answer: 'accept' | 'decline',
): Promise<InvitationResponse> {
  return api.request(`/planner/invitations/${encodeURIComponent(invitationId)}/${answer}`, {
    method: 'POST',
    schema: invitationResponseSchema,
  });
}

/** The plan's live-update stream (Server-Sent Events; session cookie). */
export function planEventsUrl(tripId: string): string {
  return `${publicEnv.apiBaseUrl}${API_V1_PREFIX}${trip(tripId)}/events`;
}

// ─── Budget and expenses (Phase 20) ─────────────────────────────────────

export function getBudget(tripId: string, signal?: AbortSignal): Promise<BudgetOverview> {
  return api.request(`${trip(tripId)}/budget`, { schema: budgetOverviewSchema, ...opt(signal) });
}

export function putBudget(tripId: string, body: PutBudgetInput): Promise<BudgetOverview> {
  return api.request(`${trip(tripId)}/budget`, {
    method: 'PUT',
    body,
    schema: budgetOverviewSchema,
  });
}

export function removeBudget(tripId: string, version: number): Promise<BudgetOverview> {
  return api.request(`${trip(tripId)}/budget?version=${version}`, {
    method: 'DELETE',
    schema: budgetOverviewSchema,
  });
}

/** List filters, as query-string values (the API validates them). */
export interface ExpenseFilters {
  category?: string;
  status?: string;
  payer?: string;
  participant?: string;
  from?: string;
  to?: string;
  sort?: string;
  page?: string;
}

export function listExpenses(
  tripId: string,
  filters: ExpenseFilters,
  signal?: AbortSignal,
): Promise<ExpenseList> {
  const params = new URLSearchParams(
    Object.entries({ pageSize: '100', ...filters }).filter(
      ([, v]) => v !== undefined && v !== '',
    ) as [string, string][],
  );
  return api.request(`${trip(tripId)}/expenses?${params.toString()}`, {
    schema: expenseListSchema,
    ...opt(signal),
  });
}

export function createExpense(
  tripId: string,
  body: CreateExpenseInput,
  idempotencyKey: string,
): Promise<Expense> {
  return api.request(`${trip(tripId)}/expenses`, {
    method: 'POST',
    body,
    schema: expenseSchema,
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}

export function addBookingExpense(tripId: string, idempotencyKey: string): Promise<Expense> {
  return api.request(`${trip(tripId)}/expenses/from-booking`, {
    method: 'POST',
    body: {},
    schema: expenseSchema,
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}

export function updateExpense(
  tripId: string,
  expenseId: string,
  body: UpdateExpenseInput,
): Promise<Expense> {
  return api.request(`${trip(tripId)}/expenses/${encodeURIComponent(expenseId)}`, {
    method: 'PUT',
    body,
    schema: expenseSchema,
  });
}

export async function deleteExpense(tripId: string, expenseId: string): Promise<void> {
  await api.request(`${trip(tripId)}/expenses/${encodeURIComponent(expenseId)}`, {
    method: 'DELETE',
    schema: expenseDeletedSchema,
  });
}

export function getBalances(tripId: string, signal?: AbortSignal): Promise<Balances> {
  return api.request(`${trip(tripId)}/balances`, { schema: balancesSchema, ...opt(signal) });
}

export function recordSettlement(
  tripId: string,
  body: CreateSettlementInput,
  idempotencyKey: string,
): Promise<Balances> {
  return api.request(`${trip(tripId)}/settlements`, {
    method: 'POST',
    body,
    schema: balancesSchema,
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}

export function deleteSettlement(tripId: string, settlementId: string): Promise<Balances> {
  return api.request(`${trip(tripId)}/settlements/${encodeURIComponent(settlementId)}`, {
    method: 'DELETE',
    schema: balancesSchema,
  });
}
