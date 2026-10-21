import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  providerInfoListSchema,
  searchResponseSchema,
  type SearchServiceType,
  offerResponseSchema,
} from '@wayora/contracts';
import { parseEnv } from '../src/config/env.js';
import { buildTestApp, validEnvSource } from './helpers.js';
import { VALID_INPUTS, hotelResult, stubProvider, unavailable } from './search-support.js';

const ORIGIN = 'http://localhost:5173';
const post = (app: ReturnType<typeof buildTestApp>, type: string, body: unknown) =>
  request(app)
    .post(`/api/v1/search/${type}`)
    .set('Origin', ORIGIN)
    .send(body as object);

/** The request body without the discriminator: the path names the category. */
const bodyFor = (type: SearchServiceType) => {
  const { serviceType: _type, ...body } = VALID_INPUTS[type];
  return body;
};

describe('POST /api/v1/search/:serviceType', () => {
  it.each(Object.keys(VALID_INPUTS) as SearchServiceType[])(
    '%s: returns normalized demo results',
    async (type) => {
      const res = await post(buildTestApp(), type, bodyFor(type));
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const data = searchResponseSchema.parse(res.body.data);
      expect(data.serviceType).toBe(type);
      expect(data.results.length).toBeGreaterThan(0);
      expect(data.results.every((r) => r.serviceType === type && r.source === 'demo')).toBe(true);
      expect(data.dataSource).toBe('demo');
      expect(data.disclaimer).toMatch(/^Demo data/);
      expect(data.providerStatuses).toEqual([
        expect.objectContaining({ providerId: `demo-${type}`, status: 'success' }),
      ]);
      expect(res.body.meta.requestId).toEqual(expect.any(String));
    },
  );

  it('accepts a matching serviceType in the body and rejects a mismatched one', async () => {
    const app = buildTestApp();
    expect((await post(app, 'hotels', VALID_INPUTS.hotels)).status).toBe(200);
    const res = await post(app, 'hotels', { ...VALID_INPUTS.flights });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([
      expect.objectContaining({
        path: 'body.serviceType',
        message: 'This endpoint searches hotels.',
      }),
    ]);
  });

  it('404s for unknown categories', async () => {
    const res = await post(buildTestApp(), 'ferries', {});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('400s with field details for invalid requests, before any provider runs', async () => {
    const provider = stubProvider('counting', { kind: 'results', results: [] });
    const app = buildTestApp({ searchProviders: [provider] });
    const res = await post(app, 'hotels', {
      destination: 'city:atlantis',
      checkIn: 'soon',
      adults: 0,
      extra: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(
      expect.arrayContaining(['body.checkIn', 'body.checkOut', 'body.adults', 'body']),
    );
    expect(provider.calls).toBe(0);
    expect((await post(app, 'hotels', [1, 2])).status).toBe(400);
  });

  it('returns partial results with provider statuses when some providers fail', async () => {
    const app = buildTestApp({
      searchProviders: [
        stubProvider('good', { kind: 'results', results: [hotelResult('good', 'a', 5000)] }),
        stubProvider('down', { kind: 'throw', error: unavailable }),
      ],
    });
    const res = await post(app, 'hotels', bodyFor('hotels'));
    expect(res.status).toBe(200);
    expect(res.body.data.providerStatuses.map((s: { status: string }) => s.status)).toEqual([
      'success',
      'unavailable',
    ]);
    expect(res.body.data.warnings.map((w: { code: string }) => w.code)).toContain(
      'PARTIAL_RESULTS',
    );
  });

  it('503s with a safe message when every provider fails', async () => {
    const app = buildTestApp({
      searchProviders: [
        stubProvider('boom', { kind: 'throw', error: new Error('secret internal detail') }),
      ],
    });
    const res = await post(app, 'hotels', bodyFor('hotels'));
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringMatching(/couldn't search hotels/),
    });
    expect(JSON.stringify(res.body)).not.toContain('secret internal detail');
  });

  it('demo providers are off in production unless explicitly enabled', async () => {
    const prod = { NODE_ENV: 'production' as const, CORS_ORIGIN: ['https://wayora.example'] };
    const off = buildTestApp({ env: prod });
    const res = await request(off)
      .post('/api/v1/search/hotels')
      .set('Origin', 'https://wayora.example')
      .send(bodyFor('hotels'));
    expect(res.status).toBe(503);
    expect(res.body.error.message).toBe("Hotels search isn't available right now.");
    const on = buildTestApp({ env: { ...prod, SEARCH_DEMO_PROVIDERS: 'true' } });
    expect(
      (
        await request(on)
          .post('/api/v1/search/hotels')
          .set('Origin', 'https://wayora.example')
          .send(bodyFor('hotels'))
      ).status,
    ).toBe(200);
  });

  it('honours SEARCH_DISABLED_PROVIDERS', async () => {
    const app = buildTestApp({ env: { SEARCH_DISABLED_PROVIDERS: ['demo-cabs'] } });
    expect((await post(app, 'cabs', bodyFor('cabs'))).status).toBe(503);
    expect((await post(app, 'hotels', bodyFor('hotels'))).status).toBe(200);
  });

  it('rate-limits searches per client', async () => {
    const app = buildTestApp({ env: { SEARCH_RATE_LIMIT_MAX: 2 } });
    expect((await post(app, 'metro', bodyFor('metro'))).status).toBe(200);
    expect((await post(app, 'metro', bodyFor('metro'))).status).toBe(200);
    const limited = await post(app, 'metro', bodyFor('metro'));
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('refuses cross-site requests (CSRF Origin check applies to search too)', async () => {
    const res = await request(buildTestApp())
      .post('/api/v1/search/metro')
      .set('Origin', 'https://evil.example')
      .send(bodyFor('metro'));
    expect(res.status).toBe(403);
  });

  it('applies sort, filters and pagination from the request', async () => {
    const res = await post(buildTestApp(), 'trains', {
      ...bodyFor('trains'),
      sortBy: 'price-asc',
      filters: { classes: ['CC', 'EC'] },
      pageSize: 2,
    });
    expect(res.status).toBe(200);
    const data = searchResponseSchema.parse(res.body.data);
    expect(data.results.map((r) => r.serviceType === 'trains' && r.travelClass.code)).toEqual([
      'CC',
      'CC',
    ]);
    expect(data.pagination).toMatchObject({ pageSize: 2, totalResults: 3, totalPages: 2 });
  });

  it('warns that prices are not converted when another currency is requested', async () => {
    const res = await post(buildTestApp(), 'holidays', { ...bodyFor('holidays'), currency: 'USD' });
    const codes = res.body.data.warnings.map((w: { code: string }) => w.code);
    expect(codes).toContain('CURRENCY_NOT_CONVERTED');
    expect(res.body.data.results[0].price.total.currency).toBe('INR');
  });

  it('keeps the same searchId while paging within the cache lifetime', async () => {
    const app = buildTestApp();
    const a = await post(app, 'flights', bodyFor('flights'));
    const b = await post(app, 'flights', { ...bodyFor('flights'), page: 2, pageSize: 2 });
    expect(b.body.data.searchId).toBe(a.body.data.searchId);
  });
});

describe('GET /api/v1/providers', () => {
  it('lists provider capabilities without secrets', async () => {
    const res = await request(buildTestApp()).get('/api/v1/providers');
    expect(res.status).toBe(200);
    const list = providerInfoListSchema.parse(res.body.data);
    expect(list).toHaveLength(7);
    expect(list[0]).toEqual({
      id: 'demo-flights',
      name: 'Wayora demo flights',
      kind: 'demo',
      serviceTypes: ['flights'],
      operations: { search: 'supported', revalidate: 'unsupported', book: 'unsupported' },
      enabled: true,
      disabledReason: null,
      timeoutMs: 2000,
    });
  });
});

describe('search environment', () => {
  it('validates and defaults search settings', () => {
    const env = parseEnv(validEnvSource);
    expect(env).toMatchObject({
      SEARCH_RATE_LIMIT_MAX: 30,
      SEARCH_CACHE_TTL_SECONDS: 600,
      SEARCH_DISABLED_PROVIDERS: [],
    });
    expect(env.SEARCH_DEMO_PROVIDERS).toBeUndefined();
    expect(
      parseEnv({ ...validEnvSource, SEARCH_DISABLED_PROVIDERS: ' demo-cabs , demo-metro ' })
        .SEARCH_DISABLED_PROVIDERS,
    ).toEqual(['demo-cabs', 'demo-metro']);
    expect(() => parseEnv({ ...validEnvSource, SEARCH_DEMO_PROVIDERS: 'yes' })).toThrow(
      /SEARCH_DEMO_PROVIDERS/,
    );
  });
});

describe('GET /api/v1/search/:serviceType/sessions/:searchId/offer', () => {
  const offerPath = (type: string, searchId: string, id: string) =>
    `/api/v1/search/${type}/sessions/${searchId}/offer?id=${encodeURIComponent(id)}`;

  it("returns one result from the server's copy of the search, with its expiry", async () => {
    const app = buildTestApp();
    const search = await post(app, 'flights', bodyFor('flights'));
    const { searchId, results, expiresAt } = search.body.data;
    const chosen = results[1];

    const res = await request(app).get(offerPath('flights', searchId, chosen.id));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(offerResponseSchema.parse(res.body.data)).toEqual(res.body.data);
    expect(res.body.data).toMatchObject({ searchId, serviceType: 'flights', expiresAt });
    expect(res.body.data.result).toEqual(chosen);
    expect(res.body.data.disclaimer).toMatch(/^Demo data/);
  });

  it('finds results beyond the page and filters the client was looking at', async () => {
    const app = buildTestApp();
    const all = await post(app, 'trains', { ...bodyFor('trains'), pageSize: 50 });
    const firstPage = await post(app, 'trains', { ...bodyFor('trains'), pageSize: 1 });
    expect(firstPage.body.data.searchId).toBe(all.body.data.searchId); // same session
    const last = all.body.data.results.at(-1);
    const res = await request(app).get(offerPath('trains', all.body.data.searchId, last.id));
    expect(res.body.data.result.id).toBe(last.id);
  });

  it('404s for unknown or expired searches, unknown offers and the wrong category', async () => {
    let now = new Date();
    const app = buildTestApp({ now: () => now, env: { SEARCH_CACHE_TTL_SECONDS: 60 } });
    const search = await post(app, 'hotels', bodyFor('hotels'));
    const { searchId, results } = search.body.data;
    const id = results[0].id as string;

    const wrongType = await request(app).get(offerPath('flights', searchId, id));
    expect(wrongType.status).toBe(404);
    const unknownOffer = await request(app).get(offerPath('hotels', searchId, 'demo-hotels:nope'));
    expect(unknownOffer.status).toBe(404);
    expect(unknownOffer.body.error.message).toBe("That offer isn't part of this search.");
    const unknownSearch = await request(app).get(
      offerPath('hotels', '01890000-0000-7000-8000-000000000000', id),
    );
    expect(unknownSearch.status).toBe(404);
    expect(unknownSearch.body.error.message).toMatch(/expired/);

    now = new Date(now.getTime() + 61_000);
    const expired = await request(app).get(offerPath('hotels', searchId, id));
    expect(expired.status).toBe(404);
    expect(expired.body.error.message).toMatch(/expired/);
  });

  it('validates the category, search id and offer id', async () => {
    const app = buildTestApp();
    const id = '01890000-0000-7000-8000-000000000000';
    expect((await request(app).get(offerPath('rockets', id, 'x'))).status).toBe(400);
    expect((await request(app).get(offerPath('hotels', 'not-a-uuid', 'x'))).status).toBe(400);
    expect((await request(app).get(`/api/v1/search/hotels/sessions/${id}/offer`)).status).toBe(400);
    expect((await request(app).get(offerPath('hotels', id, 'x'.repeat(201)))).status).toBe(400);
    expect((await request(app).get(offerPath('hotels', id, 'has space'))).status).toBe(400);
  });

  it('keeps partial searches readable but does not reuse them', async () => {
    const failing = stubProvider('down', { kind: 'throw', error: unavailable });
    const good = stubProvider('good', {
      kind: 'results',
      results: [hotelResult('good', 'r1', 4000)],
    });
    const app = buildTestApp({ searchProviders: [good, failing] });
    const first = await post(app, 'hotels', bodyFor('hotels'));
    const res = await request(app).get(offerPath('hotels', first.body.data.searchId, 'good:r1'));
    expect(res.status).toBe(200);
    const again = await post(app, 'hotels', bodyFor('hotels'));
    expect(again.body.data.searchId).not.toBe(first.body.data.searchId); // re-queried, not reused
    expect(good.calls).toBe(2);
  });

  it('is not counted against the search rate limit', async () => {
    const app = buildTestApp({ env: { SEARCH_RATE_LIMIT_MAX: 1 } });
    const search = await post(app, 'hotels', bodyFor('hotels'));
    const { searchId, results } = search.body.data;
    for (let i = 0; i < 3; i += 1) {
      expect((await request(app).get(offerPath('hotels', searchId, results[0].id))).status).toBe(
        200,
      );
    }
    expect((await post(app, 'hotels', bodyFor('hotels'))).status).toBe(429);
  });

  it('returns facets with every search, from the unfiltered results', async () => {
    const app = buildTestApp();
    const all = await post(app, 'flights', bodyFor('flights'));
    const nonstop = await post(app, 'flights', { ...bodyFor('flights'), filters: { maxStops: 0 } });
    expect(nonstop.body.data.pagination.totalResults).toBeLessThan(
      all.body.data.pagination.totalResults,
    );
    expect(nonstop.body.data.facets).toEqual(all.body.data.facets);
    expect(all.body.data.facets.options.carriers.length).toBeGreaterThan(0);
  });
});
