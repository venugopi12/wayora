/**
 * Enqueues one example heartbeat job and waits for the running worker to
 * process it. Usage (with `npm run dev:worker` running in another terminal):
 *
 *   npm run job:example
 */
import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents } from 'bullmq';
import { JOB_NAMES, QUEUE_NAMES, heartbeatJobSchema } from '@wayora/contracts';
import { bullConnection, loadWorkerEnv } from '../config.js';

const env = loadWorkerEnv();
const connection = bullConnection(env.REDIS_URL);
const queue = new Queue(QUEUE_NAMES.system, { connection });
const events = new QueueEvents(QUEUE_NAMES.system, { connection });

try {
  await events.waitUntilReady();
  const payload = heartbeatJobSchema.parse({
    requestedAt: new Date().toISOString(),
    source: 'cli',
    correlationId: randomUUID(),
  });
  const job = await queue.add(JOB_NAMES.systemHeartbeat, payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1_000 },
  });
  console.log(`Enqueued ${job.name} (id ${job.id}) on ${QUEUE_NAMES.system}. Waiting for worker…`);

  const result = await job.waitUntilFinished(events, 15_000);
  console.log('Job completed with result:', result);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Example job did not complete: ${message}`);
  console.error('Is the worker running (npm run dev:worker) and is Redis up (npm run infra:up)?');
  process.exitCode = 1;
} finally {
  await Promise.allSettled([events.close(), queue.close()]);
}
