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
  // Payments (docs/payments.md#configuration).
  /**
   * The provider for new payments: `demo` (the simulator: no money moves) or
   * `none` (payments off: new bookings are confirmed without a payment, as in
   * Phase 12). Unset means `demo` in development and test, `none` in production.
   */
  PAYMENT_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['none', 'demo']).optional()),
  /**
   * Let requests ask the demo simulator for an outcome (decline, pending…).
   * Unset means on in development and test, off in production. Only valid
   * with PAYMENT_PROVIDER=demo.
   */
  PAYMENT_DEMO_SCENARIOS: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).optional()),
  /** How long a booking waits for its payment before it expires. */
  PAYMENT_WINDOW_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  /** How long the demo simulator's `pending` scenarios stay pending. */
  PAYMENT_DEMO_PENDING_SECONDS: z.coerce.number().int().min(1).max(300).default(8),
  /** Payment starts and cancellations per signed-in user per minute. */
  PAYMENT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  /** Notification writes (mark read, read all, preferences) per signed-in user per minute. */
  NOTIFICATION_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  /** Trip-planner writes (trips, activities, reorders) per signed-in user per minute. */
  PLANNER_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  /** Plan invitations sent per signed-in user per hour (each looks up an account by email). */
  PLANNER_INVITE_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  /**
   * Travel-status provider (Phase 17, docs/trips.md#providers): `demo`
   * (simulated, labelled as such) or `none`. No live provider exists yet.
   * Unset: `demo` in development and test, `none` in production.
   */
  TRAVEL_STATUS_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['none', 'demo']).optional()),
  /** A status observed within this many seconds is shown as current; older is stale. */
  TRAVEL_STATUS_FRESH_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  /** A booking's provider is asked at most once per this many seconds. */
  TRAVEL_STATUS_MIN_REFRESH_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  /** Time limit for one provider request. */
  TRAVEL_STATUS_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5000),
  /** Status refreshes per signed-in user per minute. */
  TRAVEL_STATUS_REFRESH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  /** How often active trips are checked in the background; 0 turns it off. */
  TRAVEL_STATUS_SWEEP_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
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
  // Travel assistant (Phase 21, docs/assistant.md#configuration).
  /**
   * Who answers: `demo` (Wayora's rule-based demo assistant, not AI; no
   * network), `anthropic` (a language model through the Anthropic Messages
   * API; needs AI_API_KEY and AI_MODEL) or `none` (assistant off; the rest of
   * Wayora works as usual). Unset: `demo` in development and test, `none` in
   * production.
   */
  AI_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['none', 'demo', 'anthropic']).optional()),
  /** Provider API key. Server-side only; never logged, returned or sent to the browser. */
  AI_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  /** The provider's model id. Required for a live provider: no model is assumed. */
  AI_MODEL: z.preprocess(emptyToUndefined, z.string().min(1).max(120).optional()),
  /** Override the provider's API origin (e.g. a gateway). */
  AI_BASE_URL: z.preprocess(emptyToUndefined, httpUrl('AI_BASE_URL').optional()),
  /** Overall time budget for one reply, retries included. */
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(45_000).default(25_000),
  /** Attempts per reply (1 = no retry). Only rate-limit, overload and network errors are retried. */
  AI_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(3).default(2),
  /** Upper bound on the provider's output per reply. */
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(8192).default(2048),
  /** Assistant requests per signed-in user per minute. */
  AI_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(6),
  /** Assistant requests per signed-in user per 24 hours (cost cap). */
  AI_DAILY_REQUEST_LIMIT: z.coerce.number().int().min(1).max(10_000).default(50),
  /** Consecutive failed calls that open a provider's circuit breaker. */
  SEARCH_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(100).default(5),
  /** How long an open breaker skips the provider before one trial call (half-open). */
  SEARCH_BREAKER_COOLDOWN_SECONDS: z.coerce.number().int().min(1).max(600).default(30),
  // Supplier reservations (Phase 23, docs/bookings.md#supplier-reservations).
  /**
   * Book supplier (non-demo) offers through a provider that implements
   * reservations. Off unless set to true; no real supplier implements
   * reservations yet, so turning it on changes nothing until one does.
   */
  SUPPLIER_RESERVATIONS_ENABLED: z.preprocess(
    emptyToUndefined,
    z.enum(['true', 'false']).default('false'),
  ),
  /** Time limit for one reservation, lookup or cancellation call (the web client waits 15 s). */
  SUPPLIER_RESERVATION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(14_000).default(12_000),
});

/** Which search-session store this configuration selects. */
export function searchSessionStore(env: Env): 'redis' | 'memory' {
  return env.SEARCH_SESSION_STORE ?? (env.REDIS_URL ? 'redis' : 'memory');
}

export function travelStatusProvider(env: Env): 'none' | 'demo' {
  return env.TRAVEL_STATUS_PROVIDER ?? (env.NODE_ENV === 'production' ? 'none' : 'demo');
}

export function assistantProvider(env: Env): 'none' | 'demo' | 'anthropic' {
  return env.AI_PROVIDER ?? (env.NODE_ENV === 'production' ? 'none' : 'demo');
}

/** Whether demo providers are on, given the environment. */
export function paymentProvider(env: Env): 'none' | 'demo' {
  return env.PAYMENT_PROVIDER ?? (env.NODE_ENV === 'production' ? 'none' : 'demo');
}

export function demoPaymentScenariosEnabled(env: Env): boolean {
  if (paymentProvider(env) !== 'demo') return false;
  if (env.PAYMENT_DEMO_SCENARIOS !== undefined) return env.PAYMENT_DEMO_SCENARIOS === 'true';
  return env.NODE_ENV !== 'production';
}

export function demoProvidersEnabled(env: Env): boolean {
  if (env.SEARCH_DEMO_PROVIDERS !== undefined) return env.SEARCH_DEMO_PROVIDERS === 'true';
  return env.NODE_ENV !== 'production';
}

export type Env = z.infer<typeof envSchema>;

/**
 * Credentials that exist only for local development (the Docker Compose and
 * `.env.example` defaults). Production refuses to start with them.
 */
export const DEV_ONLY_CREDENTIALS = ['wayora_local_dev_only', 'wayora_ci_only'] as const;

const usesDevCredential = (url: string | undefined) =>
  url !== undefined && DEV_ONLY_CREDENTIALS.some((secret) => url.includes(secret));

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
    if (!env.API_BASE_URL.startsWith('https://')) {
      issues.push('API_BASE_URL: must use https:// in production');
    }
    // The values are never echoed: only which variable is wrong.
    if (usesDevCredential(env.DATABASE_URL)) {
      issues.push(
        'DATABASE_URL: uses the local development password; set the production credentials',
      );
    }
    if (usesDevCredential(env.REDIS_URL)) {
      issues.push('REDIS_URL: uses a local development password; set the production credentials');
    }
    // Per-process sessions break offer pages behind a load balancer and on
    // every restart, so production never falls back to memory.
    if (searchSessionStore(env) !== 'redis') {
      issues.push(
        'SEARCH_SESSION_STORE: must be "redis" in production (set REDIS_URL); in-memory search sessions are for local development only',
      );
    }
  }
  if (env.PAYMENT_DEMO_SCENARIOS === 'true' && paymentProvider(env) !== 'demo') {
    issues.push('PAYMENT_DEMO_SCENARIOS: only valid with PAYMENT_PROVIDER=demo');
  }
  if (assistantProvider(env) === 'anthropic') {
    // Names only, never values.
    if (!env.AI_API_KEY) issues.push('AI_API_KEY: is required when AI_PROVIDER=anthropic');
    if (!env.AI_MODEL) issues.push('AI_MODEL: is required when AI_PROVIDER=anthropic');
    if (
      env.NODE_ENV === 'production' &&
      env.AI_BASE_URL &&
      !env.AI_BASE_URL.startsWith('https://')
    ) {
      issues.push('AI_BASE_URL: must use https:// in production');
    }
  }
  if (env.SEARCH_SESSION_STORE === 'redis' && !env.REDIS_URL) {
    issues.push('SEARCH_SESSION_STORE: "redis" needs REDIS_URL');
  }
  return issues;
}

/**
 * Settings that are valid but risky in production. The server logs them at
 * start-up (names and reasons only, never values) instead of refusing to run,
 * because each can be intended (e.g. a demo deployment).
 */
export function productionWarnings(env: Env): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const warnings: string[] = [];
  if (env.TRUST_PROXY === false) {
    warnings.push(
      "TRUST_PROXY is false: behind a load balancer or reverse proxy every client gets the proxy's IP, so per-IP rate limits are shared by everyone. Set it to the number of proxy hops.",
    );
  }
  if (demoProvidersEnabled(env)) {
    warnings.push(
      'SEARCH_DEMO_PROVIDERS is on: search shows demo inventory (fixtures), not live suppliers.',
    );
  }
  if (paymentProvider(env) === 'demo') {
    warnings.push('PAYMENT_PROVIDER is demo: payments are simulated; no money moves.');
    if (env.SUPPLIER_RESERVATIONS_ENABLED === 'true')
      warnings.push(
        'SUPPLIER_RESERVATIONS_ENABLED is on: supplier offers from providers that implement reservations can be booked for real.',
      );
  }
  if (travelStatusProvider(env) === 'demo') {
    warnings.push(
      'TRAVEL_STATUS_PROVIDER is demo: trip status and disruptions are simulated, not real travel information.',
    );
  }
  if (assistantProvider(env) === 'demo') {
    warnings.push(
      'AI_PROVIDER is demo: the travel assistant gives rule-based demo answers, not AI.',
    );
  }
  if (env.LOG_FORMAT === 'pretty') {
    warnings.push('LOG_FORMAT=pretty is ignored in production; logs are JSON.');
  }
  return warnings;
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
