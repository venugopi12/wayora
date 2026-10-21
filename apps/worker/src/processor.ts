import { UnrecoverableError, type Job } from 'bullmq';
import { ZodError } from 'zod';
import { JOB_NAMES } from '@wayora/contracts';
import { processHeartbeat } from './jobs/heartbeat.js';
import type { Logger } from './logger.js';

type Handler = (data: unknown) => Promise<unknown> | unknown;

/** Registry of job handlers for the system queue. Add new jobs here. */
const handlers: Record<string, Handler> = {
  [JOB_NAMES.systemHeartbeat]: (data) => processHeartbeat(data),
};

/**
 * Dispatches a job to its handler. Invalid payloads and unknown job names are
 * `UnrecoverableError`s — retrying them can never succeed, so BullMQ fails
 * them immediately instead of burning retries. Payloads are never logged.
 */
export function createProcessor(logger: Logger) {
  return async function process(job: Job): Promise<unknown> {
    const handler = handlers[job.name];
    const log = logger.child({ jobId: job.id, jobName: job.name, attempt: job.attemptsMade + 1 });

    if (!handler) {
      log.error('No handler registered for job');
      throw new UnrecoverableError(`Unknown job "${job.name}"`);
    }

    try {
      const result = await handler(job.data);
      log.info('Job completed');
      return result;
    } catch (error) {
      if (error instanceof ZodError) {
        log.error({ issues: error.issues.map((i) => i.path.join('.')) }, 'Invalid job payload');
        throw new UnrecoverableError(`Invalid payload for "${job.name}"`);
      }
      throw error;
    }
  };
}
