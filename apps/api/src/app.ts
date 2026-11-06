import cors from 'cors';
import express, { type Express } from 'express';
import type { Store } from 'express-rate-limit';
import helmet from 'helmet';
import { API_V1_PREFIX, REQUEST_ID_HEADER } from '@wayora/contracts';
import type { PrismaClient } from '@wayora/database';
import {
  demoPaymentScenariosEnabled,
  demoProvidersEnabled,
  paymentProvider,
  travelStatusProvider,
  type Env,
} from './config/env.js';
import { requireTrustedOrigin } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { httpLogger } from './middleware/http-logger.js';
import {
  apiRateLimiter,
  bookingWriteRateLimiter,
  searchRateLimiter,
} from './middleware/rate-limit.js';
import { requestId } from './middleware/request-id.js';
import { currentUser, loadSession } from './middleware/session.js';
import { AuthService } from './modules/auth/auth.service.js';
import { BookingsService } from './modules/bookings/bookings.service.js';
import { SessionService } from './modules/auth/session.service.js';
import { DEMO_PROVIDERS } from './modules/providers/demo/index.js';
import { createLiveProviders } from './modules/providers/live/index.js';
import type { SearchProvider } from './modules/providers/provider.js';
import { ProviderRegistry } from './modules/providers/registry.js';
import { SearchService, type ResilienceOptions } from './modules/search/search.service.js';
import { MemorySearchSessionStore, type SearchSessionStore } from './modules/search/sessions.js';
import { UsersService } from './modules/users/users.service.js';
import { PaymentsService } from './modules/payments/payments.service.js';
import { NotificationsService } from './modules/notifications/notifications.service.js';
import { AdminService } from './modules/admin/admin.service.js';
import { PlatformHealth, type HealthRedis } from './modules/admin/platform-health.js';
import { prismaSearchEventRecorder } from './modules/search/analytics.js';
import {
  AssistantService,
  createAssistantProvider,
  type AssistantProvider,
} from './modules/assistant/index.js';
import { BudgetService } from './modules/planner/budget.service.js';
import { CollaborationService } from './modules/planner/collaboration.service.js';
import { PlannerService } from './modules/planner/planner.service.js';
import { LocalSignalHub, type SignalHub } from './services/signal-hub.js';
import { DemoTravelStatusProvider } from './modules/trips/providers/demo.js';
import type { TravelStatusProvider } from './modules/trips/providers/types.js';
import { LocalTripEventHub, type TripEventHub } from './modules/trips/stream.js';
import { TripsService } from './modules/trips/trips.service.js';
import {
  ReservationService,
  type RecoveryPolicy,
} from './modules/bookings/reservations.service.js';
import {
  PAYMENT_EVENTS_PATH,
  type RequestWithRawBody,
} from './modules/payments/payments.routes.js';
import { DemoPaymentProvider } from './modules/payments/providers/demo.js';
import { RewardsService } from './modules/rewards/rewards.service.js';
import { PromotionsService } from './modules/promotions/promotions.service.js';
import type { PaymentProvider } from './modules/payments/providers/types.js';
import { v1Router, type AccountsRouterOptions } from './routes/v1.js';
import type { StreamTimings } from './services/signal-stream.js';
import type { DependencyCheck } from './services/health.js';
import type { Logger } from './utils/logger.js';

export interface AppDependencies {
  env: Env;
  logger: Logger;
  /** Probed by GET /api/v1/health/ready. */
  healthChecks: readonly DependencyCheck[];
  /** Shared rate-limit store (Redis). Defaults to in-memory. */
  rateLimitStore?: Store;
  /** Creates one store per extra limiter (auth). Defaults to in-memory stores. */
  createRateLimitStore?: (name: string) => Store;
  /**
   * Database for accounts (auth, profile, travellers). Without it those routes
   * are not mounted, so infrastructure-free tests can build the app.
   */
  prisma?: PrismaClient;
  /** Clock override for session and search tests. */
  now?: () => Date;
  /**
   * Search providers to register. Defaults to the live adapters from
   * `createLiveProviders` (none yet) and the built-in demo providers
   * (docs/providers.md#adding-a-real-supplier).
   */
  searchProviders?: readonly SearchProvider[];
  /**
   * Where search sessions live. The server passes the Redis store
   * (server.ts); without one, a per-process memory store is used, which
   * production refuses (docs/search.md#search-sessions).
   */
  searchSessions?: SearchSessionStore;
  /** Overrides for search resilience (tests: clock, jitter). Defaults come from env. */
  searchResilience?: Partial<ResilienceOptions>;
  /** Where providers' required configuration is looked up (names only). Defaults to process.env. */
  providerConfig?: Readonly<Record<string, string | undefined>>;
  /**
   * Payment providers. `policy` overrides the one chosen by env (tests use
   * test-only providers); `extra` are providers existing payments or
   * webhooks may name.
   */
  paymentProviders?: { policy?: PaymentProvider | null; extra?: readonly PaymentProvider[] };
  /**
   * Redis, read by the admin health page (worker heartbeat, queue depth).
   * Absent when Redis isn't configured; the page then says so.
   */
  redis?: HealthRedis;
  /** Search analytics on/off (default: on whenever there is a database). */
  recordSearchEvents?: boolean;
  /**
   * Live trip updates (docs/trips.md#live-updates). The server passes the
   * PostgreSQL-fed hub; without one, streams fall back to periodic re-reads.
   */
  tripEvents?: TripEventHub;
  /**
   * Live plan updates (docs/planner.md#live-updates). The server passes the
   * PostgreSQL-fed hub; without one, streams fall back to periodic re-reads.
   */
  plannerEvents?: SignalHub;
  /** Stream timings for plan live updates (tests shorten them). */
  plannerStream?: Partial<StreamTimings>;
  /** Overrides the travel-status provider chosen by env (tests); null = none. */
  travelStatus?: { provider?: TravelStatusProvider | null; stream?: Partial<StreamTimings> };
  /**
   * Travel assistant (docs/assistant.md). `provider` overrides the one chosen
   * by AI_PROVIDER (tests pass deterministic fakes; null = off); `sleep`
   * replaces the pause between provider attempts.
   */
  assistant?: { provider?: AssistantProvider | null; sleep?: (ms: number) => Promise<void> };
  /** Supplier reservation recovery tuning (tests shorten delays; jitter source). */
  reservations?: { recovery?: Partial<RecoveryPolicy>; random?: () => number };
}

/**
 * The search providers this configuration registers (exported so the
 * server's background reservation recovery uses the same set).
 */
export function createProviderRegistry(
  env: Env,
  providerConfig: Readonly<Record<string, string | undefined>> = process.env,
  searchProviders?: readonly SearchProvider[],
): ProviderRegistry {
  const registry = new ProviderRegistry({
    demoEnabled: demoProvidersEnabled(env),
    disabledIds: env.SEARCH_DISABLED_PROVIDERS,
    // Blank counts as missing, as in readProviderConfig (providers/credentials.ts).
    isConfigured: (name) => Boolean(providerConfig[name]?.trim()),
  });
  // Live suppliers first (none integrated yet: docs/providers.md), then demo fixtures.
  const providers = searchProviders ?? [...createLiveProviders(providerConfig), ...DEMO_PROVIDERS];
  for (const provider of providers) registry.register(provider);
  return registry;
}

/** Supplier reservations (Phase 23), from env (exported for the server's recovery timer). */
export function createReservationService(
  prisma: PrismaClient,
  env: Env,
  logger: Logger,
  registry: ProviderRegistry,
  options: { now?: () => Date; recovery?: Partial<RecoveryPolicy>; random?: () => number } = {},
): ReservationService {
  return new ReservationService({
    prisma,
    registry,
    logger,
    timeoutMs: env.SUPPLIER_RESERVATION_TIMEOUT_MS,
    ...(options.recovery ? { recovery: options.recovery } : {}),
    ...(options.random ? { random: options.random } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

/** Builds the trip service from env (exported for the server's background checks). */
export function createTripsService(
  prisma: PrismaClient,
  env: Env,
  logger: Logger,
  options: { now?: () => Date; provider?: TravelStatusProvider | null } = {},
): TripsService {
  const provider =
    options.provider !== undefined
      ? options.provider
      : travelStatusProvider(env) === 'demo'
        ? new DemoTravelStatusProvider(options.now ? { now: options.now } : {})
        : null;
  return new TripsService({
    prisma,
    logger: logger.child({ component: 'trips' }),
    provider,
    freshMs: env.TRAVEL_STATUS_FRESH_SECONDS * 1000,
    minRefreshMs: env.TRAVEL_STATUS_MIN_REFRESH_SECONDS * 1000,
    timeoutMs: env.TRAVEL_STATUS_TIMEOUT_MS,
    ...(options.now ? { now: options.now } : {}),
  });
}

/** Builds the payment service from env (exported for the server's background jobs). */
export function createPaymentsService(
  prisma: PrismaClient,
  env: Env,
  logger: Logger,
  options: {
    now?: () => Date;
    providers?: { policy?: PaymentProvider | null; extra?: readonly PaymentProvider[] };
  } = {},
): PaymentsService {
  const demo = new DemoPaymentProvider({
    pendingMs: env.PAYMENT_DEMO_PENDING_SECONDS * 1000,
    ...(options.now ? { now: options.now } : {}),
  });
  const chosen =
    options.providers?.policy !== undefined
      ? options.providers.policy
      : paymentProvider(env) === 'demo'
        ? demo
        : null;
  return new PaymentsService({
    prisma,
    logger: logger.child({ component: 'payments' }),
    policy: {
      provider: chosen,
      demoScenarios: chosen?.mode === 'DEMO' && demoPaymentScenariosEnabled(env),
      windowMs: env.PAYMENT_WINDOW_MINUTES * 60 * 1000,
    },
    // Existing demo payments stay readable even when payments are switched off.
    providers: [demo, ...(options.providers?.extra ?? [])],
    ...(options.now ? { now: options.now } : {}),
  });
}

/**
 * Security headers for a JSON-only API (docs/security.md#http-headers). It
 * serves no HTML, scripts or frames, so the CSP forbids everything; framing
 * is refused; HSTS is sent only in production, where every origin is HTTPS
 * (config/env.ts enforces it) — browsers ignore HSTS over plain HTTP, and a
 * development machine shouldn't pin `localhost` to HTTPS.
 */
export function apiSecurityHeaders(env: Pick<Env, 'NODE_ENV'>): Parameters<typeof helmet>[0] {
  return {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
    // Only no-cors loads (<img>, <script>) are affected; the web app's CORS fetches aren't.
    crossOriginResourcePolicy: { policy: 'same-origin' },
    strictTransportSecurity:
      env.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  };
}

const HOUR_MS = 60 * 60 * 1000;
/** Session activity is persisted at most this often. */
const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** Builds the account services from env (exported for the server's cleanup job). */
/** Loyalty points and travel credits (Phase 25, docs/rewards.md). */
export function createRewardsService(
  prisma: PrismaClient,
  env: Env,
  logger: Logger,
  options: { now?: () => Date; payments?: PaymentsService } = {},
): RewardsService {
  const payments = options.payments;
  return new RewardsService({
    prisma,
    logger: logger.child({ component: 'rewards' }),
    liveEnabled: env.LOYALTY_LIVE_REWARDS_ENABLED === 'true',
    ...(options.now ? { now: options.now } : {}),
    ...(payments
      ? { expireOverdue: (filter: { userId: string }) => payments.expireOverdueBookings(filter) }
      : {}),
  });
}

/** Coupons and promotions (Phase 26, docs/promotions.md). */
export function createPromotionsService(
  prisma: PrismaClient,
  logger: Logger,
  options: { now?: () => Date; payments?: PaymentsService; rewards?: RewardsService } = {},
): PromotionsService {
  const { payments, rewards } = options;
  return new PromotionsService({
    prisma,
    logger: logger.child({ component: 'promotions' }),
    ...(options.now ? { now: options.now } : {}),
    ...(payments
      ? { expireOverdue: (filter: { userId: string }) => payments.expireOverdueBookings(filter) }
      : {}),
    ...(rewards
      ? { releaseRewards: (tx, bookingId, actor) => rewards.releaseApplied(tx, bookingId, actor) }
      : {}),
  });
}

export function createSessionService(prisma: PrismaClient, env: Env, now?: () => Date) {
  return new SessionService(
    prisma,
    {
      idleTimeoutMs: env.SESSION_IDLE_TIMEOUT_HOURS * HOUR_MS,
      absoluteTimeoutMs: env.SESSION_ABSOLUTE_TIMEOUT_HOURS * HOUR_MS,
      touchIntervalMs: SESSION_TOUCH_INTERVAL_MS,
    },
    now,
  );
}

/**
 * Builds the Express application. Pure construction — no listening, no
 * connections — so tests can create it with fake dependencies.
 */
export function createApp({
  env,
  logger,
  healthChecks,
  rateLimitStore,
  createRateLimitStore,
  prisma,
  now,
  searchProviders,
  searchSessions,
  searchResilience,
  providerConfig = process.env,
  paymentProviders,
  redis,
  recordSearchEvents = true,
  tripEvents,
  travelStatus,
  plannerEvents,
  plannerStream,
  assistant,
  reservations: reservationOptions,
}: AppDependencies): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.set('query parser', 'simple');

  app.use(requestId);
  app.use(httpLogger(logger));
  app.use(helmet(apiSecurityHeaders(env)));
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', REQUEST_ID_HEADER],
      exposedHeaders: [
        REQUEST_ID_HEADER,
        'RateLimit',
        'RateLimit-Policy',
        'Retry-After',
        'Idempotent-Replayed',
      ],
      maxAge: 600,
    }),
  );
  app.use(
    express.json({
      limit: '100kb',
      // Signed provider webhooks are verified over the exact bytes received.
      verify: (req, _res, buf) => {
        if (req.url?.startsWith(PAYMENT_EVENTS_PATH)) (req as RequestWithRawBody).rawBody = buf;
      },
    }),
  );
  // CSRF: state-changing requests must come from an allowed origin.
  app.use(requireTrustedOrigin(env.CORS_ORIGIN));

  app.use(
    '/api',
    apiRateLimiter({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
      ...(rateLimitStore ? { store: rateLimitStore } : {}),
    }),
  );

  let accounts:
    | Omit<
        AccountsRouterOptions,
        | 'bookings'
        | 'payments'
        | 'logger'
        | 'notifications'
        | 'admin'
        | 'trips'
        | 'planner'
        | 'assistant'
        | 'rewards'
        | 'rewardsLimiter'
        | 'promotions'
        | 'couponLimiter'
      >
    | undefined;
  let sessionValid: (token: string | undefined) => Promise<boolean> = () => Promise.resolve(false);
  if (prisma) {
    const secure = env.NODE_ENV === 'production';
    const sessions = createSessionService(prisma, env, now);
    sessionValid = async (token) => Boolean(await sessions.resolve(token));
    accounts = {
      loadSession: loadSession(sessions, secure),
      auth: {
        auth: new AuthService(prisma, sessions),
        sessions,
        cookie: { secure, maxAgeMs: env.SESSION_ABSOLUTE_TIMEOUT_HOURS * HOUR_MS },
        limits: {
          attemptsPerIp: env.AUTH_RATE_LIMIT_MAX,
          failuresPerEmail: env.LOGIN_FAILURES_PER_EMAIL_MAX,
        },
        ...(createRateLimitStore ? { createStore: createRateLimitStore } : {}),
      },
      users: new UsersService(prisma),
    };
  }

  const registry = createProviderRegistry(env, providerConfig, searchProviders);
  // What search will use, in plain words: never configuration values.
  logger.info(
    {
      searchProviders: registry.describe().map((p) => ({
        id: p.id,
        kind: p.kind,
        enabled: p.enabled,
        disabledReason: p.disabledReason,
        revalidate: p.operations.revalidate,
        book: p.operations.book,
      })),
      liveProviders: registry.describe().filter((p) => p.kind === 'live' && p.enabled).length,
      supplierReservations: env.SUPPLIER_RESERVATIONS_ENABLED === 'true',
    },
    'Search providers registered',
  );
  if (!searchSessions && env.NODE_ENV === 'production') {
    // config/env.ts already refuses this; never fall back to memory silently.
    throw new Error('Production needs the Redis search-session store (searchSessions).');
  }
  const search = new SearchService({
    registry,
    logger,
    sessions: searchSessions ?? new MemorySearchSessionStore(200, now),
    sessionTtlMs: env.SEARCH_SESSION_TTL_SECONDS * 1000,
    ...(now ? { now } : {}),
    resilience: {
      deadlineMs: env.SEARCH_DEADLINE_MS,
      retry: {
        maxAttempts: env.SEARCH_PROVIDER_MAX_ATTEMPTS,
        baseDelayMs: env.SEARCH_PROVIDER_RETRY_BASE_MS,
        maxDelayMs: env.SEARCH_PROVIDER_RETRY_BASE_MS * 8,
      },
      breaker: {
        failureThreshold: env.SEARCH_BREAKER_FAILURE_THRESHOLD,
        cooldownMs: env.SEARCH_BREAKER_COOLDOWN_SECONDS * 1000,
      },
      ...searchResilience,
    },
    ...(prisma && recordSearchEvents
      ? { recordEvent: prismaSearchEventRecorder(prisma, logger, now) }
      : {}),
  });
  const searchStore = createRateLimitStore?.('search');
  const bookingStore = createRateLimitStore?.('bookings');
  const paymentStore = createRateLimitStore?.('payments');
  const notificationStore = createRateLimitStore?.('notifications');
  const tripStatusStore = createRateLimitStore?.('trip-status');
  const plannerStore = createRateLimitStore?.('planner');
  const plannerInviteStore = createRateLimitStore?.('planner-invites');
  const assistantStore = createRateLimitStore?.('assistant');
  const assistantWriteStore = createRateLimitStore?.('assistant-writes');
  const rewardsStore = createRateLimitStore?.('rewards');
  const couponStore = createRateLimitStore?.('coupons');
  const payments = prisma
    ? createPaymentsService(prisma, env, logger, {
        ...(now ? { now } : {}),
        ...(paymentProviders ? { providers: paymentProviders } : {}),
      })
    : undefined;
  const rewardsService =
    prisma && payments
      ? createRewardsService(prisma, env, logger, { ...(now ? { now } : {}), payments })
      : undefined;
  // Bookings need the database and the search sessions their offers come from.
  // Rewards are settled after booking and payment changes commit (never inside them).
  const promotionsService =
    prisma && payments
      ? createPromotionsService(prisma, logger, {
          ...(now ? { now } : {}),
          payments,
          ...(rewardsService ? { rewards: rewardsService } : {}),
        })
      : undefined;
  // Promotion uses and rewards are settled after booking and payment changes
  // commit (never inside them); promotions are checked again before a payment.
  payments?.onSettled((bookingId) => promotionsService?.reconcileBooking(bookingId));
  payments?.onSettled((bookingId) => rewardsService?.reconcileBooking(bookingId));
  if (promotionsService) {
    payments?.onBeforePayment((bookingId) => promotionsService.revalidateBeforePayment(bookingId));
  }
  const trips = prisma
    ? createTripsService(prisma, env, logger, {
        ...(now ? { now } : {}),
        ...(travelStatus?.provider !== undefined ? { provider: travelStatus.provider } : {}),
      })
    : undefined;
  const plannerService = prisma
    ? new PlannerService({
        prisma,
        logger: logger.child({ component: 'planner' }),
        ...(now ? { now } : {}),
      })
    : undefined;
  const budgetService = prisma
    ? new BudgetService({
        prisma,
        logger: logger.child({ component: 'plan-budget' }),
        ...(now ? { now } : {}),
      })
    : undefined;
  const assistantService =
    prisma && plannerService && budgetService
      ? new AssistantService({
          prisma,
          logger: logger.child({ component: 'assistant' }),
          provider:
            assistant?.provider !== undefined ? assistant.provider : createAssistantProvider(env),
          planner: plannerService,
          budget: budgetService,
          limits: {
            timeoutMs: env.AI_TIMEOUT_MS,
            maxAttempts: env.AI_MAX_ATTEMPTS,
            maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
            requestsPerDay: env.AI_DAILY_REQUEST_LIMIT,
            requestsPerMinute: env.AI_RATE_LIMIT_MAX,
          },
          ...(now ? { now } : {}),
          ...(assistant?.sleep ? { sleep: assistant.sleep } : {}),
        })
      : undefined;
  const reservationService = prisma
    ? createReservationService(prisma, env, logger, registry, {
        ...(now ? { now } : {}),
        ...reservationOptions,
      })
    : undefined;
  const bookingsService =
    prisma && payments
      ? new BookingsService({
          prisma,
          search,
          registry,
          logger,
          payments,
          ...(reservationService ? { reservations: reservationService } : {}),
          ...(promotionsService ? { promotions: promotionsService } : {}),
          supplierReservationsEnabled: env.SUPPLIER_RESERVATIONS_ENABLED === 'true',
          ...(now ? { now } : {}),
        })
      : undefined;
  const accountRoutes: AccountsRouterOptions | undefined =
    accounts &&
    prisma &&
    payments &&
    bookingsService &&
    trips &&
    plannerService &&
    budgetService &&
    assistantService &&
    rewardsService &&
    promotionsService
      ? {
          ...accounts,
          bookings: bookingsService,
          payments,
          // No email provider exists yet: delivery is reported as not configured.
          notifications: new NotificationsService(prisma, { active: false }, now),
          admin: {
            prisma,
            logger,
            service: new AdminService({
              prisma,
              emailConfigured: false,
              reservations: reservationService ?? null,
              ...(now ? { now } : {}),
            }),
            reservations: reservationService ?? null,
            rewards: rewardsService,
            promotions: promotionsService,
            health: new PlatformHealth({
              prisma,
              ...(redis ? { redis } : {}),
              logger: logger.child({ component: 'admin-health' }),
              timeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
              ...(now ? { now } : {}),
              travelStatus: trips.provider
                ? {
                    providerName: trips.provider.name,
                    simulated: trips.provider.kind === 'demo',
                    recentFailures: () => trips.recentFailures(),
                  }
                : null,
              search: {
                describe: () => registry.describe(),
                breakerStates: () => search.breakerStates(),
              },
              assistant: assistantService.provider
                ? {
                    providerName: assistantService.provider.label,
                    simulated: assistantService.provider.simulated,
                    recentFailures: () => assistantService.recentFailures(),
                  }
                : null,
            }),
          },
          trips: {
            trips,
            hub: tripEvents ?? new LocalTripEventHub(),
            logger: logger.child({ component: 'trip-stream' }),
            sessionValid,
            ...(travelStatus?.stream ? { stream: travelStatus.stream } : {}),
            refreshLimiter: bookingWriteRateLimiter({
              max: env.TRAVEL_STATUS_REFRESH_RATE_LIMIT_MAX,
              subject: 'status refreshes',
              userIdOf: (res) => currentUser(res).id,
              ...(tripStatusStore ? { store: tripStatusStore } : {}),
            }),
          },
          planner: {
            planner: plannerService,
            collaboration: new CollaborationService({ prisma, ...(now ? { now } : {}) }),
            budget: budgetService,
            prisma,
            hub: plannerEvents ?? new LocalSignalHub(),
            logger: logger.child({ component: 'planner-stream' }),
            sessionValid,
            ...(plannerStream ? { stream: plannerStream } : {}),
            writeLimiter: bookingWriteRateLimiter({
              max: env.PLANNER_RATE_LIMIT_MAX,
              subject: 'plan changes',
              userIdOf: (res) => currentUser(res).id,
              ...(plannerStore ? { store: plannerStore } : {}),
            }),
            inviteLimiter: bookingWriteRateLimiter({
              max: env.PLANNER_INVITE_RATE_LIMIT_MAX,
              windowMs: 60 * 60 * 1000,
              subject: 'invitations',
              userIdOf: (res) => currentUser(res).id,
              ...(plannerInviteStore ? { store: plannerInviteStore } : {}),
            }),
          },
          assistant: {
            service: assistantService,
            messageLimiter: bookingWriteRateLimiter({
              max: env.AI_RATE_LIMIT_MAX,
              subject: 'assistant requests',
              userIdOf: (res) => currentUser(res).id,
              ...(assistantStore ? { store: assistantStore } : {}),
            }),
            writeLimiter: bookingWriteRateLimiter({
              max: env.PLANNER_RATE_LIMIT_MAX,
              subject: 'assistant changes',
              userIdOf: (res) => currentUser(res).id,
              ...(assistantWriteStore ? { store: assistantWriteStore } : {}),
            }),
          },
          rewards: rewardsService,
          promotions: promotionsService,
          couponLimiter: bookingWriteRateLimiter({
            max: env.COUPON_RATE_LIMIT_MAX,
            windowMs: 15 * 60 * 1000,
            subject: 'coupon attempts',
            userIdOf: (res) => currentUser(res).id,
            ...(couponStore ? { store: couponStore } : {}),
          }),
          rewardsLimiter: bookingWriteRateLimiter({
            max: env.PAYMENT_RATE_LIMIT_MAX,
            subject: 'reward changes',
            userIdOf: (res) => currentUser(res).id,
            ...(rewardsStore ? { store: rewardsStore } : {}),
          }),
          logger,
          notificationLimiter: bookingWriteRateLimiter({
            max: env.NOTIFICATION_RATE_LIMIT_MAX,
            subject: 'notification changes',
            userIdOf: (res) => currentUser(res).id,
            ...(notificationStore ? { store: notificationStore } : {}),
          }),
          paymentLimiter: bookingWriteRateLimiter({
            max: env.PAYMENT_RATE_LIMIT_MAX,
            subject: 'payment requests',
            userIdOf: (res) => currentUser(res).id,
            ...(paymentStore ? { store: paymentStore } : {}),
          }),
          bookingLimiter: bookingWriteRateLimiter({
            max: env.BOOKING_RATE_LIMIT_MAX,
            userIdOf: (res) => currentUser(res).id,
            ...(bookingStore ? { store: bookingStore } : {}),
          }),
        }
      : undefined;

  app.use(
    API_V1_PREFIX,
    v1Router({
      health: {
        dependencies: healthChecks,
        timeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
        logger: logger.child({ component: 'readiness' }),
      },
      search: {
        service: search,
        registry,
        ...(bookingsService
          ? {
              bookingAvailability: (result: { source: string; providerId: string }) =>
                bookingsService.bookingAvailability(result),
            }
          : {}),
        limiter: searchRateLimiter({
          max: env.SEARCH_RATE_LIMIT_MAX,
          ...(searchStore ? { store: searchStore } : {}),
        }),
      },
      ...(accountRoutes ? { accounts: accountRoutes } : {}),
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler(logger, { exposeInternals: env.NODE_ENV === 'development' }));

  return app;
}
