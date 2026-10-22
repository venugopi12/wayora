import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrismaClient } from '@wayora/database';
import { createApp, createSessionService } from './app.js';
import { EnvValidationError, parseEnv, searchSessionStore, type Env } from './config/env.js';
import { loadEnvFile } from './config/load-env-file.js';
import { ResilientRedisStore } from './middleware/rate-limit.js';
import { IdempotencyService } from './modules/bookings/idempotency.js';
import { RedisSearchSessionStore, type SearchSessionStore } from './modules/search/sessions.js';
import type { DependencyCheck } from './services/health.js';
import { createRedisConnection, type RedisConnection } from './services/redis.js';
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

  // PostgreSQL — essential. A failed initial connect is logged, not fatal:
  // the process stays live and readiness reports 503 until it recovers.
  const prisma = createPrismaClient({ url: env.DATABASE_URL });
  await prisma.$connect().catch((err: unknown) => {
    logger.error({ err }, 'PostgreSQL connection failed at startup; readiness will report unready');
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

  const app = createApp({
    env,
    logger,
    healthChecks,
    prisma,
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
      .catch((err: unknown) => logger.warn({ err }, 'Session purge failed; will retry'));
  // Expired idempotency keys (bookings) are deleted on the same schedule.
  const idempotency = new IdempotencyService(prisma);
  const purgeIdempotencyKeys = () =>
    idempotency
      .purgeExpired()
      .then((count) => {
        if (count > 0) logger.info({ count }, 'Purged expired idempotency keys');
      })
      .catch((err: unknown) => logger.warn({ err }, 'Idempotency key purge failed; will retry'));
  const purgeTimer = setInterval(
    () => {
      void purgeSessions();
      void purgeIdempotencyKeys();
      void purgeIdempotencyKeys();
    },
    60 * 60 * 1000,
  );
  purgeTimer.unref();
  void purgeSessions();

  const server: Server = app.listen(env.PORT, env.HOST, () => {
    logger.info({ url: `http://localhost:${env.PORT}`, host: env.HOST }, 'Wayora API listening');
  });
  server.on('error', (err) => {
    logger.fatal({ err }, 'HTTP server failed');
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
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception; shutting down');
    void shutdown('uncaughtException');
  });
}

void main();
