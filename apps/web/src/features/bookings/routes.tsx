/*
 * Demo booking pages (Phase 12) share one lazily loaded chunk: checkout,
 * confirmation, My trips, booking details and demo payments. All are signed-in only
 * (RequireAuth in app/routes.tsx), and the API checks ownership again.
 */
export { CheckoutRoute } from './CheckoutRoute';
export { ConfirmationRoute, TripDetailRoute, TripsRoute } from './TripsRoutes';
export { PayRoute, PaymentStatusRoute } from './PaymentRoutes';
