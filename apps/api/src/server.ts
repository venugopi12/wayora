import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrismaClient } from '@wayora/database';
import {
  createApp,
  createPaymentsService,
  createRewardsService,
  createPromotionsService,
  createSupportService,
  createProviderRegistry,
  createReservationService,
  createSessionService,
  createTripsService,
} from './app.js';
import {
  EnvValidationError,
  parseEnv,
  productionWarnings,
  searchSessionStore,
  type Env,
} from './config/env.js';
import { loadEnvFile } from './config/load-env-file.js';
import { ResilientRedisStore } from './middleware/rate-limit.js';
import { IdempotencyService } from './modules/bookings/idempotency.js';
import { createTravelReminders } from './modules/notifications/reminders.js';
import { RedisSearchSessionStore, type SearchSessionStore } from './modules/search/sessions.js';
import { PgTripEventHub } from './modules/trips/stream.js';
import { PLANNER_EVENTS_CHANNEL } from './modules/planner/planner.routes.js';
import {
  SUPPORT_CUSTOMER_CHANNEL,
  SUPPORT_STAFF_CHANNEL,
} from './modules/support/support.routes.js';
import { PgSignalHub } from './services/signal-hub.js';
import type { DependencyCheck } from './services/health.js';
import { createRedisConnection, type RedisConnection } from './services/redis.js';
import { workerHeartbeatCheck } from './services/worker-heartbeat.js';
import { unexpectedErrorForLog } from './utils/log-safety.js';
import { createLogger } from './utils/logger.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readEnv(): Env {
  loadEnvFile(appRoot);
  try {
    return parseEnv(process.env);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      process.stderr.write(`\n${error.message}\n\n`);
      process.exit(1);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const env = readEnv();
  const logger = createLogger(env);
  for (const warning of productionWarnings(env)) logger.warn({ config: true }, warning);

  // PostgreSQL — essential. A failed initial connect is logged, not fatal:
  // the process stays live and readiness reports 503 until it recovers.
  const prisma = createPrismaClient({ url: env.DATABASE_URL });
  await prisma.$connect().catch((err: unknown) => {
    logger.error(
      { err: unexpectedErrorForLog(err) },
      'PostgreSQL connection failed at startup; readiness will report unready',
    );
  });

  // Redis — optional. Disabled when REDIS_URL is empty; degraded when unreachable.
  let redis: RedisConnection | undefined;
  if (env.REDIS_URL) {
    redis = createRedisConnection(env.REDIS_URL, logger);
    await redis.connect();
  } else {
    logger.warn('REDIS_URL not set: Redis disabled, rate limiting is per-process');
  }

  const healthChecks: DependencyCheck[] = [
    {
      name: 'postgres',
      essential: true,
      check: async () => {
        await prisma.$queryRaw`SELECT 1`;
      },
    },
    {
      name: 'redis',
      essential: false,
      check: async () => (redis ? redis.ping() : 'disabled'),
    },
    // Optional: without a running worker, notification emails wait in the outbox.
    workerHeartbeatCheck(redis?.client),
  ];

  // Search sessions: Redis whenever it is configured (always in production,
  // enforced by config/env.ts), so sessions survive restarts and are shared by
  // every instance. Memory only for local development without Redis.
  let searchSessions: SearchSessionStore | undefined;
  if (searchSessionStore(env) === 'redis' && redis) {
    searchSessions = new RedisSearchSessionStore(
      redis.client,
      logger.child({ component: 'search-sessions' }),
    );
  } else {
    logger.warn(
      'Search sessions are kept in process memory (development only): they are lost on restart and not shared between instances',
    );
  }

  // Live trip updates: one LISTEN connection per instance (docs/trips.md#live-updates).
  const tripEvents = new PgTripEventHub(env.DATABASE_URL, logger);
  // Live plan updates for collaborators (docs/planner.md#live-updates).
  const plannerEvents = new PgSignalHub(env.DATABASE_URL, logger, {
    channel: PLANNER_EVENTS_CHANNEL,
    keyField: 'tripId',
    component: 'planner-events',
    label: 'plan updates',
  });

  // Live support-ticket updates (docs/support.md#live-updates): staff hear
  // every change, customers only customer-visible ones (two channels).
  const supportEvents = {
    customer: new PgSignalHub(env.DATABASE_URL, logger, {
      channel: SUPPORT_CUSTOMER_CHANNEL,
      keyField: 'ticketId',
      component: 'support-events',
      label: 'support updates (customer)',
    }),
    staff: new PgSignalHub(env.DATABASE_URL, logger, {
      channel: SUPPORT_STAFF_CHANNEL,
      keyField: 'ticketId',
      component: 'support-events',
      label: 'support updates (staff)',
    }),
  };

  const app = createApp({
    env,
    logger,
    healthChecks,
    prisma,
    tripEvents,
    plannerEvents,
    supportEvents,
    ...(redis ? { redis: redis.client } : {}),
    ...(searchSessions ? { searchSessions } : {}),
    ...(redis
      ? {
          rateLimitStore: new ResilientRedisStore(redis.client, logger),
          createRateLimitStore: (name: string) =>
            new ResilientRedisStore(redis.client, logger, name),
        }
      : {}),
  });

  // Expired and long-revoked sessions are deleted hourly (idempotent, so
  // running on every API instance is harmless).
  const sessions = createSessionService(prisma, env);
  const purgeSessions = () =>
    sessions
      .purgeExpired()
      .then((count) => {
        if (count > 0) logger.info({ count }, 'Purged expired sessions');
      })
      .catch((err: unknown) =>
        logger.warn({ err: unexpectedErrorForLog(err) }, 'Session purge failed; will retry'),
      );
  // Expired idempotency keys (bookings) are deleted on the same schedule.
  const idempotency = new IdempotencyService(prisma);
  const purgeIdempotencyKeys = () =>
    idempotency
      .purgeExpired()
      .then((count) => {
        if (count > 0) logger.info({ count }, 'Purged expired idempotency keys');
      })
      .catch((err: unknown) =>
        logger.warn(
          { err: unexpectedErrorForLog(err) },
          'Idempotency key purge failed; will retry',
        ),
      );
  const purgeTimer = setInterval(
    () => {
      void purgeSessions();
      void purgeIdempotencyKeys();
    },
    60 * 60 * 1000,
  );
  purgeTimer.unref();
  void purgeSessions();

  // Payments (docs/payments.md#background-work): attempts still in progress
  // are reconciled with their provider, and bookings past their payment
  // window expire. Both are idempotent and row-locked, so every API instance
  // may run them. Reads do the same for the rows they show, so this only
  // keeps records current when nobody is looking.
  const payments = createPaymentsService(prisma, env, logger);
  let paymentsRunning = false;
  const paymentMaintenance = async () => {
    if (paymentsRunning) return;
    paymentsRunning = true;
    try {
      const reconciled = await payments.reconcileInProgress();
      const expired = await payments.expireOverdueBookings();
      // Refunds (Phase 23, docs/payments.md#refunds): requested ones are
      // sent; pending or unknown ones are checked with their provider.
      await payments.processRefunds();
      if (expired > 0) logger.info({ expired, reconciled }, 'Expired unpaid bookings');
    } catch (err) {
      logger.warn({ err: unexpectedErrorForLog(err) }, 'Payment maintenance failed; will retry');
    } finally {
      paymentsRunning = false;
    }
  };
  const paymentTimer = setInterval(() => void paymentMaintenance(), 30 * 1000);
  paymentTimer.unref();

  // Loyalty (Phase 25, docs/rewards.md#maintenance): rewards of changed
  // bookings are settled (earning after travel, giving back, reversals),
  // points and credit expire, expiry notices go out, and tier holds are
  // reviewed. Idempotent and row-locked, so every instance may run it.
  const rewards = createRewardsService(prisma, env, logger, { payments });
  let rewardsRunning = false;
  const rewardsMaintenance = async () => {
    if (rewardsRunning) return;
    rewardsRunning = true;
    try {
      const done = await rewards.sweep();
      if (done.bookings > 0 || done.accounts > 0) logger.info(done, 'Settled rewards');
    } catch (err) {
      logger.warn({ err: unexpectedErrorForLog(err) }, 'Rewards maintenance failed; will retry');
    } finally {
      rewardsRunning = false;
    }
  };
  const rewardsTimer = setInterval(() => void rewardsMaintenance(), 60 * 1000);
  rewardsTimer.unref();

  // Promotions (Phase 26, docs/promotions.md#lifecycle): holds of abandoned
  // checkouts are released, uses of paid bookings confirmed, and uses of
  // cancelled paid bookings reversed. Idempotent and row-locked.
  const promotions = createPromotionsService(prisma, logger, { payments, rewards });
  let promotionsRunning = false;
  const promotionsMaintenance = async () => {
    if (promotionsRunning) return;
    promotionsRunning = true;
    try {
      const settled = await promotions.sweep();
      if (settled > 0) logger.info({ settled }, 'Settled promotion uses');
    } catch (err) {
      logger.warn({ err: unexpectedErrorForLog(err) }, 'Promotion maintenance failed; will retry');
    } finally {
      promotionsRunning = false;
    }
  };
  const promotionsTimer = setInterval(() => void promotionsMaintenance(), 60 * 1000);
  promotionsTimer.unref();

  // Support (Phase 27, docs/support.md#lifecycle): resolved tickets with no
  // reply for SUPPORT_AUTO_CLOSE_DAYS are closed. Idempotent and row-locked.
  const support = createSupportService(prisma, env, logger);
  let supportRunning = false;
  const supportMaintenance = async () => {
    if (supportRunning) return;
    supportRunning = true;
    try {
      const closed = await support.sweep();
      if (closed > 0) logger.info({ closed }, 'Closed resolved support tickets');
    } catch (err) {
      logger.warn({ err: unexpectedErrorForLog(err) }, 'Support maintenance failed; will retry');
    } finally {
      supportRunning = false;
    }
  };
  const supportTimer = setInterval(() => void supportMaintenance(), 10 * 60 * 1000);
  supportTimer.unref();

  // Supplier reservations (Phase 23, docs/bookings.md#recovery): open
  // reservations whose next check is due are looked up with the supplier (or
  // handed to staff). Each row is leased with a conditional update, so every
  // instance may run it. Nothing to do while no supplier implements reservations.
  const reservations = createReservationService(
    prisma,
    env,
    logger,
    createProviderRegistry(env, process.env),
  );
  let reconcilingReservations = false;
  const reservationRecovery = async () => {
    if (reconcilingReservations) return;
    reconcilingReservations = true;
    try {
      const handled = await reservations.reconcileDue();
      if (handled > 0) logger.info({ handled }, 'Checked supplier reservations');
    } catch (err) {
      logger.warn(
        { err: unexpectedErrorForLog(err) },
        'Supplier reservation recovery failed; will retry',
      );
    } finally {
      reconcilingReservations = false;
    }
  };
  const reservationTimer = setInterval(() => void reservationRecovery(), 30 * 1000);
  reservationTimer.unref();

  // Travel reminders (docs/notifications.md#events): the day before a
  // confirmed booking starts. Idempotent (one per booking), so every
  // instance may run it.
  const reminders = () =>
    createTravelReminders(prisma, new Date())
      .then((count) => {
        if (count > 0) logger.info({ count }, 'Created travel reminders');
      })
      .catch((err: unknown) =>
        logger.warn({ err: unexpectedErrorForLog(err) }, 'Travel reminders failed; will retry'),
      );
  const reminderTimer = setInterval(() => void reminders(), 30 * 60 * 1000);

  // Travel status (docs/trips.md#background-checks): trips travelling around
  // today are re-checked when their status is older than the freshness
  // window. Idempotent (dedupe keys, newer-observation-wins), so every
  // instance may run it.
  const trips = createTripsService(prisma, env, logger);
  let sweeping = false;
  const sweepTrips = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const { checked } = await trips.sweep();
      if (checked > 0) logger.debug({ checked }, 'Checked travel status');
    } catch (err) {
      logger.warn({ err: unexpectedErrorForLog(err) }, 'Travel status checks failed; will retry');
    } finally {
      sweeping = false;
    }
  };
  const tripTimer =
    env.TRAVEL_STATUS_SWEEP_SECONDS > 0 && trips.providerConfigured
      ? setInterval(() => void sweepTrips(), env.TRAVEL_STATUS_SWEEP_SECONDS * 1000)
      : undefined;
  tripTimer?.unref();
  reminderTimer.unref();
  void reminders();

  const server: Server = app.listen(env.PORT, env.HOST, () => {
    logger.info({ url: `http://localhost:${env.PORT}`, host: env.HOST }, 'Wayora API listening');
  });
  server.on('error', (err) => {
    logger.fatal({ err: unexpectedErrorForLog(err) }, 'HTTP server failed');
    process.exit(1);
  });
  // Keep-alive slightly above typical load-balancer idle timeouts.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down gracefully');

    const forceExit = setTimeout(() => {
      logger.error({ timeoutMs: env.SHUTDOWN_TIMEOUT_MS }, 'Shutdown timed out; forcing exit');
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    clearInterval(purgeTimer);
    clearInterval(paymentTimer);
    clearInterval(reservationTimer);
    clearInterval(reminderTimer);
    clearInterval(tripTimer);
    // Live-update streams never finish on their own: end them (browsers reconnect).
    await tripEvents.close();
    await plannerEvents.close();
    await supportEvents.customer.close();
    await supportEvents.staff.close();
    // 1. Stop accepting connections and let in-flight requests finish.
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
    // 2. Release dependencies.
    await Promise.allSettled([prisma.$disconnect(), redis?.close()]);

    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: unexpectedErrorForLog(reason) }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: unexpectedErrorForLog(err) }, 'Uncaught exception; shutting down');
    void shutdown('uncaughtException');
  });
}

void main();
