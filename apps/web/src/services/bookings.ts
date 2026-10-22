import {
  bookingListResponseSchema,
  bookingSchema,
  type Booking,
  type BookingListQuery,
  type BookingListResponse,
  type CreateBookingRequest,
} from '@wayora/contracts';
import { api } from './api';

/*
 * Demo bookings (docs/bookings.md#api). Whose bookings these are is decided
 * by the session cookie on the server; nothing here sends a user id. Traveller
 * details travel only in request bodies, never in URLs.
 */

/**
 * POST /api/v1/bookings. `idempotencyKey` must be the same for every retry of
 * one booking attempt (double clicks, network retries) and new for a changed
 * request: the server then creates the booking at most once.
 */
export function createBooking(
  body: CreateBookingRequest,
  idempotencyKey: string,
): Promise<Booking> {
  return api.request('/bookings', {
    method: 'POST',
    body,
    schema: bookingSchema,
    headers: { 'Idempotency-Key': idempotencyKey },
    timeoutMs: 20_000,
  });
}

export function listBookings(
  query: Required<BookingListQuery>,
  signal?: AbortSignal,
): Promise<BookingListResponse> {
  const params = new URLSearchParams({
    view: query.view,
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  return api.request(`/bookings?${params.toString()}`, {
    schema: bookingListResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

export function getBooking(reference: string, signal?: AbortSignal): Promise<Booking> {
  return api.request(`/bookings/${encodeURIComponent(reference)}`, {
    schema: bookingSchema,
    ...(signal ? { signal } : {}),
  });
}

export function cancelBooking(reference: string): Promise<Booking> {
  return api.request(`/bookings/${encodeURIComponent(reference)}/cancel`, {
    method: 'POST',
    schema: bookingSchema,
  });
}
