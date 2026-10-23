import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConnectionOptions } from 'bullmq';
import { z } from 'zod';

export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
  REDIS_URL: z
    .string({ error: 'REDIS_URL is required' })
    .regex(/^rediss?:\/\//, 'REDIS_URL must start with redis:// or rediss://'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  /**
   * PostgreSQL, for the notification outbox (Phase 14). Without it the worker
   * runs its other jobs and logs that notification delivery is off; the
   * outbox rows wait in the database until a worker with access runs.
   */
  DATABASE_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must start with postgresql://')
      .optional(),
  ),
  /** Public web origin for links in emails, e.g. https://wayora.example. */
  WEB_ORIGIN: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),
  /** How often the outbox is checked. */
  NOTIFICATION_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(1000).max(600_000).default(15_000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** Loads apps/worker/.env (if present) and validates; exits with a clear message on failure. */
export function loadWorkerEnv(): WorkerEnv {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const file = path.join(appRoot, '.env');
  if (existsSync(file)) process.loadEnvFile(file);

  const result = workerEnvSchema.safeParse(process.env);
  if (result.success) return result.data;

  const lines = result.error.issues.map((issue) => {
    const key = issue.path.join('.');
    return process.env[key] === undefined
      ? `  - ${key}: is required but not set`
      : `  - ${key}: ${issue.message}`;
  });
  process.stderr.write(
    [
      '',
      'Invalid environment configuration for @wayora/worker:',
      ...lines,
      '',
      'Fix: copy apps/worker/.env.example to apps/worker/.env (or run `npm run setup`).',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

/**
 * Converts REDIS_URL into BullMQ connection options. BullMQ requires
 * `maxRetriesPerRequest: null` so blocking commands are never aborted.
 */
export function bullConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const db = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0;
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    db: Number.isInteger(db) ? db : 0,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}
