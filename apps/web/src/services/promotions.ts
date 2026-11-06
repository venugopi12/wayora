import {
  adminPromotionListSchema,
  adminPromotionSchema,
  adminPromotionUsageSchema,
  bookingPricingSchema,
  promotionListSchema,
  type AdminPromotion,
  type AdminPromotionInput,
  type AdminPromotionList,
  type AdminPromotionListQuery,
  type AdminPromotionUpdate,
  type AdminPromotionUsage,
  type BookingPricing,
  type PromotionOffer,
  type TravelCategorySlug,
} from '@wayora/contracts';
import { api } from './api';

/*
 * Promotions (Phase 26, docs/promotions.md#api). The server finds, checks,
 * prices and reserves every promotion; the client sends a coupon code and
 * shows the breakdown it gets back.
 */

const query = (params: Record<string, unknown>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' || typeof v === 'number') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
};

export async function getPromotions(
  category?: TravelCategorySlug,
  signal?: AbortSignal,
): Promise<PromotionOffer[]> {
  const data = await api.request(`/promotions${query({ category })}`, {
    schema: promotionListSchema,
    ...(signal ? { signal } : {}),
  });
  return data.items;
}

const pricingPath = (reference: string) => `/bookings/${encodeURIComponent(reference)}/pricing`;

export function getBookingPricing(
  reference: string,
  signal?: AbortSignal,
): Promise<BookingPricing> {
  return api.request(pricingPath(reference), {
    schema: bookingPricingSchema,
    ...(signal ? { signal } : {}),
  });
}

export function applyCoupon(reference: string, code: string): Promise<BookingPricing> {
  return api.request(`${pricingPath(reference)}/coupon`, {
    method: 'PUT',
    body: { code },
    schema: bookingPricingSchema,
  });
}

export function removeCoupon(reference: string): Promise<BookingPricing> {
  return api.request(`${pricingPath(reference)}/coupon`, {
    method: 'DELETE',
    schema: bookingPricingSchema,
  });
}

// ─── Admin ────────────────────────────────────────────────────────────────

export function adminPromotions(
  params: AdminPromotionListQuery,
  signal?: AbortSignal,
): Promise<AdminPromotionList> {
  return api.request(`/admin/promotions${query(params)}`, {
    schema: adminPromotionListSchema,
    ...(signal ? { signal } : {}),
  });
}

export function adminPromotion(id: string, signal?: AbortSignal): Promise<AdminPromotion> {
  return api.request(`/admin/promotions/${encodeURIComponent(id)}`, {
    schema: adminPromotionSchema,
    ...(signal ? { signal } : {}),
  });
}

export function adminPromotionUsage(
  id: string,
  params: { page?: number; status?: string },
  signal?: AbortSignal,
): Promise<AdminPromotionUsage> {
  return api.request(`/admin/promotions/${encodeURIComponent(id)}/usage${query(params)}`, {
    schema: adminPromotionUsageSchema,
    ...(signal ? { signal } : {}),
  });
}

export function adminCreatePromotion(body: AdminPromotionInput): Promise<AdminPromotion> {
  return api.request('/admin/promotions', { method: 'POST', body, schema: adminPromotionSchema });
}

export function adminUpdatePromotion(
  id: string,
  body: AdminPromotionUpdate,
): Promise<AdminPromotion> {
  return api.request(`/admin/promotions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
    schema: adminPromotionSchema,
  });
}

export function adminSetPromotionActive(
  id: string,
  active: boolean,
  reason: string,
): Promise<AdminPromotion> {
  return api.request(`/admin/promotions/${encodeURIComponent(id)}/status`, {
    method: 'POST',
    body: { active, reason },
    schema: adminPromotionSchema,
  });
}
