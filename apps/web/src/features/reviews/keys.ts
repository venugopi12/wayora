import { authKeys } from '../auth/AuthProvider';

/**
 * Review queries live under `account`: public lists carry the viewer's own
 * votes and reports, so signing out (or switching account) drops them.
 */
const root = [...authKeys.account, 'reviews'] as const;
export const reviewKeys = {
  all: root,
  subject: (type: string, key: string) => [...root, 'subject', type, key] as const,
  list: (type: string, key: string, params: object) =>
    [...root, 'subject', type, key, params] as const,
  mine: [...root, 'mine'] as const,
  minePage: (page: number) => [...root, 'mine', 'page', page] as const,
  own: (id: string) => [...root, 'mine', 'review', id] as const,
  bookings: [...root, 'bookings'] as const,
  booking: (reference: string) => [...root, 'bookings', reference] as const,
  destination: (slug: string) => [...root, 'destination', slug] as const,
};
