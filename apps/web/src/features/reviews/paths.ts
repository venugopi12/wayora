/** Review paths (Phase 28, docs/reviews.md#web). Icon-free. */

export const MY_REVIEWS_PATH = '/reviews';
export const WRITE_REVIEW_PATH = '/reviews/write';
export const editReviewPath = (id: string) => `/reviews/${encodeURIComponent(id)}/edit`;

/** /reviews/write about one booking, or one destination. */
export const writeReviewPath = (about: { booking: string } | { destination: string }) =>
  'booking' in about
    ? `${WRITE_REVIEW_PATH}?booking=${encodeURIComponent(about.booking)}`
    : `${WRITE_REVIEW_PATH}?destination=${encodeURIComponent(about.destination)}`;
