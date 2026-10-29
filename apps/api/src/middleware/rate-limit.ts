import {
  MemoryStore,
  rateLimit,
  type ClientRateLimitInfo,
  type Options,
  type Store,
} from 'express-rate-limit';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { errorForLog } from '../utils/log-safety.js';
import type { Logger } from '../utils/logger.js';
import { sendError } from '../utils/respond.js';

const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { hits, ttl }
`;

/**
 * Fixed-window rate-limit store backed by Redis so limits are shared across
 * API instances. If Redis is unavailable it falls back to a per-process
 * memory store instead of failing open, and logs (throttled) once per minute.
 */
export class ResilientRedisStore implements Store {
  readonly prefix: string;
  private windowMs = 60_000;
  private readonly fallback = new MemoryStore();
  private lastWarnAt = 0;

  /** `name` separates limiters sharing one Redis (each limiter needs its own store). */
  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
    name = 'api',
  ) {
    this.prefix = name === 'api' ? 'wayora:rl:' : `wayora:rl:${name}:`;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
    this.fallback.init(options);
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    try {
      const [totalHits, ttl] = (await this.redis.eval(
        INCREMENT_SCRIPT,
        1,
        this.prefix + key,
        String(this.windowMs),
      )) as [number, number];
      return { totalHits, resetTime: new Date(Date.now() + ttl) };
    } catch (error) {
      this.warn(error);
      return this.fallback.increment(key);
    }
  }

  async decrement(key: string): Promise<void> {
    try {
      await this.redis.decr(this.prefix + key);
    } catch {
      await this.fallback.decrement(key);
    }
  }

  async resetKey(key: string): Promise<void> {
    await Promise.allSettled([this.redis.del(this.prefix + key), this.fallback.resetKey(key)]);
  }

  private warn(error: unknown): void {
    const now = Date.now();
    if (now - this.lastWarnAt < 60_000) return;
    this.lastWarnAt = now;
    this.logger.warn(
      { err: errorForLog(error) },
      'Rate-limit store: Redis unavailable, using in-memory fallback',
    );
  }
}

export interface RateLimitConfig {
  windowMs: number;
  max: number;
  store?: Store;
}

/** Rate limiter for `/api/*`. Health endpoints are exempt so probes never get 429. */
export function apiRateLimiter(config: RateLimitConfig) {
  return rateLimit({
    windowMs: config.windowMs,
    limit: config.max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(config.store ? { store: config.store } : {}),
    // originalUrl, not path: this middleware is mounted under /api.
    skip: (req) => req.originalUrl.startsWith('/api/v1/health'),
    handler: (_req, res) => {
      sendError(res, 429, {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Wait a moment and try again.',
      });
    },
  });
}

const AUTH_WINDOW_MS = 15 * 60 * 1000;

/** Login and registration attempts per client IP (stricter than the API-wide limit). */
export function authAttemptLimiter(config: { max: number; store?: Store }) {
  return rateLimit({
    windowMs: AUTH_WINDOW_MS,
    limit: config.max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(config.store ? { store: config.store } : {}),
    handler: (_req, res) => {
      sendError(res, 429, {
        code: 'RATE_LIMITED',
        message: 'Too many sign-in attempts. Wait a few minutes and try again.',
      });
    },
  });
}

/**
 * Failed logins per email address, whatever IP they come from (slows password
 * guessing against one account). Successful logins don't count. The key is a
 * hash, so raw addresses never sit in the rate-limit store. The message is the
 * same whether or not the account exists.
 */
export function loginFailuresPerEmailLimiter(config: {
  max: number;
  store?: Store;
  keyFor: (email: string) => string;
}) {
  return rateLimit({
    windowMs: AUTH_WINDOW_MS,
    limit: config.max,
    standardHeaders: false,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    ...(config.store ? { store: config.store } : {}),
    keyGenerator: (req) => {
      const email = (req.body as { email?: unknown } | undefined)?.email;
      return config.keyFor(typeof email === 'string' ? email.trim().toLowerCase() : '');
    },
    handler: (_req, res) => {
      sendError(res, 429, {
        code: 'RATE_LIMITED',
        message: 'Too many sign-in attempts. Wait a few minutes and try again.',
      });
    },
  });
}

/** Searches per client IP per minute: each one can fan out to several providers. */
export function searchRateLimiter(config: { max: number; store?: Store }) {
  return rateLimit({
    windowMs: 60_000,
    limit: config.max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(config.store ? { store: config.store } : {}),
    handler: (_req, res) => {
      sendError(res, 429, {
        code: 'RATE_LIMITED',
        message: 'Too many searches in a short time. Wait a moment and try again.',
      });
    },
  });
}

/**
 * Booking writes (create, cancel) per signed-in user per minute. Mounted after
 * `requireAuth`, so the key is the session's user id: one account can't
 * spread its writes across IPs, and people sharing an IP don't share a budget.
 */
export function bookingWriteRateLimiter(config: {
  max: number;
  store?: Store;
  userIdOf: (res: Response) => string;
  /** What the limit is about, in the 429 message (default: booking changes). */
  subject?: string;
  /** Window length (default one minute). */
  windowMs?: number;
}) {
  return rateLimit({
    windowMs: config.windowMs ?? 60_000,
    limit: config.max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (_req, res) => `user:${config.userIdOf(res)}`,
    ...(config.store ? { store: config.store } : {}),
    handler: (_req, res) => {
      sendError(res, 429, {
        code: 'RATE_LIMITED',
        message: `Too many ${config.subject ?? 'booking changes'} in a short time. Wait a moment and try again.`,
      });
    },
  });
}
