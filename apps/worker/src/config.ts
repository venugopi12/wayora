import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConnectionOptions } from 'bullmq';
import { z } from 'zod';

const optionalText = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().trim().optional(),
);

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
  // Browser push (Phase 30, docs/pwa.md#push): the VAPID key pair and a
  // contact for push services. All three, or none (push off). The private
  // key is a secret: keep it in the secret store, never in the web app.
  VAPID_PUBLIC_KEY: optionalText,
  VAPID_PRIVATE_KEY: optionalText,
  VAPID_SUBJECT: optionalText,
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** The VAPID configuration when push is set up (all three values present and well formed). */
export function vapidConfig(env: WorkerEnv) {
  const {
    VAPID_PUBLIC_KEY: publicKey,
    VAPID_PRIVATE_KEY: privateKey,
    VAPID_SUBJECT: subject,
  } = env;
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

/** Problems with the push settings (any environment). Values are never echoed. */
export function vapidIssues(env: WorkerEnv): string[] {
  const set = [env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT].filter(
    Boolean,
  ).length;
  if (set === 0) return [];
  const issues: string[] = [];
  if (set < 3)
    issues.push('VAPID_*: set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT together');
  if (env.VAPID_PUBLIC_KEY && !/^B[A-Za-z0-9_-]{86}$/.test(env.VAPID_PUBLIC_KEY)) {
    issues.push('VAPID_PUBLIC_KEY: must be a base64url P-256 public key (87 characters)');
  }
  if (env.VAPID_PRIVATE_KEY && !/^[A-Za-z0-9_-]{43}$/.test(env.VAPID_PRIVATE_KEY)) {
    issues.push('VAPID_PRIVATE_KEY: must be a base64url P-256 private key (43 characters)');
  }
  if (env.VAPID_SUBJECT && !/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(env.VAPID_SUBJECT)) {
    issues.push('VAPID_SUBJECT: must be a mailto: address or an https:// URL');
  }
  return issues;
}

/** Local development credentials (Docker Compose / .env.example). Refused in production. */
const DEV_ONLY_CREDENTIALS = ['wayora_local_dev_only', 'wayora_ci_only'];

/**
 * Production rules a single field can't express. Values are never echoed,
 * only which variable is wrong.
 */
export function productionIssues(env: WorkerEnv): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const issues: string[] = [];
  if (!env.DATABASE_URL) {
    issues.push(
      'DATABASE_URL: is required in production (the worker delivers the notification outbox)',
    );
  }
  for (const key of ['DATABASE_URL', 'REDIS_URL'] as const) {
    const value = env[key];
    if (value && DEV_ONLY_CREDENTIALS.some((secret) => value.includes(secret))) {
      issues.push(`${key}: uses a local development password; set the production credentials`);
    }
  }
  if (env.WEB_ORIGIN && !env.WEB_ORIGIN.startsWith('https://')) {
    issues.push('WEB_ORIGIN: must use https:// in production (it is used in email links)');
  }
  return issues;
}

/** Validates an environment; returns the parsed value or the list of problems. */
export function validateWorkerEnv(
  source: Record<string, string | undefined>,
): { ok: true; env: WorkerEnv } | { ok: false; issues: string[] } {
  const result = workerEnvSchema.safeParse(source);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => {
        const key = issue.path.join('.');
        return source[key] === undefined
          ? `${key}: is required but not set`
          : `${key}: ${issue.message}`;
      }),
    };
  }
  const issues = [...vapidIssues(result.data), ...productionIssues(result.data)];
  return issues.length ? { ok: false, issues } : { ok: true, env: result.data };
}

/** Loads apps/worker/.env (if present) and validates; exits with a clear message on failure. */
export function loadWorkerEnv(): WorkerEnv {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const file = path.join(appRoot, '.env');
  if (existsSync(file)) process.loadEnvFile(file);

  const result = validateWorkerEnv(process.env);
  if (result.ok) return result.env;

  const lines = result.issues.map((issue) => `  - ${issue}`);
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
