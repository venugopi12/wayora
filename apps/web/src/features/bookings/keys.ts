import type { BookingView } from '@wayora/contracts';
import { authKeys } from '../auth/AuthProvider';

/**
 * React Query keys for bookings. They live under `account`, so signing out
 * (or the session ending) drops every cached booking with the rest of the
 * previous user's data.
 */
export const bookingKeys = {
  lists: [...authKeys.account, 'bookings', 'list'] as const,
  list: (view: BookingView, page: number) =>
    [...authKeys.account, 'bookings', 'list', view, page] as const,
  detail: (reference: string) => [...authKeys.account, 'bookings', 'detail', reference] as const,
};

/** Payments (Phase 13), also under `account`. */
export const paymentKeys = {
  detail: (id: string) => [...authKeys.account, 'payments', 'detail', id] as const,
  forBooking: (reference: string) =>
    [...authKeys.account, 'payments', 'booking', reference] as const,
};
