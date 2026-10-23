import { z } from 'zod';

/** BullMQ queue names. One queue per concern keeps retry/concurrency tuning independent. */
export const QUEUE_NAMES = {
  system: 'wayora-system',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const JOB_NAMES = {
  systemHeartbeat: 'system.heartbeat',
  /** Works through the notification email outbox (Phase 14, docs/notifications.md#delivery). */
  notificationsDispatch: 'notifications.dispatch',
} as const;

/**
 * Job payloads carry identifiers and non-sensitive metadata only — never PII,
 * credentials, card data or tokens. Workers load anything sensitive from the
 * database by ID at execution time.
 */
export const heartbeatJobSchema = z
  .object({
    requestedAt: z.iso.datetime(),
    source: z.enum(['api', 'cli', 'scheduler']),
    correlationId: z.string().min(1).max(128).optional(),
  })
  .strict();
export type HeartbeatJob = z.infer<typeof heartbeatJobSchema>;

export const heartbeatJobResultSchema = z.object({
  processedAt: z.iso.datetime(),
  queueLatencyMs: z.number().int().nonnegative(),
});
export type HeartbeatJobResult = z.infer<typeof heartbeatJobResultSchema>;

/** The dispatch job carries nothing: the work is in the database outbox. */
export const notificationsDispatchJobSchema = z.object({}).strict();
export type NotificationsDispatchJob = z.infer<typeof notificationsDispatchJobSchema>;
