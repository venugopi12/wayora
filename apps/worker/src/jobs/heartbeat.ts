import { heartbeatJobSchema, type HeartbeatJobResult } from '@wayora/contracts';

/**
 * Example job: proves the queue → worker → result path end-to-end and reports
 * how long the job waited in the queue. Pure function so it is trivially testable.
 */
export function processHeartbeat(payload: unknown, now: Date = new Date()): HeartbeatJobResult {
  const job = heartbeatJobSchema.parse(payload);
  const queuedAt = new Date(job.requestedAt).getTime();
  return {
    processedAt: now.toISOString(),
    queueLatencyMs: Math.max(0, now.getTime() - queuedAt),
  };
}
