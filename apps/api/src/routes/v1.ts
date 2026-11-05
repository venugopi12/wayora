import { Router, type RequestHandler } from 'express';
import { adminRouter, type AdminRouterOptions } from '../modules/admin/admin.routes.js';
import { tripsRouter, type TripsRouterOptions } from '../modules/trips/trips.routes.js';
import {
  assistantRouter,
  type AssistantRouterOptions,
} from '../modules/assistant/assistant.routes.js';
import { authRouter, type AuthRouterOptions } from '../modules/auth/auth.routes.js';
import { bookingsRouter } from '../modules/bookings/bookings.routes.js';
import type { BookingsService } from '../modules/bookings/bookings.service.js';
import { catalogRouter } from '../modules/catalog/catalog.routes.js';
import {
  bookingPaymentsRouter,
  paymentEventsRouter,
  paymentsRouter,
} from '../modules/payments/payments.routes.js';
import type { PaymentsService } from '../modules/payments/payments.service.js';
import { notificationsRouter } from '../modules/notifications/notifications.routes.js';
import type { NotificationsService } from '../modules/notifications/notifications.service.js';
import { plannerRouter, type PlannerRouterOptions } from '../modules/planner/planner.routes.js';
import { providersRouter } from '../modules/providers/providers.routes.js';
import { bookingRewardsRouter, rewardsRouter } from '../modules/rewards/rewards.routes.js';
import type { RewardsService } from '../modules/rewards/rewards.service.js';
import type { ProviderRegistry } from '../modules/providers/registry.js';
import { searchRouter, type BookingAvailability } from '../modules/search/search.routes.js';
import type { SearchService } from '../modules/search/search.service.js';
import { healthRouter, type HealthRouterOptions } from '../modules/system/health.routes.js';
import { usersRouter } from '../modules/users/users.routes.js';
import type { UsersService } from '../modules/users/users.service.js';
import type { Logger } from '../utils/logger.js';

export interface AccountsRouterOptions {
  /** Resolves the session cookie for the account routes. */
  loadSession: RequestHandler;
  auth: AuthRouterOptions;
  users: UsersService;
  bookings: BookingsService;
  /** Per-user limit on booking writes (create, cancel). */
  bookingLimiter?: RequestHandler;
  /** Payments (Phase 13). */
  payments: PaymentsService;
  /** Per-user limit on payment writes (start, cancel). */
  paymentLimiter?: RequestHandler;
  /** Notifications (Phase 14). */
  notifications: NotificationsService;
  /** Per-user limit on notification writes. */
  notificationLimiter?: RequestHandler;
  /** Admin dashboard (Phase 15, docs/admin.md). */
  admin: AdminRouterOptions;
  /** Trip timeline, status, disruptions and live updates (Phase 17, docs/trips.md). */
  trips: TripsRouterOptions;
  /** Trip planner (Phase 18) and plan collaboration (Phase 19), docs/planner.md. */
  planner: PlannerRouterOptions;
  /** Travel assistant (Phase 21), docs/assistant.md. */
  assistant: AssistantRouterOptions;
  /** Loyalty points and travel credits (Phase 25), docs/rewards.md. */
  rewards: RewardsService;
  /** Per-user limit on rewards writes (apply, remove). */
  rewardsLimiter?: RequestHandler;
  logger: Logger;
}

export interface V1RouterOptions {
  health: HealthRouterOptions;
  /** Auth, profile, travellers and bookings; mounted only when a database is configured. */
  accounts?: AccountsRouterOptions;
  search: {
    service: SearchService;
    registry: ProviderRegistry;
    limiter?: RequestHandler;
    /** How an offer can be booked now (Phase 23); absent = demo offers only. */
    bookingAvailability?: BookingAvailability;
  };
}

/**
 * Mounts every module under /api/v1. A breaking change to any endpoint means
 * a new /api/v2 router — never an in-place change here.
 */
export function v1Router(options: V1RouterOptions): Router {
  const router = Router();
  router.use('/health', healthRouter(options.health));
  router.use('/catalog', catalogRouter());
  router.use(
    '/search',
    searchRouter(
      options.search.service,
      options.search.limiter,
      options.search.bookingAvailability,
    ),
  );
  router.use('/providers', providersRouter(options.search.registry));
  if (options.accounts) {
    const {
      loadSession,
      auth,
      users,
      bookings,
      bookingLimiter,
      payments,
      paymentLimiter,
      notifications,
      notificationLimiter,
      admin,
      trips,
      planner,
      assistant,
      rewards,
      rewardsLimiter,
      logger,
    } = options.accounts;
    router.use('/auth', loadSession, authRouter(auth));
    router.use('/users', loadSession, usersRouter(users));
    router.use(
      '/bookings/:reference/payments',
      loadSession,
      bookingPaymentsRouter(payments, paymentLimiter),
    );
    router.use(
      '/bookings/:reference/rewards',
      loadSession,
      bookingRewardsRouter(rewards, rewardsLimiter),
    );
    // One session lookup for both (trip tracking routes are /bookings/:reference/…).
    router.use(
      '/bookings',
      loadSession,
      tripsRouter(trips),
      bookingsRouter(bookings, bookingLimiter),
    );
    router.use('/payments', loadSession, paymentsRouter(payments, paymentLimiter));
    router.use(
      '/notifications',
      loadSession,
      notificationsRouter(notifications, notificationLimiter),
    );
    router.use('/planner', loadSession, plannerRouter(planner));
    router.use('/assistant', loadSession, assistantRouter(assistant));
    router.use('/rewards', loadSession, rewardsRouter(rewards));
    router.use('/admin', loadSession, adminRouter(admin));
    // Signed provider webhooks: no session; only providers that verify signatures.
    router.use('/payment-events', paymentEventsRouter(payments, logger));
  }
  return router;
}
