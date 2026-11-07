import {
  adminReviewListSchema,
  adminReviewSchema,
  adminReviewSubjectsSchema,
  bookingReviewStateSchema,
  destinationReviewStateSchema,
  ownReviewListSchema,
  ownReviewSchema,
  reviewListSchema,
  reviewMetricsSchema,
  reviewableBookingListSchema,
  type AdminReview,
  type AdminReviewList,
  type AdminReviewListQuery,
  type AdminReviewSubjects,
  type BookingReviewState,
  type CreateReviewInput,
  type DestinationReviewState,
  type ModerateReviewInput,
  type OwnReview,
  type OwnReviewList,
  type ReportReviewInput,
  type ReviewList,
  type ReviewListQuery,
  type ReviewMetrics,
  type ReviewMetricsRange,
  type ReviewSubjectType,
  type UpdateReviewInput,
} from '@wayora/contracts';
import { z } from 'zod';
import { api } from './api';

/*
 * Reviews (Phase 28, docs/reviews.md#api). The client sends what the
 * customer wrote and the stars they chose; the server decides the subject,
 * verification, status, averages and vote counts.
 */

const query = (params: Record<string, unknown>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' || typeof v === 'number') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
};
const opts = (signal?: AbortSignal) => (signal ? { signal } : {});
const id = (value: string) => encodeURIComponent(value);

export const getReviews = (params: ReviewListQuery, signal?: AbortSignal): Promise<ReviewList> =>
  api.request(`/reviews${query(params)}`, { schema: reviewListSchema, ...opts(signal) });

export const getMyReviews = (page: number, signal?: AbortSignal): Promise<OwnReviewList> =>
  api.request(`/reviews/mine${query({ page })}`, { schema: ownReviewListSchema, ...opts(signal) });

export const getMyReview = (reviewId: string, signal?: AbortSignal): Promise<OwnReview> =>
  api.request(`/reviews/mine/${id(reviewId)}`, { schema: ownReviewSchema, ...opts(signal) });

export const getReviewableBookings = (
  signal?: AbortSignal,
): Promise<{ items: BookingReviewState[] }> =>
  api.request('/reviews/bookings', { schema: reviewableBookingListSchema, ...opts(signal) });

export const getBookingReviewState = (
  reference: string,
  signal?: AbortSignal,
): Promise<BookingReviewState> =>
  api.request(`/reviews/bookings/${id(reference)}`, {
    schema: bookingReviewStateSchema,
    ...opts(signal),
  });

export const getDestinationReviewState = (
  slug: string,
  signal?: AbortSignal,
): Promise<DestinationReviewState> =>
  api.request(`/reviews/destinations/${id(slug)}`, {
    schema: destinationReviewStateSchema,
    ...opts(signal),
  });

export const createReview = (body: CreateReviewInput): Promise<OwnReview> =>
  api.request('/reviews', { method: 'POST', body, schema: ownReviewSchema });

export const updateReview = (reviewId: string, body: UpdateReviewInput): Promise<OwnReview> =>
  api.request(`/reviews/${id(reviewId)}`, { method: 'PATCH', body, schema: ownReviewSchema });

const voteSchema = z.object({ helpful: z.number().int(), votedHelpful: z.boolean() });
export const setHelpful = (reviewId: string, helpful: boolean) =>
  api.request(`/reviews/${id(reviewId)}/helpful`, {
    method: helpful ? 'PUT' : 'DELETE',
    schema: voteSchema,
  });

export const reportReview = (reviewId: string, body: ReportReviewInput) =>
  api.request(`/reviews/${id(reviewId)}/reports`, {
    method: 'POST',
    body,
    schema: z.object({ reported: z.literal(true) }),
  });

// ─── Admin ────────────────────────────────────────────────────────────────

export const adminReviews = (
  params: AdminReviewListQuery,
  signal?: AbortSignal,
): Promise<AdminReviewList> =>
  api.request(`/admin/reviews${query(params)}`, { schema: adminReviewListSchema, ...opts(signal) });

export const adminReview = (reviewId: string, signal?: AbortSignal): Promise<AdminReview> =>
  api.request(`/admin/reviews/${id(reviewId)}`, { schema: adminReviewSchema, ...opts(signal) });

export const adminModerateReview = (
  reviewId: string,
  body: ModerateReviewInput,
): Promise<AdminReview> =>
  api.request(`/admin/reviews/${id(reviewId)}/moderate`, {
    method: 'POST',
    body,
    schema: adminReviewSchema,
  });

export const adminDismissReports = (
  reviewId: string,
  body: { reason: string; revision: number },
): Promise<AdminReview> =>
  api.request(`/admin/reviews/${id(reviewId)}/reports/dismiss`, {
    method: 'POST',
    body,
    schema: adminReviewSchema,
  });

export const adminReviewMetrics = (
  range: ReviewMetricsRange,
  signal?: AbortSignal,
): Promise<ReviewMetrics> =>
  api.request(`/admin/reviews/metrics${query({ range })}`, {
    schema: reviewMetricsSchema,
    ...opts(signal),
  });

export const adminReviewSubjects = (
  params: { type?: ReviewSubjectType; page?: number },
  signal?: AbortSignal,
): Promise<AdminReviewSubjects> =>
  api.request(`/admin/reviews/subjects${query(params)}`, {
    schema: adminReviewSubjectsSchema,
    ...opts(signal),
  });
