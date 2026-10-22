import {
  paymentListResponseSchema,
  paymentSchema,
  type CreatePaymentRequest,
  type Payment,
  type PaymentListResponse,
} from '@wayora/contracts';
import { api } from './api';

/*
 * Payments (docs/payments.md#api). The server decides the amount (from the
 * booking) and the outcome (from the provider); the client only says which
 * booking, what amount it showed, and, in demo mode, which test outcome to
 * simulate. No card or bank details exist anywhere in this flow.
 */

/** POST /bookings/:reference/payments. Reuse `idempotencyKey` for retries of one attempt. */
export function createPayment(
  reference: string,
  body: CreatePaymentRequest,
  idempotencyKey: string,
): Promise<Payment> {
  return api.request(`/bookings/${encodeURIComponent(reference)}/payments`, {
    method: 'POST',
    body,
    schema: paymentSchema,
    headers: { 'Idempotency-Key': idempotencyKey },
    timeoutMs: 20_000,
  });
}

export function getPayment(id: string, signal?: AbortSignal): Promise<Payment> {
  return api.request(`/payments/${encodeURIComponent(id)}`, {
    schema: paymentSchema,
    ...(signal ? { signal } : {}),
  });
}

export function cancelPayment(id: string): Promise<Payment> {
  return api.request(`/payments/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    schema: paymentSchema,
  });
}

export function listBookingPayments(
  reference: string,
  signal?: AbortSignal,
): Promise<PaymentListResponse> {
  return api.request(`/bookings/${encodeURIComponent(reference)}/payments`, {
    schema: paymentListResponseSchema,
    ...(signal ? { signal } : {}),
  });
}
