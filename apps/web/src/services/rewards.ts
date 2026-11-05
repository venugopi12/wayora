import {
  adminRewardTransactionListSchema,
  adminRulesSchema,
  adminUserRewardsSchema,
  bookingRewardsSchema,
  rewardTransactionListSchema,
  rewardsSummarySchema,
  type AdminCreateRules,
  type AdminIssueCredit,
  type AdminPointsAdjustment,
  type AdminRewardTransactionList,
  type AdminRewardTransactionsQuery,
  type AdminRules,
  type AdminUserRewards,
  type BookingRewards,
  type RewardTransactionList,
  type RewardTransactionsQuery,
  type RewardsSummary,
} from '@wayora/contracts';
import { api } from './api';

/*
 * Loyalty (Phase 25, docs/rewards.md#api). The server calculates every
 * point, discount and amount; the client only reads results and, at
 * checkout, says how many points and how much credit the customer chose.
 */

const query = (params: Record<string, unknown>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' || typeof v === 'number') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
};

export function getRewards(signal?: AbortSignal): Promise<RewardsSummary> {
  return api.request('/rewards', { schema: rewardsSummarySchema, ...(signal ? { signal } : {}) });
}

export function getRewardTransactions(
  params: RewardTransactionsQuery,
  signal?: AbortSignal,
): Promise<RewardTransactionList> {
  return api.request(`/rewards/transactions${query(params)}`, {
    schema: rewardTransactionListSchema,
    ...(signal ? { signal } : {}),
  });
}

const bookingPath = (reference: string) => `/bookings/${encodeURIComponent(reference)}/rewards`;

export function getBookingRewards(
  reference: string,
  signal?: AbortSignal,
): Promise<BookingRewards> {
  return api.request(bookingPath(reference), {
    schema: bookingRewardsSchema,
    ...(signal ? { signal } : {}),
  });
}

export function applyBookingRewards(
  reference: string,
  body: { points: number; creditAmountMinor: string },
): Promise<BookingRewards> {
  return api.request(bookingPath(reference), {
    method: 'PUT',
    body: { ...body, confirm: true },
    schema: bookingRewardsSchema,
  });
}

export function removeBookingRewards(reference: string): Promise<BookingRewards> {
  return api.request(bookingPath(reference), { method: 'DELETE', schema: bookingRewardsSchema });
}

// ─── Admin ────────────────────────────────────────────────────────────────

export function adminRewardTransactions(
  params: AdminRewardTransactionsQuery,
  signal?: AbortSignal,
): Promise<AdminRewardTransactionList> {
  return api.request(`/admin/rewards/transactions${query(params)}`, {
    schema: adminRewardTransactionListSchema,
    ...(signal ? { signal } : {}),
  });
}

export function adminUserRewards(userId: string, signal?: AbortSignal): Promise<AdminUserRewards> {
  return api.request(`/admin/rewards/users/${encodeURIComponent(userId)}`, {
    schema: adminUserRewardsSchema,
    ...(signal ? { signal } : {}),
  });
}

export function adminAdjustPoints(userId: string, body: AdminPointsAdjustment) {
  return api.request(`/admin/rewards/users/${encodeURIComponent(userId)}/adjustments`, {
    method: 'POST',
    body,
    schema: adminUserRewardsSchema,
  });
}

export function adminIssueCredit(userId: string, body: AdminIssueCredit) {
  return api.request(`/admin/rewards/users/${encodeURIComponent(userId)}/credits`, {
    method: 'POST',
    body,
    schema: adminUserRewardsSchema,
  });
}

export function adminRevokeCredit(reference: string, reason: string) {
  return api.request(`/admin/rewards/credits/${encodeURIComponent(reference)}/revoke`, {
    method: 'POST',
    body: { reason },
    schema: adminUserRewardsSchema,
  });
}

export function adminRewardRules(signal?: AbortSignal): Promise<AdminRules> {
  return api.request('/admin/rewards/rules', {
    schema: adminRulesSchema,
    ...(signal ? { signal } : {}),
  });
}

export function adminCreateRewardRules(body: AdminCreateRules): Promise<AdminRules> {
  return api.request('/admin/rewards/rules', { method: 'POST', body, schema: adminRulesSchema });
}
