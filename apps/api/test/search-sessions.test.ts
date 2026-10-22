import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { offerResponseSchema } from '@wayora/contracts';
import { ProviderRegistry } from '../src/modules/providers/registry.js';
import { SearchService } from '../src/modules/search/search.service.js';
import {
  MemorySearchSessionStore,
  RedisSearchSessionStore,
  SessionStoreUnavailableError,
  deserializeSession,
  serializeSession,
  type SearchSession,
} from '../src/modules/search/sessions.js';
import { AppError } from '../src/utils/errors.js';
import { FakeRedis, captureLogs } from './fake-redis.js';
import { buildTestApp } from './helpers.js';
import {
  NO_RETRY,
  VALID_INPUTS,
  hotelResult,
  hotelsRequest,
  silentLogger,
  stubProvider,
} from './search-support.js';

const T0 = Date.parse('2026-10-22T08:00:00Z');
const ORIGIN = 'http://localhost:5173';

/** A clock both the fake Redis and the service read, so expiry is deterministic. */
function clock() {
  let at = T0;
  return {
    now: () => new Date(at),
    ms: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

function session(overrides: Partial<SearchSession> = {}): SearchSession {
  return {
    searchId: '01890000-0000-7000-8000-0000000000aa',
    serviceType: 'hotels',
    results: [hotelResult('p1', 'a', 5000), hotelResult('p1', 'b', 3000)].map(
      ({ dedupeKey: _d, ...r }) => r,
    ),
    providerStatuses: [
      {
        providerId: 'p1',
        providerName: 'Stub p1',
        kind: 'demo',
        status: 'success',
        resultCount: 2,
        durationMs: 3,
        message: null,
      },
    ],
    warnings: [],
    generatedAt: new Date(T0),
    expiresAt: new Date(T0 + 600_000),
    ...overrides,
  };
}

/** One "API instance": a SearchService over a shared Redis, like a separate process. */
function instance(redis: FakeRedis, time: ReturnType<typeof clock>, providers = [okHotels()]) {
  const registry = new ProviderRegistry({ demoEnabled: true });
  for (const p of providers) registry.register(p);
  const logs = captureLogs();
  const logger = pino({ level: 'info' }, logs.stream);
  return {
    logs,
    service: new SearchService({
      registry,
      logger,
      sessions: new RedisSearchSessionStore(redis, logger, { now: time.now }),
      now: time.now,
      sessionTtlMs: 600_000,
      resilience: NO_RETRY,
    }),
  };
}

const okHotels = () =>
  stubProvider('p1', {
    kind: 'results',
    results: [hotelResult('p1', 'a', 5000), hotelResult('p1', 'b', 3000)],
  });

describe('Redis search sessions', () => {
  it('stores a session under wayora:search:<searchId> with the session lifetime as TTL, and nothing about the request', async () => {
    const time = clock();
    const redis = new FakeRedis(time.ms);
    const { service } = instance(redis, time);
    const response = await service.search(hotelsRequest());

    const sessionKey = `wayora:search:${response.searchId}`;
    expect(redis.raw(sessionKey)).toBeDefined();
    const reuseKeys = [...redis.data.keys()].filter((k) => k.startsWith('wayora:search:reuse:'));
    expect(reuseKeys).toHaveLength(1);
    expect(redis.raw(reuseKeys[0]!)).toBe(response.searchId);
    // Both keys expire with the session (10 minutes from generation).
    expect(redis.sets.map(([, px]) => px)).toEqual([600_000, 600_000]);
    expect(response.expiresAt).toBe(new Date(T0 + 600_000).toISOString());

    const stored = JSON.parse(redis.raw(sessionKey)!) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual([
      'expiresAt',
      'generatedAt',
      'providerStatuses',
      'results',
      'searchId',
      'serviceType',
      'v',
      'warnings',
    ]);
    // No request data (the party, the place searched for) and no dedupe internals
    // are kept: only the offers, which carry their own details (e.g. a stay's dates).
    expect(redis.raw(sessionKey)).not.toMatch(/"adults"|"children"|"destination"|"dedupeKey"/);
  });

  it('survives an API restart and is shared by every instance using the same Redis', async () => {
    const time = clock();
    const redis = new FakeRedis(time.ms);
    const a = instance(redis, time);
    const first = await a.service.search(hotelsRequest());

    // A brand-new process: new service, new store object, same Redis.
    const bProvider = okHotels();
    const b = instance(redis, time, [bProvider]);
    const offer = await b.service.offer('hotels', first.searchId, 'p1:a');
    expect(offerResponseSchema.parse(offer).result.price).toEqual(first.results[1]!.price);
    const again = await b.service.search(hotelsRequest({ sortBy: 'price-desc' }));
    expect(again.searchId).toBe(first.searchId); // reused, not re-queried
    expect(bProvider.calls).toBe(0);
  });

  it('expires with its TTL: offers then answer SEARCH_EXPIRED and a new search re-queries', async () => {
    const time = clock();
    const redis = new FakeRedis(time.ms);
    const provider = okHotels();
    const { service } = instance(redis, time, [provider]);
    const first = await service.search(hotelsRequest());
    time.advance(599_000);
    await expect(service.offer('hotels', first.searchId, 'p1:a')).resolves.toBeDefined();
    time.advance(1_000);
    await expect(service.offer('hotels', first.searchId, 'p1:a')).rejects.toMatchObject({
      code: 'SEARCH_EXPIRED',
      status: 410,
    });
    const second = await service.search(hotelsRequest());
    expect(second.searchId).not.toBe(first.searchId);
    expect(provider.calls).toBe(2);
  });

  it('missing sessions are SEARCH_EXPIRED', async () => {
    const time = clock();
    const { service } = instance(new FakeRedis(time.ms), time);
    await expect(
      service.offer('hotels', '01890000-0000-7000-8000-000000000999', 'p1:a'),
    ).rejects.toMatchObject({ code: 'SEARCH_EXPIRED' });
  });

  it('concurrent searches get unique ids and stay separately readable', async () => {
    const time = clock();
    const redis = new FakeRedis(time.ms);
    const { service } = instance(redis, time);
    const responses = await Promise.all(
      [1, 2, 3, 4].flatMap((adults) =>
        [0, 1].map((children) => service.search(hotelsRequest({ adults, children, rooms: 1 }))),
      ),
    );
    const ids = responses.map((r) => r.searchId);
    expect(new Set(ids).size).toBe(8);
    for (const id of ids) {
      expect((await service.offer('hotels', id, 'p1:b')).searchId).toBe(id);
    }
  });

  it('discards malformed or tampered sessions (bad JSON, wrong shape, mixed currency, forged id) and logs it', async () => {
    const time = clock();
    const redis = new FakeRedis(time.ms);
    const { service, logs } = instance(redis, time);
    const tamperings: [string, (json: Record<string, unknown>) => unknown][] = [
      ['not json', () => '{"v":1,'],
      ['wrong version', (j) => ({ ...j, v: 2 })],
      ['missing results', (j) => ({ ...j, results: undefined })],
      [
        'mixed-currency price',
        (j) => {
          const [first, ...rest] = j.results as Record<string, unknown>[];
          const price = first!.price as { perUnit: { amount: { currency: string } } };
          price.perUnit.amount.currency = 'USD';
          return { ...j, results: [first, ...rest] };
        },
      ],
      [
        'forged id',
        (j) => {
          const [first, ...rest] = j.results as Record<string, unknown>[];
          return { ...j, results: [{ ...first, id: 'p1:something-else' }, ...rest] };
        },
      ],
      ['other search id', (j) => ({ ...j, searchId: '01890000-0000-7000-8000-0000000000ff' })],
    ];
    for (const [label, tamper] of tamperings) {
      const { searchId } = await service.search(hotelsRequest({ adults: 3, rooms: 1 }));
      const key = `wayora:search:${searchId}`;
      const json = JSON.parse(redis.raw(key)!) as Record<string, unknown>;
      const tampered = tamper(json);
      redis.write(key, typeof tampered === 'string' ? tampered : JSON.stringify(tampered));
      await expect(service.offer('hotels', searchId, 'p1:b'), label).rejects.toMatchObject({
        code: 'SEARCH_EXPIRED',
      });
      expect(redis.raw(key), label).toBeUndefined(); // deleted, not served again
      // The reuse pointer now leads nowhere, so the next search re-queries.
    }
    expect(logs.text).toMatch(/Discarded a malformed search session/);
  });

  it('Redis unavailable: a 503 with Wayora wording, never in-memory fallback or Redis details', async () => {
    const time = clock();
    const redis = new FakeRedis(time.ms);
    const provider = okHotels();
    const { service, logs } = instance(redis, time, [provider]);
    const first = await service.search(hotelsRequest());

    redis.down = true;
    for (const attempt of [
      () => service.search(hotelsRequest()),
      () => service.search(hotelsRequest({ adults: 4, rooms: 2 })),
      () => service.offer('hotels', first.searchId, 'p1:a'),
    ]) {
      const error = (await attempt().catch((e: unknown) => e)) as AppError;
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', status: 503 });
      expect(error.message).toBe(
        'Search is temporarily unavailable. Please try again in a moment.',
      );
      expect(error.message).not.toMatch(/redis|ECONNREFUSED|10\.1\.2\.3/i);
    }
    // Store checked before providers, so a dead store doesn't cost supplier calls.
    expect(provider.calls).toBe(1);
    expect(logs.text).toMatch(/Search session store unavailable/);
    expect(logs.text).not.toContain('hunter2'); // scrubbed even in logs

    redis.down = false;
    await expect(service.offer('hotels', first.searchId, 'p1:a')).resolves.toBeDefined();
  });

  it('a failed write after a successful provider round is a 503, not a session nobody can read', async () => {
    const time = clock();
    const redis = new FakeRedis(time.ms);
    const { service } = instance(redis, time);
    const original = redis.multi.bind(redis);
    redis.multi = () => {
      const tx = original();
      return {
        set: tx.set,
        exec: async () => [[new Error('OOM command not allowed'), null] as [Error, null]],
      };
    };
    await expect(service.search(hotelsRequest())).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('store errors are typed (SessionStoreUnavailableError) and serialization round-trips', async () => {
    const time = clock();
    const redis = new FakeRedis(time.ms);
    const store = new RedisSearchSessionStore(redis, silentLogger, { now: time.now });
    redis.down = true;
    await expect(store.get('x')).rejects.toBeInstanceOf(SessionStoreUnavailableError);
    const s = session();
    expect(deserializeSession(serializeSession(s))).toEqual(s);
    expect(deserializeSession('null')).toBeNull();
  });

  it('never writes an already-expired session, and guards against clock skew on read', async () => {
    const time = clock();
    const redis = new FakeRedis(time.ms);
    const store = new RedisSearchSessionStore(redis, silentLogger, { now: time.now });
    await store.save(session({ expiresAt: new Date(T0 - 1) }), { requestKey: 'k', reusable: true });
    expect(redis.data.size).toBe(0);
    // Another instance with a fast clock wrote a session that is already past
    // its expiresAt for this instance.
    redis.write(
      'wayora:search:01890000-0000-7000-8000-0000000000aa',
      serializeSession(session({ expiresAt: new Date(T0 - 1_000) })),
    );
    await expect(store.get('01890000-0000-7000-8000-0000000000aa')).resolves.toBeUndefined();
  });
});

describe('memory search sessions (local development and tests)', () => {
  it('expire by time and evict the least recently used beyond the limit', async () => {
    const time = clock();
    const store = new MemorySearchSessionStore(2, time.now);
    const ids = ['a', 'b', 'c'].map((c) => `01890000-0000-7000-8000-0000000000${c}${c}`);
    for (const searchId of ids) {
      await store.save(session({ searchId }), { requestKey: searchId, reusable: true });
    }
    expect(await store.get(ids[0]!)).toBeUndefined(); // evicted
    expect(store.size).toBe(2);
    time.advance(600_000);
    expect(await store.get(ids[2]!)).toBeUndefined();
    expect(await store.findReusable(ids[2]!)).toBeUndefined();
  });
});

describe('search sessions through the API', () => {
  it('an offer page served by a different API instance (shared Redis) shows the same offer', async () => {
    const redis = new FakeRedis();
    const app = () =>
      buildTestApp({ searchSessions: new RedisSearchSessionStore(redis, silentLogger) });
    const { serviceType: _t, ...body } = VALID_INPUTS.flights;
    const search = await request(app())
      .post('/api/v1/search/flights')
      .set('Origin', ORIGIN)
      .send(body);
    expect(search.status).toBe(200);
    const { searchId, results } = search.body.data;
    const offer = await request(app()).get(
      `/api/v1/search/flights/sessions/${searchId}/offer?id=${encodeURIComponent(results[0].id)}`,
    );
    expect(offer.status).toBe(200);
    expect(offer.body.data.result).toEqual(results[0]);
  });

  it('Redis down: the API answers 503 SERVICE_UNAVAILABLE without internals', async () => {
    const redis = new FakeRedis();
    redis.down = true;
    const app = buildTestApp({ searchSessions: new RedisSearchSessionStore(redis, silentLogger) });
    const { serviceType: _t, ...body } = VALID_INPUTS.hotels;
    const res = await request(app).post('/api/v1/search/hotels').set('Origin', ORIGIN).send(body);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/redis|ECONNREFUSED|hunter2|10\.1\.2\.3/i);
  });
});
