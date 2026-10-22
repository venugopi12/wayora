import cors from 'cors';
import express, { type Express } from 'express';
import type { Store } from 'express-rate-limit';
import helmet from 'helmet';
import { API_V1_PREFIX, REQUEST_ID_HEADER } from '@wayora/contracts';
import type { PrismaClient } from '@wayora/database';
import { demoProvidersEnabled, type Env } from './config/env.js';
import { requireTrustedOrigin } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { httpLogger } from './middleware/http-logger.js';
import { apiRateLimiter, searchRateLimiter } from './middleware/rate-limit.js';
import { requestId } from './middleware/request-id.js';
import { loadSession } from './middleware/session.js';
import { AuthService } from './modules/auth/auth.service.js';
import { SessionService } from './modules/auth/session.service.js';
import { DEMO_PROVIDERS } from './modules/providers/demo/index.js';
import type { SearchProvider } from './modules/providers/provider.js';
import { ProviderRegistry } from './modules/providers/registry.js';
import { SearchService, type ResilienceOptions } from './modules/search/search.service.js';
import { MemorySearchSessionStore, type SearchSessionStore } from './modules/search/sessions.js';
import { UsersService } from './modules/users/users.service.js';
import { v1Router, type AccountsRouterOptions } from './routes/v1.js';
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
   * Search providers to register. Defaults to the built-in demo providers;
   * live adapters are added here (docs/search.md#adding-a-supplier).
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
}

const HOUR_MS = 60 * 60 * 1000;
/** Session activity is persisted at most this often. */
const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** Builds the account services from env (exported for the server's cleanup job). */
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
  searchProviders = DEMO_PROVIDERS,
  searchSessions,
  searchResilience,
  providerConfig = process.env,
}: AppDependencies): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.set('query parser', 'simple');

  app.use(requestId);
  app.use(httpLogger(logger));
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', REQUEST_ID_HEADER],
      exposedHeaders: [REQUEST_ID_HEADER, 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '100kb' }));
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

  let accounts: AccountsRouterOptions | undefined;
  if (prisma) {
    const secure = env.NODE_ENV === 'production';
    const sessions = createSessionService(prisma, env, now);
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

  const registry = new ProviderRegistry({
    demoEnabled: demoProvidersEnabled(env),
    disabledIds: env.SEARCH_DISABLED_PROVIDERS,
    isConfigured: (name) => Boolean(providerConfig[name]),
  });
  for (const provider of searchProviders) registry.register(provider);
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
  });
  const searchStore = createRateLimitStore?.('search');

  app.use(
    API_V1_PREFIX,
    v1Router({
      health: { dependencies: healthChecks, timeoutMs: env.HEALTH_CHECK_TIMEOUT_MS },
      search: {
        service: search,
        registry,
        limiter: searchRateLimiter({
          max: env.SEARCH_RATE_LIMIT_MAX,
          ...(searchStore ? { store: searchStore } : {}),
        }),
      },
      ...(accounts ? { accounts } : {}),
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler(logger, { exposeInternals: env.NODE_ENV === 'development' }));

  return app;
}
