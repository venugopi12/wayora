import { Queue, Worker } from 'bullmq';
import {
  JOB_NAMES,
  QUEUE_NAMES,
  analyticsPurgeJobSchema,
  notificationsDispatchJobSchema,
} from '@wayora/contracts';
import { createPrismaClient, type PrismaClient } from '@wayora/database';
import { bullConnection, loadWorkerEnv, vapidConfig } from './config.js';
import { connectionErrorMessage, endpointForLog, errorCode } from './connection-errors.js';
import { startBeacon } from './liveness/beacon.js';
import { createLogger } from './logger.js';
import { NotificationDispatcher } from './notifications/dispatcher.js';
import { NotConfiguredEmailProvider } from './notifications/email.js';
import { NotConfiguredPushSender, PushDispatcher, WebPushSender } from './notifications/push.js';
import { createProcessor, type Handler } from './processor.js';
import { purgeAnalyticsEvents } from './jobs/analytics-purge.js';

const env = loadWorkerEnv();
const logger = createLogger(env);

// Notification outbox (docs/notifications.md#delivery). No email provider is
// configured, so deliveries are recorded as NOT_CONFIGURED; nothing is sent.
let prisma: PrismaClient | undefined;
const extraHandlers: Record<string, Handler> = {};
if (env.DATABASE_URL) {
  prisma = createPrismaClient({ url: env.DATABASE_URL, maxConnections: 4 });
  const dispatcher = new NotificationDispatcher({
    prisma,
    provider: new NotConfiguredEmailProvider(),
    logger: logger.child({ component: 'notifications' }),
    webOrigin: env.WEB_ORIGIN,
  });
  // Browser push (Phase 30, docs/pwa.md#push): on when the VAPID keys are set.
  const vapid = vapidConfig(env);
  const pushDispatcher = new PushDispatcher({
    prisma,
    sender: vapid ? new WebPushSender(vapid) : new NotConfiguredPushSender(),
    logger: logger.child({ component: 'push' }),
  });
  if (!vapid)
    logger.info('VAPID keys not set: browser push is off (deliveries recorded as NOT_CONFIGURED)');
  extraHandlers[JOB_NAMES.notificationsDispatch] = async (data) => {
    notificationsDispatchJobSchema.parse(data);
    return { email: await dispatcher.run(), push: await pushDispatcher.run() };
  };
  // Analytics retention (Phase 31, docs/analytics.md#retention).
  const db = prisma;
  extraHandlers[JOB_NAMES.analyticsPurge] = async (data) => {
    analyticsPurgeJobSchema.parse(data);
    return purgeAnalyticsEvents(db, { retentionDays: env.ANALYTICS_RETENTION_DAYS });
  };
} else {
  logger.warn(
    'DATABASE_URL not set: notification delivery is off (outbox rows wait in the database). ' +
      'To turn it on locally, add DATABASE_URL to apps/worker/.env (see apps/worker/.env.example).',
  );
}

const worker = new Worker(QUEUE_NAMES.system, createProcessor(logger, extraHandlers), {
  connection: bullConnection(env.REDIS_URL),
  concurrency: env.WORKER_CONCURRENCY,
  // Keep a bounded history so Redis memory stays flat.
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
});

let lastErrorLogAt = 0;
worker.on('error', (err) => {
  // Fires on connection problems; BullMQ reconnects automatically. Throttle logs.
  const now = Date.now();
  if (now - lastErrorLogAt < 30_000) return;
  lastErrorLogAt = now;
  const code = errorCode(err);
  logger.error(
    {
      redis: endpointForLog(env.REDIS_URL),
      err: { message: connectionErrorMessage(err), code },
      ...(code === 'ECONNREFUSED' && env.NODE_ENV !== 'production'
        ? {
            hint: 'Redis is not running. Start it with `npm run infra:up` (Docker) or your local Redis service.',
          }
        : {}),
    },
    'Worker connection error (retrying)',
  );
});
worker.on('failed', (job, err) => {
  logger.warn({ jobId: job?.id, jobName: job?.name, err: { message: err.message } }, 'Job failed');
});
// The dispatch schedule lives in Redis (one per queue, upserted at start), so
// running several workers doesn't multiply it; leases in the database keep
// concurrent dispatchers from taking the same row.
const queue = new Queue(QUEUE_NAMES.system, { connection: bullConnection(env.REDIS_URL) });
if (prisma) {
  void queue
    .upsertJobScheduler(
      'notifications-dispatch',
      { every: env.NOTIFICATION_DISPATCH_INTERVAL_MS },
      { name: JOB_NAMES.notificationsDispatch, data: {}, opts: { attempts: 1 } },
    )
    .catch((err: unknown) =>
      logger.error(
        { err: { message: (err as Error).message } },
        'Could not schedule notification dispatch',
      ),
    );
  void queue
    .upsertJobScheduler(
      'analytics-purge',
      { every: 24 * 3600 * 1000 },
      { name: JOB_NAMES.analyticsPurge, data: {}, opts: { attempts: 3 } },
    )
    .catch((err: unknown) =>
      logger.error(
        { err: { message: (err as Error).message } },
        'Could not schedule the analytics purge',
      ),
    );
}

// Liveness beacon for the admin health page (docs/admin.md#platform-health).
const beacon = startBeacon({
  redis: () => queue.client,
  isRunning: () => worker.isRunning() && !worker.isPaused(),
  logger,
});

worker.on('ready', () => {
  logger.info(
    { queue: QUEUE_NAMES.system, concurrency: env.WORKER_CONCURRENCY },
    'Wayora worker ready',
  );
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down worker; waiting for active jobs');

  const forceExit = setTimeout(() => {
    logger.error({ timeoutMs: env.SHUTDOWN_TIMEOUT_MS }, 'Worker shutdown timed out; forcing exit');
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  beacon.stop();
  try {
    await worker.close(); // stops fetching, waits for in-flight jobs
    await queue.close();
    await prisma?.$disconnect();
    logger.info('Worker shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during worker shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error(
    { err: { message: reason instanceof Error ? reason.message : String(reason) } },
    'Unhandled promise rejection',
  );
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err: { message: err.message } }, 'Uncaught exception; shutting down');
  void shutdown('uncaughtException');
});
