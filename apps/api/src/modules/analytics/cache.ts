/*
 * Report cache (docs/analytics.md#caching). Reports are read-only
 * aggregates, so a short cache is safe: a period that has ended can't
 * change any more (except for late records, see the doc), and one that
 * includes today is cached for a minute. Keys carry everything the result
 * depends on: report, resolved period and timezone, granularity and the
 * viewer's scope (which sections their role may see), so one role's
 * report is never served to another. Invalidation is by expiry only.
 */

export interface AnalyticsCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/** Bounded per-process cache (development, tests, no Redis). */
export class MemoryAnalyticsCache implements AnalyticsCache {
  private readonly entries = new Map<string, { value: string; expires: number }>();
  constructor(
    private readonly capacity = 200,
    private readonly now: () => number = Date.now,
  ) {}
  get(key: string): Promise<string | null> {
    const e = this.entries.get(key);
    if (!e) return Promise.resolve(null);
    if (e.expires <= this.now()) {
      this.entries.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(e.value);
  }
  set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expires: this.now() + ttlSeconds * 1000 });
    return Promise.resolve();
  }
}

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

/** Shared across API instances. A Redis failure means "not cached", never an error. */
export function redisAnalyticsCache(redis: RedisLike): AnalyticsCache {
  return {
    async get(key) {
      try {
        return await redis.get(key);
      } catch {
        return null;
      }
    },
    async set(key, value, ttl) {
      try {
        await redis.set(key, value, 'EX', ttl);
      } catch {
        // Not cached; the next request recomputes.
      }
    },
  };
}

/** Bump when a report's shape or calculation changes, so old entries are never read. */
export const CACHE_VERSION = 'v1';
export const TTL_OPEN_PERIOD_SECONDS = 60;
export const TTL_CLOSED_PERIOD_SECONDS = 15 * 60;
