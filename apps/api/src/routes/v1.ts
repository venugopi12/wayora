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
import { bookingPricingRouter, promotionsRouter } from '../modules/promotions/promotions.routes.js';
import type { PromotionsService } from '../modules/promotions/promotions.service.js';
import { supportRouter, type SupportRouterOptions } from '../modules/support/support.routes.js';
import { reviewsRouter, type ReviewsRouterOptions } from '../modules/reviews/reviews.routes.js';
import {
  analyticsRouter,
  contentRouter,
  discoverRouter,
} from '../modules/content/content.routes.js';
import type { ContentService } from '../modules/content/content.service.js';
import type { RewardsService } from '../modules/rewards/rewards.service.js';
import type { ProviderRegistry } from '../modules/providers/registry.js';
import {
  searchRouter,
  type BookingAvailability,
  type OfferViewedHook,
} from '../modules/search/search.routes.js';
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
  /** Push subscription changes per user (Phase 30). */
  pushLimiter?: RequestHandler;
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
  /** Coupons and promotions (Phase 26), docs/promotions.md. */
  promotions: PromotionsService;
  /** Per-user limit on coupon applications and removals. */
  couponLimiter?: RequestHandler;
  /** Customer support (Phase 27), docs/support.md. */
  support: SupportRouterOptions;
  /** Reviews and ratings (Phase 28), docs/reviews.md. */
  reviews: ReviewsRouterOptions;
  /** Published content, first-party counts and popular destinations (Phase 29), docs/seo.md. */
  content: {
    service: ContentService;
    eventLimiter?: RequestHandler;
    /** Behavioural events from the web app (Phase 31, docs/analytics.md#client-events). */
    interactions?: Parameters<typeof analyticsRouter>[2];
  };
  /** A booking was submitted (analytics, Phase 31). */
  onBookingSubmitted?: Parameters<typeof bookingsRouter>[2];
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
    /** Offer page loads, for analytics (Phase 31). */
    onOfferViewed?: OfferViewedHook;
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
      options.search.onOfferViewed,
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
      pushLimiter,
      admin,
      trips,
      planner,
      assistant,
      rewards,
      rewardsLimiter,
      promotions,
      couponLimiter,
      support,
      reviews,
      content,
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
    router.use(
      '/bookings/:reference/pricing',
      loadSession,
      bookingPricingRouter(promotions, couponLimiter),
    );
    // One session lookup for both (trip tracking routes are /bookings/:reference/…).
    router.use(
      '/bookings',
      loadSession,
      tripsRouter(trips),
      bookingsRouter(bookings, bookingLimiter, options.accounts.onBookingSubmitted),
    );
    router.use('/payments', loadSession, paymentsRouter(payments, paymentLimiter));
    router.use(
      '/notifications',
      loadSession,
      notificationsRouter(notifications, notificationLimiter, pushLimiter),
    );
    router.use('/planner', loadSession, plannerRouter(planner));
    router.use('/assistant', loadSession, assistantRouter(assistant));
    router.use('/rewards', loadSession, rewardsRouter(rewards));
    // Public; a session only adds the customer's personal offers.
    router.use('/promotions', loadSession, promotionsRouter(promotions));
    router.use('/support', loadSession, supportRouter(support));
    // Public reading; writing, votes and reports need a session.
    router.use('/reviews', loadSession, reviewsRouter(reviews));
    // Public: published content, cookieless counts, data-driven discovery.
    router.use('/content', contentRouter(content.service));
    router.use(
      '/analytics',
      analyticsRouter(content.service, content.eventLimiter, content.interactions),
    );
    router.use('/discover', discoverRouter(content.service));
    router.use('/admin', loadSession, adminRouter(admin));
    // Signed provider webhooks: no session; only providers that verify signatures.
    router.use('/payment-events', paymentEventsRouter(payments, logger));
  }
  return router;
}
