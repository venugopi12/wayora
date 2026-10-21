import type { Options } from 'express-rate-limit';
import type { Redis } from 'ioredis';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { ResilientRedisStore } from '../src/middleware/rate-limit.js';

const options = { windowMs: 60_000 } as Options;

describe('ResilientRedisStore', () => {
  it('uses Redis when it is available', async () => {
    const redis = { eval: vi.fn().mockResolvedValue([3, 30_000]) } as unknown as Redis;
    const store = new ResilientRedisStore(redis, pino({ level: 'silent' }));
    store.init(options);

    const info = await store.increment('1.2.3.4');
    expect(info.totalHits).toBe(3);
    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), 1, 'wayora:rl:1.2.3.4', '60000');
  });

  it('falls back to in-memory counting (not fail-open) when Redis errors', async () => {
    const redis = {
      eval: vi.fn().mockRejectedValue(new Error("Stream isn't writeable")),
    } as unknown as Redis;
    const logger = pino({ level: 'silent' });
    const warn = vi.spyOn(logger, 'warn');
    const store = new ResilientRedisStore(redis, logger);
    store.init(options);

    expect((await store.increment('k')).totalHits).toBe(1);
    expect((await store.increment('k')).totalHits).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1); // throttled
  });
});
