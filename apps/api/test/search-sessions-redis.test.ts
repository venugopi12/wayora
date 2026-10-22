import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../src/modules/providers/registry.js';
import { SearchService } from '../src/modules/search/search.service.js';
import { RedisSearchSessionStore } from '../src/modules/search/sessions.js';
import { createRedisConnection, type RedisConnection } from '../src/services/redis.js';
import { buildTestApp } from './helpers.js';
import {
  NO_RETRY,
  VALID_INPUTS,
  hotelResult,
  hotelsRequest,
  stubProvider,
} from './search-support.js';

/*
 * Search sessions against a real Redis (TEST_REDIS_URL, e.g.
 * redis://localhost:6379/15). Every key this suite writes is under a unique
 * prefix and is deleted afterwards; nothing else in that Redis is touched
 * (no FLUSHDB). Reported as skipped without TEST_REDIS_URL; required in CI.
 */

const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
if (process.env.CI && !TEST_REDIS_URL) {
  throw new Error('CI is set but TEST_REDIS_URL is not: the Redis session tests would be skipped.');
}

const ORIGIN = 'http://localhost:5173';
const silent = pino({ level: 'silent' });
const { serviceType: _t, ...flightsBody } = VALID_INPUTS.flights;

describe.skipIf(!TEST_REDIS_URL)('search sessions (integration, real Redis)', () => {
  const prefix = `wayora:test:${randomUUID()}:search:`;
  let connection: RedisConnection;
  const connections: RedisConnection[] = [];

  /** A fresh client per "API instance", like separate processes. */
  const connect = async () => {
    const c = createRedisConnection(TEST_REDIS_URL!, silent);
    await c.connect();
    await c.ping();
    connections.push(c);
    return c;
  };
  const store = (c: RedisConnection) => new RedisSearchSessionStore(c.client, silent, { prefix });

  beforeAll(async () => {
    connection = await connect();
  });

  afterAll(async () => {
    const keys = await connection.client.keys(`${prefix}*`);
    if (keys.length > 0) await connection.client.del(...keys);
    await Promise.all(connections.map((c) => c.close()));
  });

  it('a search made through one API instance is readable through another, after the first is gone', async () => {
    const first = await connect();
    const appA = buildTestApp({ searchSessions: store(first) });
    const search = await request(appA)
      .post('/api/v1/search/flights')
      .set('Origin', ORIGIN)
      .send(flightsBody);
    expect(search.status).toBe(200);
    const { searchId, results, expiresAt } = search.body.data;
    await first.close(); // "restart": that process and its connection are gone

    const appB = buildTestApp({ searchSessions: store(await connect()) });
    const offer = await request(appB).get(
      `/api/v1/search/flights/sessions/${searchId}/offer?id=${encodeURIComponent(results[0].id)}`,
    );
    expect(offer.status).toBe(200);
    expect(offer.body.data).toMatchObject({ searchId, expiresAt, result: results[0] });
    // Paging on instance B reuses the same session instead of asking providers again.
    const page2 = await request(appB)
      .post('/api/v1/search/flights')
      .set('Origin', ORIGIN)
      .send({ ...flightsBody, sortBy: 'price-desc' });
    expect(page2.body.data.searchId).toBe(searchId);
  });

  it('keys are namespaced and expire with the session lifetime (PTTL)', async () => {
    const app = buildTestApp({ searchSessions: store(connection) });
    const search = await request(app)
      .post('/api/v1/search/flights')
      .set('Origin', ORIGIN)
      .send(flightsBody);
    const key = `${prefix}${search.body.data.searchId}`;
    const pttl = await connection.client.pttl(key);
    expect(pttl).toBeGreaterThan(590_000);
    expect(pttl).toBeLessThanOrEqual(600_000);
    const reuse = await connection.client.keys(`${prefix}reuse:flights:*`);
    expect(reuse.length).toBeGreaterThan(0);
  });

  it('Redis expires sessions on its own: after the TTL the offer is SEARCH_EXPIRED', async () => {
    const registry = new ProviderRegistry({ demoEnabled: true });
    registry.register(
      stubProvider('p1', { kind: 'results', results: [hotelResult('p1', 'a', 1000)] }),
    );
    const service = new SearchService({
      registry,
      logger: silent,
      sessions: store(connection),
      sessionTtlMs: 300, // shorter than any configurable value, to keep the test fast
      resilience: NO_RETRY,
    });
    const { searchId } = await service.search(hotelsRequest());
    await expect(service.offer('hotels', searchId, 'p1:a')).resolves.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(await connection.client.exists(`${prefix}${searchId}`)).toBe(0);
    await expect(service.offer('hotels', searchId, 'p1:a')).rejects.toMatchObject({
      code: 'SEARCH_EXPIRED',
    });
  });

  it('concurrent searches from two instances get unique, readable sessions', async () => {
    const apps = [
      buildTestApp({ searchSessions: store(await connect()) }),
      buildTestApp({ searchSessions: store(await connect()) }),
    ];
    const bodies = ['airport:DEL', 'airport:BOM', 'airport:GOI', 'airport:HYD'].map(
      (destination) => ({
        ...flightsBody,
        destination,
      }),
    );
    const responses = await Promise.all(
      bodies.flatMap((body, i) => [
        request(apps[i % 2]!)
          .post('/api/v1/search/flights')
          .set('Origin', ORIGIN)
          .send(body),
        request(apps[(i + 1) % 2]!)
          .post('/api/v1/search/flights')
          .set('Origin', ORIGIN)
          .send({ ...body, adults: 2 }),
      ]),
    );
    const ids = responses.map((r) => r.body.data.searchId as string);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [i, r] of responses.entries()) {
      const offer = await request(apps[(i + 1) % 2]!).get(
        `/api/v1/search/flights/sessions/${r.body.data.searchId}/offer?id=${encodeURIComponent(r.body.data.results[0].id)}`,
      );
      expect(offer.status).toBe(200);
    }
  });

  it('an unreachable Redis is a fast, safe 503 (commands fail instead of queueing)', async () => {
    const dead = createRedisConnection('redis://127.0.0.1:1', silent);
    await dead.connect();
    connections.push(dead);
    const app = buildTestApp({ searchSessions: store(dead) });
    const started = performance.now();
    const res = await request(app)
      .post('/api/v1/search/flights')
      .set('Origin', ORIGIN)
      .send(flightsBody);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Search is temporarily unavailable. Please try again in a moment.',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/redis|127\.0\.0\.1|ECONNREFUSED|Stream/i);
    expect(performance.now() - started).toBeLessThan(2_500);
  });
});
