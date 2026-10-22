import type { SearchServiceType } from '@wayora/contracts';
import { ACCOUNT_PATHS } from '../navigation/config';

/*
 * Booking URLs (docs/bookings.md#web). They carry identifiers only (offer id,
 * search id, the results query, a booking reference), never personal data.
 *
 *   /book/:serviceType/:offerId?sid=&from=[&step=details|review]
 *   /trips?view=&page=
 *   /trips/:reference
 *   /trips/:reference/confirmation
 *   /trips/:reference/pay                      (payment review, Phase 13)
 *   /trips/:reference/payments/:paymentId      (payment status)
 */

export const BOOK_PATH = '/book/:serviceType/:resultId';

export function bookPath(
  serviceType: SearchServiceType,
  offerId: string,
  searchId: string,
  resultsSearch: string,
): string {
  const query = new URLSearchParams({ sid: searchId, from: resultsSearch.replace(/^\?/, '') });
  return `/book/${serviceType}/${encodeURIComponent(offerId)}?${query.toString()}`;
}

export const tripPath = (reference: string) => `${ACCOUNT_PATHS.trips}/${reference}`;
export const confirmationPath = (reference: string) => `${tripPath(reference)}/confirmation`;
export const payPath = (reference: string) => `${tripPath(reference)}/pay`;
export const paymentPath = (reference: string, paymentId: string) =>
  `${tripPath(reference)}/payments/${paymentId}`;

export type CheckoutStep = 'offer' | 'details' | 'review';
export const CHECKOUT_STEPS: readonly { id: CheckoutStep; label: string }[] = [
  { id: 'offer', label: 'Offer' },
  { id: 'details', label: 'Travellers' },
  { id: 'review', label: 'Review and confirm' },
];

export function readStep(value: string | null): CheckoutStep {
  return value === 'details' || value === 'review' ? value : 'offer';
}
