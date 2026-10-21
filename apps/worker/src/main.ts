import { Worker } from 'bullmq';
import { QUEUE_NAMES } from '@wayora/contracts';
import { bullConnection, loadWorkerEnv } from './config.js';
import { createLogger } from './logger.js';
import { createProcessor } from './processor.js';

const env = loadWorkerEnv();
const logger = createLogger(env);

const worker = new Worker(QUEUE_NAMES.system, createProcessor(logger), {
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
  logger.error({ err: { message: err.message } }, 'Worker connection error (retrying)');
});
worker.on('failed', (job, err) => {
  logger.warn({ jobId: job?.id, jobName: job?.name, err: { message: err.message } }, 'Job failed');
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

  try {
    await worker.close(); // stops fetching, waits for in-flight jobs
    logger.info('Worker shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during worker shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
