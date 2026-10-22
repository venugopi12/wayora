import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const httpUrl = (name: string) =>
  z.url({ protocol: /^https?$/, error: `${name} must be an http(s) URL` });

const originList = z
  .string({ error: 'CORS_ORIGIN is required' })
  .min(1, 'CORS_ORIGIN is required')
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  .pipe(
    z
      .array(
        z
          .string()
          .refine((origin) => origin !== '*', {
            message: 'wildcard "*" is not allowed; list explicit origins',
          })
          .refine((origin) => /^https?:\/\/[^/]+$/.test(origin), {
            message: 'each origin must look like http(s)://host[:port] with no path',
          }),
      )
      .min(1, 'CORS_ORIGIN must contain at least one origin'),
  );

const trustProxy = z
  .string()
  .default('false')
  .transform((value, ctx): boolean | number => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    const hops = Number(value);
    if (Number.isInteger(hops) && hops >= 0) return hops;
    ctx.addIssue({ code: 'custom', message: 'TRUST_PROXY must be true, false or a hop count' });
    return z.NEVER;
  });

const emptyToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required' })
    .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgresql:// connection string'),
  REDIS_URL: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^rediss?:\/\//, 'REDIS_URL must start with redis:// or rediss://')
      .optional(),
  ),
  CORS_ORIGIN: originList,
  WEB_ORIGIN: httpUrl('WEB_ORIGIN'),
  API_BASE_URL: httpUrl('API_BASE_URL'),
  TRUST_PROXY: trustProxy,
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(1_500),
  // Sessions (docs/auth.md#session-lifecycle).
  /** A session ends after this many hours without a request. */
  SESSION_IDLE_TIMEOUT_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .default(24 * 7),
  /** A session ends this many hours after sign-in, however active it is. */
  SESSION_ABSOLUTE_TIMEOUT_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 365)
    .default(24 * 30),
  // Authentication rate limits (per 15 minutes).
  /** Login + registration attempts per client IP. */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  /** Failed logins per email address (successful logins don't count). */
  LOGIN_FAILURES_PER_EMAIL_MAX: z.coerce.number().int().positive().default(10),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // Search (docs/search.md#configuration).
  /**
   * Serve the built-in demo providers. Unset means: on in development and
   * test, OFF in production (fixtures must never pass for live inventory by
   * accident).
   */
  SEARCH_DEMO_PROVIDERS: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).optional()),
  /** Comma-separated provider ids to switch off, e.g. `demo-cabs`. */
  SEARCH_DISABLED_PROVIDERS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  /** Searches per client IP per minute (on top of RATE_LIMIT_MAX). */
  SEARCH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  /** Booking creations and cancellations per signed-in user per minute (docs/bookings.md). */
  BOOKING_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  /**
   * Where search sessions live (docs/search.md#search-sessions). `redis` keeps
   * them across API restarts and instances; `memory` is per process and only
   * allowed outside production. Unset: `redis` when REDIS_URL is set, else `memory`.
   */
  SEARCH_SESSION_STORE: z.preprocess(emptyToUndefined, z.enum(['redis', 'memory']).optional()),
  /**
   * How long a search session lives: reused for paging, sorting and filtering,
   * and read by offer pages. Offers are valid only within it. (Formerly
   * SEARCH_CACHE_TTL_SECONDS, still accepted.)
   */
  SEARCH_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(600),
  /** Overall time budget for one search or offer check, retries included. */
  SEARCH_DEADLINE_MS: z.coerce.number().int().min(500).max(14_000).default(8_000),
  /** Attempts per provider call (1 = no retry). Only transient failures of read operations are retried. */
  SEARCH_PROVIDER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(4).default(2),
  /** Base delay for exponential backoff with full jitter between attempts. */
  SEARCH_PROVIDER_RETRY_BASE_MS: z.coerce.number().int().min(0).max(2_000).default(200),
  /** Consecutive failed calls that open a provider's circuit breaker. */
  SEARCH_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(100).default(5),
  /** How long an open breaker skips the provider before one trial call (half-open). */
  SEARCH_BREAKER_COOLDOWN_SECONDS: z.coerce.number().int().min(1).max(600).default(30),
});

/** Which search-session store this configuration selects. */
export function searchSessionStore(env: Env): 'redis' | 'memory' {
  return env.SEARCH_SESSION_STORE ?? (env.REDIS_URL ? 'redis' : 'memory');
}

/** Whether demo providers are on, given the environment. */
export function demoProvidersEnabled(env: Env): boolean {
  if (env.SEARCH_DEMO_PROVIDERS !== undefined) return env.SEARCH_DEMO_PROVIDERS === 'true';
  return env.NODE_ENV !== 'production';
}

export type Env = z.infer<typeof envSchema>;

/** Cross-field rules that a single field schema can't express. */
function crossFieldIssues(env: Env): string[] {
  const issues: string[] = [];
  if (env.SESSION_IDLE_TIMEOUT_HOURS > env.SESSION_ABSOLUTE_TIMEOUT_HOURS) {
    issues.push('SESSION_IDLE_TIMEOUT_HOURS: must not exceed SESSION_ABSOLUTE_TIMEOUT_HOURS');
  }
  if (env.NODE_ENV === 'production') {
    // Session cookies are Secure in production, so every browser origin must be HTTPS.
    for (const origin of env.CORS_ORIGIN) {
      if (!origin.startsWith('https://')) {
        issues.push(`CORS_ORIGIN: ${origin} must use https:// in production`);
      }
    }
    if (!env.WEB_ORIGIN.startsWith('https://')) {
      issues.push('WEB_ORIGIN: must use https:// in production');
    }
    // Per-process sessions break offer pages behind a load balancer and on
    // every restart, so production never falls back to memory.
    if (searchSessionStore(env) !== 'redis') {
      issues.push(
        'SEARCH_SESSION_STORE: must be "redis" in production (set REDIS_URL); in-memory search sessions are for local development only',
      );
    }
  }
  if (env.SEARCH_SESSION_STORE === 'redis' && !env.REDIS_URL) {
    issues.push('SEARCH_SESSION_STORE: "redis" needs REDIS_URL');
  }
  return issues;
}

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(
      [
        'Invalid environment configuration for @wayora/api:',
        ...issues.map((issue) => `  - ${issue}`),
        '',
        'Fix: copy apps/api/.env.example to apps/api/.env (or run `npm run setup`) and set the values above.',
      ].join('\n'),
    );
    this.name = 'EnvValidationError';
  }
}

/** Parses and validates environment variables. Throws EnvValidationError with actionable messages. */
export function parseEnv(input: Record<string, string | undefined>): Env {
  // Accept the Phase 9/10 name for the session lifetime.
  const source =
    input.SEARCH_SESSION_TTL_SECONDS === undefined && input.SEARCH_CACHE_TTL_SECONDS !== undefined
      ? { ...input, SEARCH_SESSION_TTL_SECONDS: input.SEARCH_CACHE_TTL_SECONDS }
      : input;
  const result = envSchema.safeParse(source);
  if (result.success) {
    const issues = crossFieldIssues(result.data);
    if (issues.length) throw new EnvValidationError(issues);
    return result.data;
  }

  const issues = result.error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    const missing = issue.code === 'invalid_type' && source[key] === undefined;
    return missing ? `${key}: is required but not set` : `${key}: ${issue.message}`;
  });
  throw new EnvValidationError(issues);
}
