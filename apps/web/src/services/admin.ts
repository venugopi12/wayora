import {
  adminAuditListSchema,
  adminBookingDetailSchema,
  adminBookingListSchema,
  adminHealthSchema,
  adminMeSchema,
  adminNotificationHealthSchema,
  adminOverviewSchema,
  adminPaymentDetailSchema,
  adminPaymentListSchema,
  adminSearchAnalyticsSchema,
  adminUserDetailSchema,
  adminUserListSchema,
  type AdminRange,
  type AdminReservationResolve,
} from '@wayora/contracts';
import { api } from './api';

/*
 * Admin dashboard API (docs/admin.md#api). Every call is authorized on the
 * server by the session's role; nothing here sends a role or user identity.
 * Read-only, except the two reservation actions (admins only).
 */

/** Query string from a filter object, skipping empty values. */
export function queryString(filters: Record<string, string | number | undefined | null>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

type Filters = Record<string, string | number | undefined>;
const opts = (signal?: AbortSignal) => (signal ? { signal } : {});

export const adminApi = {
  me: (signal?: AbortSignal) =>
    api.request('/admin/me', { schema: adminMeSchema, ...opts(signal) }),
  overview: (range: AdminRange, signal?: AbortSignal) =>
    api.request(`/admin/overview${queryString({ range })}`, {
      schema: adminOverviewSchema,
      ...opts(signal),
    }),
  users: (filters: Filters, signal?: AbortSignal) =>
    api.request(`/admin/users${queryString(filters)}`, {
      schema: adminUserListSchema,
      ...opts(signal),
    }),
  user: (id: string, signal?: AbortSignal) =>
    api.request(`/admin/users/${encodeURIComponent(id)}`, {
      schema: adminUserDetailSchema,
      ...opts(signal),
    }),
  bookings: (filters: Filters, signal?: AbortSignal) =>
    api.request(`/admin/bookings${queryString(filters)}`, {
      schema: adminBookingListSchema,
      ...opts(signal),
    }),
  booking: (reference: string, signal?: AbortSignal) =>
    api.request(`/admin/bookings/${encodeURIComponent(reference)}`, {
      schema: adminBookingDetailSchema,
      ...opts(signal),
    }),
  // The only admin writes (Phase 23): neither sends a reservation to a supplier.
  /** One read-only status lookup with the supplier now. */
  recheckReservation: (reference: string) =>
    api.request(`/admin/bookings/${encodeURIComponent(reference)}/reservation/recheck`, {
      method: 'POST',
      schema: adminBookingDetailSchema,
    }),
  /** Records an outcome staff confirmed with the supplier (with a reason). */
  resolveReservation: (reference: string, body: AdminReservationResolve) =>
    api.request(`/admin/bookings/${encodeURIComponent(reference)}/reservation/resolve`, {
      method: 'POST',
      body,
      schema: adminBookingDetailSchema,
    }),
  payments: (filters: Filters, signal?: AbortSignal) =>
    api.request(`/admin/payments${queryString(filters)}`, {
      schema: adminPaymentListSchema,
      ...opts(signal),
    }),
  payment: (id: string, signal?: AbortSignal) =>
    api.request(`/admin/payments/${encodeURIComponent(id)}`, {
      schema: adminPaymentDetailSchema,
      ...opts(signal),
    }),
  searchAnalytics: (range: AdminRange, signal?: AbortSignal) =>
    api.request(`/admin/search-analytics${queryString({ range })}`, {
      schema: adminSearchAnalyticsSchema,
      ...opts(signal),
    }),
  notifications: (range: AdminRange, signal?: AbortSignal) =>
    api.request(`/admin/notifications${queryString({ range })}`, {
      schema: adminNotificationHealthSchema,
      ...opts(signal),
    }),
  auditLogs: (filters: Filters, signal?: AbortSignal) =>
    api.request(`/admin/audit-logs${queryString(filters)}`, {
      schema: adminAuditListSchema,
      ...opts(signal),
    }),
  health: (signal?: AbortSignal) =>
    api.request('/admin/health', { schema: adminHealthSchema, ...opts(signal) }),
};
