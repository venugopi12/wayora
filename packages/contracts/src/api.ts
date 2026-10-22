import { z } from 'zod';

/** API version prefix shared by server routing and the web API client. */
export const API_V1_PREFIX = '/api/v1';

/** Header used to propagate a request correlation ID end-to-end. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Machine-readable error codes. Clients branch on `code`, never on `message`.
 * Add new codes deliberately; removing or renaming one is a breaking change.
 */
export const apiErrorCodeSchema = z.enum([
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'INVALID_JSON',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
  // Search and offers (docs/search.md#errors).
  /** The search session is gone: expired, never existed, or unreadable. Search again. */
  'SEARCH_EXPIRED',
  /** The offer id doesn't name an offer any Wayora provider could have issued. */
  'OFFER_NOT_FOUND',
  /** A well-formed offer that isn't part of the named search (e.g. it belongs to another search). */
  'OFFER_NOT_IN_SEARCH',
  /** The travel category in the request doesn't match the search or the offer. */
  'CATEGORY_MISMATCH',
  /** The provider reports the offer is no longer available (revalidation). */
  'OFFER_UNAVAILABLE',
  /** Providers didn't answer in time. Safe to retry. */
  'PROVIDER_TIMEOUT',
  /** Providers are unavailable right now (outage, maintenance, circuit open). Retry later. */
  'PROVIDER_UNAVAILABLE',
  /** Providers failed for another reason (errors, unusable data). */
  'SEARCH_FAILED',
  // Bookings (docs/bookings.md#errors).
  /** The price differs from the one the visitor accepted (changed, or tampered). Review and confirm again. */
  'PRICE_CHANGED',
  /** The booking's status or travel date doesn't allow cancelling it. */
  'BOOKING_NOT_CANCELLABLE',
  /** This Idempotency-Key was already used with a different request. Use a new key. */
  'IDEMPOTENCY_KEY_REUSED',
  /** A request with this Idempotency-Key is still being processed. Retry shortly. */
  'IDEMPOTENCY_IN_PROGRESS',
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

/** A single field-level validation problem. `path` is dot-joined, e.g. `body.travellers.0.email`. */
export const validationIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
  code: z.string(),
});
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

export const apiErrorSchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string(),
  requestId: z.string(),
  details: z.array(validationIssueSchema).optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** Every non-2xx response body: `{ "error": { ... } }`. */
export const apiErrorEnvelopeSchema = z.object({
  error: apiErrorSchema,
});
export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;

export const responseMetaSchema = z.object({
  requestId: z.string(),
});
export type ResponseMeta = z.infer<typeof responseMetaSchema>;

/** Builds the schema for a 2xx response body: `{ "data": T, "meta": { requestId } }`. */
export function apiSuccessEnvelopeSchema<T extends z.ZodType>(data: T) {
  return z.object({
    data,
    meta: responseMetaSchema,
  });
}

export interface ApiSuccessEnvelope<T> {
  data: T;
  meta: ResponseMeta;
}
