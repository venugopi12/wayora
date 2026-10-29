import { inspect } from 'node:util';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  offerResponseSchema,
  providerInfoListSchema,
  searchResponseSchema,
} from '@wayora/contracts';
import { ProviderSecret, readProviderConfig } from '../src/modules/providers/credentials.js';
import { DEMO_PROVIDERS } from '../src/modules/providers/demo/index.js';
import { ProviderHttpClient } from '../src/modules/providers/http.js';
import { createLiveProviders } from '../src/modules/providers/live/index.js';
import { currencyDigits, supplierMoney } from '../src/modules/providers/normalize.js';
import { ProviderError } from '../src/modules/providers/provider.js';
import { captureLogs } from './fake-redis.js';
import {
  FIXTURE_CONFIG,
  FixtureSupplierServer,
  createFixtureAirProvider,
  fixtureOffer,
} from './fixture-supplier.js';
import { buildTestApp } from './helpers.js';
import { NO_RETRY, VALID_INPUTS } from './search-support.js';

/*
 * Live provider readiness (Phase 22, docs/providers.md): the HTTP toolkit,
 * supplier configuration, money normalization, and a test-only live
 * supplier (fixture-supplier.ts) through search, offer checks, failures,
 * retries and labels. Deterministic fakes only; no credentials.
 */

const ORIGIN = 'http://localhost:5173';
const KEY = FIXTURE_CONFIG.FIXTURE_AIR_API_KEY;
const { serviceType: _t, ...flightsBody } = VALID_INPUTS.flights;

/** The ProviderError a request fails with (the test fails if it succeeds). */
async function failure(pending: Promise<unknown>): Promise<ProviderError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error('expected the request to fail');
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('ProviderHttpClient', () => {
  const client = (fetchImpl: typeof fetch) =>
    new ProviderHttpClient({ providerId: 'acme', fetch: fetchImpl });
  const signal = () => new AbortController().signal;

  it('maps the request: method, query, JSON body, headers; no redirects followed', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true }));
    const res = await client(fetchImpl as unknown as typeof fetch).requestJson({
      method: 'POST',
      url: 'https://supplier.test/v2/offers',
      query: { from: 'BLR', adults: 2, skip: undefined },
      headers: { authorization: 'Bearer s3cret' },
      body: { a: 1 },
      signal: signal(),
    });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('https://supplier.test/v2/offers?from=BLR&adults=2');
    expect(init).toMatchObject({ method: 'POST', body: '{"a":1}', redirect: 'error' });
    expect(init.headers).toMatchObject({
      authorization: 'Bearer s3cret',
      accept: 'application/json',
      'content-type': 'application/json',
    });
  });

  it('maps statuses to safe, correctly classified errors without reading bodies', async () => {
    const cases: [number, ProviderError['kind'], boolean][] = [
      [401, 'error', false],
      [403, 'error', false],
      [400, 'error', false],
      [404, 'error', false],
      [422, 'error', false],
      [408, 'unavailable', true],
      [425, 'unavailable', true],
      [429, 'unavailable', true],
      [500, 'unavailable', true],
      [502, 'unavailable', true],
      [503, 'unavailable', true],
      [504, 'unavailable', true],
      [599, 'unavailable', true],
    ];
    for (const [status, kind, transient] of cases) {
      const fetchImpl = vi.fn(async () => new Response(`echo key=${KEY} detail`, { status }));
      const error = await failure(
        client(fetchImpl as unknown as typeof fetch).requestJson({
          url: `https://supplier.test/v1/x?apiKey=${KEY}`,
          signal: signal(),
        }),
      );
      expect([error.kind, error.transient], String(status)).toEqual([kind, transient]);
      expect(error.message).toContain('acme: GET /v1/x');
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain('echo');
    }
    const accepted = await client(
      (async () => new Response('gone', { status: 404 })) as unknown as typeof fetch,
    ).requestJson({
      url: 'https://supplier.test/v1/x',
      signal: signal(),
      acceptStatuses: [404],
    });
    expect(accepted).toEqual({ status: 404, body: null });
  });

  it('refuses non-JSON, malformed, oversized and cut-off answers; network errors are transient', async () => {
    const run = (response: Response | (() => Promise<Response>), maxBytes?: number) =>
      failure(
        client(
          (typeof response === 'function'
            ? response
            : async () => response) as unknown as typeof fetch,
        ).requestJson({
          url: 'https://supplier.test/v1/x',
          signal: signal(),
          ...(maxBytes ? { maxBytes } : {}),
        }),
      );
    expect(
      await run(new Response('<html/>', { headers: { 'content-type': 'text/html' } })),
    ).toMatchObject({ kind: 'error' });
    expect(
      await run(new Response('{"a":', { headers: { 'content-type': 'application/json' } })),
    ).toMatchObject({ kind: 'error' });
    expect(await run(json({ big: 'x'.repeat(200) }), 50)).toMatchObject({ kind: 'error' });
    expect(await run(json({ a: 1 }, 200, { 'content-length': '999999999' }), 1000)).toMatchObject({
      kind: 'error',
    });
    const offline = await run(async () => {
      throw new TypeError('fetch failed');
    });
    expect(offline).toMatchObject({ kind: 'unavailable', transient: true });
    expect(offline.message).toBe('acme: GET /v1/x could not be reached');
  });

  it('stops when the attempt is aborted', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          }),
        ),
    );
    const pending = client(fetchImpl as unknown as typeof fetch).requestJson({
      url: 'https://supplier.test/v1/x',
      signal: controller.signal,
    });
    controller.abort(new Error('time limit'));
    await expect(pending).rejects.toThrow('time limit');
  });
});

describe('supplier configuration', () => {
  const spec = { plain: ['ACME_BASE_URL'] as const, secret: ['ACME_API_KEY'] as const };

  it('is null (provider stays disabled) when anything is missing, blank or unsafe', () => {
    expect(readProviderConfig(spec, {})).toBeNull();
    expect(
      readProviderConfig(spec, { ACME_BASE_URL: 'https://a.test', ACME_API_KEY: '  ' }),
    ).toBeNull();
    expect(readProviderConfig(spec, { ACME_BASE_URL: 'not a url', ACME_API_KEY: 'k' })).toBeNull();
    expect(
      readProviderConfig(spec, { ACME_BASE_URL: 'https://u:p@a.test', ACME_API_KEY: 'k' }),
    ).toBeNull();
    expect(
      readProviderConfig(spec, { ACME_BASE_URL: 'ftp://a.test', ACME_API_KEY: 'k' }),
    ).toBeNull();
    expect(
      readProviderConfig(
        spec,
        { ACME_BASE_URL: 'http://a.test', ACME_API_KEY: 'k' },
        { requireHttps: true },
      ),
    ).toBeNull();
  });

  it('keeps secrets out of JSON, strings and inspection', () => {
    const config = readProviderConfig(spec, {
      ACME_BASE_URL: ' https://a.test ',
      ACME_API_KEY: KEY,
    })!;
    expect(config.ACME_BASE_URL).toBe('https://a.test');
    expect(config.ACME_API_KEY.reveal()).toBe(KEY);
    expect(JSON.stringify(config)).not.toContain(KEY);
    expect(String(config.ACME_API_KEY)).toBe('[redacted]');
    expect(inspect(config)).not.toContain(KEY);
    expect(`${new ProviderSecret('x')}`).toBe('[redacted]');
  });
});

describe('money normalization', () => {
  it('converts supplier amounts exactly, by currency digits, or refuses them', () => {
    expect(currencyDigits('INR')).toBe(2);
    expect(currencyDigits('JPY')).toBe(0);
    expect(currencyDigits('KWD')).toBe(3);
    expect(currencyDigits('XXQ')).toBeNull();
    expect(supplierMoney('4520.50', 'INR')).toEqual({ amountMinor: '452050', currency: 'INR' });
    expect(supplierMoney('4520.5', 'inr')).toEqual({ amountMinor: '452050', currency: 'INR' });
    expect(supplierMoney('0.10', 'USD')).toEqual({ amountMinor: '10', currency: 'USD' });
    expect(supplierMoney('12500', 'JPY')).toEqual({ amountMinor: '12500', currency: 'JPY' });
    expect(supplierMoney('1.234', 'KWD')).toEqual({ amountMinor: '1234', currency: 'KWD' });
    expect(supplierMoney('12.500', 'USD')).toEqual({ amountMinor: '1250', currency: 'USD' });
    expect(supplierMoney(4520, 'INR')).toEqual({ amountMinor: '452000', currency: 'INR' });
    // Never rounded or guessed:
    expect(supplierMoney('12.345', 'USD')).toBeNull();
    expect(supplierMoney(45.2, 'INR')).toBeNull();
    expect(supplierMoney('1e3', 'INR')).toBeNull();
    expect(supplierMoney('-5', 'INR')).toBeNull();
    expect(supplierMoney('5', 'RUPEES')).toBeNull();
    expect(supplierMoney('5', undefined)).toBeNull();
  });
});

describe('no live supplier is integrated', () => {
  it('registers demo providers only, and says so', async () => {
    expect(createLiveProviders({ ANY: 'value' })).toEqual([]);
    const app = buildTestApp();
    const providers = providerInfoListSchema.parse(
      (await request(app).get('/api/v1/providers')).body.data,
    );
    expect(providers.map((p) => p.id).sort()).toEqual(DEMO_PROVIDERS.map((p) => p.id).sort());
    expect(providers.every((p) => p.kind === 'demo' && p.operations.book === 'unsupported')).toBe(
      true,
    );
  });
});

describe('a live supplier through search (test-only fixture supplier)', () => {
  function setup(
    options: { config?: Record<string, string>; demo?: boolean; resilience?: object } = {},
  ) {
    const server = new FixtureSupplierServer();
    const logs = captureLogs();
    const source = options.config ?? FIXTURE_CONFIG;
    const app = buildTestApp({
      env: { SEARCH_DEMO_PROVIDERS: options.demo ? 'true' : 'false' },
      searchProviders: [
        createFixtureAirProvider(source, { fetch: server.fetch }),
        ...DEMO_PROVIDERS,
      ],
      providerConfig: source,
      searchResilience: { ...NO_RETRY, ...options.resilience },
      logger: pino({ level: 'info' }, logs.stream),
    });
    const search = () =>
      request(app)
        .post('/api/v1/search/flights')
        .set('Origin', ORIGIN)
        .set('X-Request-Id', 'req-live-1')
        .send(flightsBody);
    return { app, server, logs, search };
  }

  it('stays disabled until configured, and never calls the supplier', async () => {
    const { app, server, search } = setup({ config: {} });
    const providers = providerInfoListSchema.parse(
      (await request(app).get('/api/v1/providers')).body.data,
    );
    expect(providers.find((p) => p.id === 'fixture-air')).toMatchObject({
      enabled: false,
      disabledReason: 'Not configured.',
      kind: 'live',
    });
    const res = await search();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(server.calls).toHaveLength(0);
  });

  it('treats a blank setting as missing', async () => {
    const { app, server, search } = setup({
      config: { ...FIXTURE_CONFIG, FIXTURE_AIR_API_KEY: '   ' },
    });
    const providers = providerInfoListSchema.parse(
      (await request(app).get('/api/v1/providers')).body.data,
    );
    expect(providers.find((p) => p.id === 'fixture-air')?.enabled).toBe(false);
    expect((await search()).status).toBe(503);
    expect(server.calls).toHaveLength(0);
  });

  it('maps the request and normalizes the answer, labelled live, never demo', async () => {
    const { server, search, logs } = setup();
    const res = await search();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const call = server.calls[0]!;
    expect(call.url.pathname).toBe('/api/v1/flight-offers');
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      from: 'BLR',
      to: 'DEL',
      date: VALID_INPUTS.flights.departureDate,
      adults: '1',
      children: '0',
      infants: '0',
      cabin: 'economy',
    });
    expect(call.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    const body = searchResponseSchema.parse(res.body.data);
    expect(body.dataSource).toBe('live');
    expect(body.disclaimer).toBeNull();
    expect(body.warnings.map((w) => w.code)).not.toContain('DEMO_DATA');
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      id: 'fixture-air:FA-1001',
      source: 'live',
      offerRef: 'FA-1001',
      validUntil: '2030-01-01T00:00:00Z',
      price: { kind: 'total', total: { amountMinor: '452050', currency: 'INR' } },
      fare: {
        name: 'Saver',
        refundable: false,
        changeable: true,
        checkedBaggage: { pieces: null, weightKg: 15 },
        cabinBaggage: { pieces: null, weightKg: 7 },
      },
    });
    expect(body.providerStatuses).toEqual([
      expect.objectContaining({ providerId: 'fixture-air', kind: 'live', status: 'success' }),
    ]);
    // One log line per provider call: outcome, duration, attempts, correlated by request id.
    const line = logs.entries().find((e) => e.msg === 'Provider call finished');
    expect(line).toMatchObject({
      requestId: 'req-live-1',
      provider: {
        providerId: 'fixture-air',
        kind: 'live',
        operation: 'search',
        outcome: 'success',
        attempts: 1,
      },
    });
    expect(logs.text).not.toContain(KEY);
  });

  it('drops supplier offers it can’t normalize instead of guessing', async () => {
    const { server, search } = setup();
    server.offers = [
      fixtureOffer(),
      fixtureOffer({ ref: 'FA-2', total: { amount: 4520.55, currency: 'INR' } }), // float
      fixtureOffer({ ref: 'FA-3', total: { amount: '10', currency: 'RUPEES' } }),
      fixtureOffer({ ref: 'FA-4', departAt: 'tomorrow morning' }),
      { nonsense: true },
    ];
    const body = searchResponseSchema.parse((await search()).body.data);
    expect(body.results.map((r) => r.id)).toEqual(['fixture-air:FA-1001']);
    expect(body.warnings.map((w) => w.code)).toContain('INVALID_PROVIDER_RESULTS');
  });

  it('keeps currencies apart: nothing is converted or merged', async () => {
    const { server, search } = setup();
    server.offers = [
      fixtureOffer(),
      fixtureOffer({ ref: 'FA-USD', total: { amount: '61.00', currency: 'USD' } }),
    ];
    const body = searchResponseSchema.parse((await search()).body.data);
    const currencies = body.results.map((r) =>
      r.price?.kind === 'total' ? r.price.total.currency : null,
    );
    expect(currencies.sort()).toEqual(['INR', 'USD']);
    expect(body.warnings.map((w) => w.code)).toContain('CURRENCY_NOT_CONVERTED');
  });

  it('retries one transient failure with backoff, never a permanent one', async () => {
    const retrying = { retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 }, random: () => 0 };
    const a = setup({ resilience: retrying });
    a.server.searchBehaviour = { kind: 'status', status: 503, times: 1 };
    expect((await a.search()).status).toBe(200);
    expect(a.server.calls).toHaveLength(2);
    expect(a.logs.entries().find((e) => e.msg === 'Provider call finished')).toMatchObject({
      provider: { attempts: 2, outcome: 'success' },
    });

    const b = setup({ resilience: retrying });
    b.server.searchBehaviour = { kind: 'status', status: 401 };
    const refused = await b.search();
    expect(b.server.calls).toHaveLength(1);
    expect(refused.status).toBe(502);
    expect(refused.body.error.code).toBe('SEARCH_FAILED');
    expect(JSON.stringify(refused.body)).not.toMatch(/fixture-secret|supplier detail|401/);
    expect(b.logs.text).not.toContain(KEY);
  });

  it('reports downtime, timeouts and unusable answers with fixed wording', async () => {
    const down = setup();
    down.server.searchBehaviour = { kind: 'status', status: 503 };
    const res = await down.search();
    expect([res.status, res.body.error.code]).toEqual([503, 'PROVIDER_UNAVAILABLE']);

    const slow = setup();
    slow.server.searchBehaviour = { kind: 'hang' };
    const timedOut = await slow.search();
    expect([timedOut.status, timedOut.body.error.code]).toEqual([504, 'PROVIDER_TIMEOUT']);

    const html = setup();
    html.server.searchBehaviour = { kind: 'html' };
    expect((await html.search()).body.error.code).toBe('SEARCH_FAILED');

    const garbled = setup();
    garbled.server.searchBehaviour = { kind: 'not-a-list' };
    expect((await garbled.search()).body.error.code).toBe('SEARCH_FAILED');
  });

  it('keeps partial results honest: live and demo answers are labelled separately', async () => {
    const { server, search } = setup({ demo: true });
    server.searchBehaviour = { kind: 'status', status: 503 };
    const body = searchResponseSchema.parse((await search()).body.data);
    expect(body.dataSource).toBe('demo');
    expect(body.providerStatuses.find((s) => s.providerId === 'fixture-air')).toMatchObject({
      kind: 'live',
      status: 'unavailable',
    });
    expect(body.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['DEMO_DATA', 'PARTIAL_RESULTS']),
    );
    expect(body.results.every((r) => r.source === 'demo')).toBe(true);
  });
});

describe('a live offer before booking', () => {
  async function searched() {
    const server = new FixtureSupplierServer();
    let now = Date.parse('2026-11-01T10:00:00Z');
    const app = buildTestApp({
      env: { SEARCH_DEMO_PROVIDERS: 'false' },
      searchProviders: [createFixtureAirProvider(FIXTURE_CONFIG, { fetch: server.fetch })],
      providerConfig: FIXTURE_CONFIG,
      searchResilience: NO_RETRY,
      now: () => new Date(now),
    });
    const search = await request(app)
      .post('/api/v1/search/flights')
      .set('Origin', ORIGIN)
      .send(flightsBody);
    const { searchId } = search.body.data;
    const offer = (id = 'fixture-air:FA-1001', category = 'flights') =>
      request(app).get(
        `/api/v1/search/${category}/sessions/${searchId}/offer?id=${encodeURIComponent(id)}`,
      );
    return { server, offer, advance: (ms: number) => (now += ms) };
  }

  it('is rechecked with the supplier: confirmed, changed, gone or inconsistent', async () => {
    const { server, offer } = await searched();
    const confirmed = offerResponseSchema.parse((await offer()).body.data);
    expect(confirmed.validation).toMatchObject({ status: 'confirmed', previousPrice: null });
    expect(server.calls.at(-1)!.url.pathname).toBe('/api/v1/flight-offers/FA-1001/price');

    server.prices.set('FA-1001', { amount: '4999.00', currency: 'INR' });
    const changed = offerResponseSchema.parse((await offer()).body.data);
    expect(changed.validation).toMatchObject({
      status: 'price-changed',
      previousPrice: { kind: 'total', total: { amountMinor: '452050', currency: 'INR' } },
    });
    expect(changed.result.price).toMatchObject({ total: { amountMinor: '499900' } });

    server.prices.set('FA-1001', { amount: '60.00', currency: 'USD' });
    const otherCurrency = await offer();
    expect([otherCurrency.status, otherCurrency.body.error.code]).toEqual([
      503,
      'PROVIDER_UNAVAILABLE',
    ]);

    server.prices.delete('FA-1001');
    const gone = await offer();
    expect([gone.status, gone.body.error.code]).toEqual([410, 'OFFER_UNAVAILABLE']);
  });

  it('validates ids, categories and expiry before asking the supplier', async () => {
    const { server, offer, advance } = await searched();
    const calls = server.calls.length;
    expect((await offer('nobody:FA-1001')).body.error.code).toBe('OFFER_NOT_FOUND');
    expect((await offer('fixture-air:FA-9999')).body.error.code).toBe('OFFER_NOT_IN_SEARCH');
    expect((await offer('fixture-air:FA-1001', 'hotels')).body.error.code).toBe(
      'CATEGORY_MISMATCH',
    );
    expect(server.calls.length).toBe(calls);
    advance(11 * 60 * 1000);
    const expired = await offer();
    expect([expired.status, expired.body.error.code]).toEqual([410, 'SEARCH_EXPIRED']);
    expect(server.calls.length).toBe(calls);
  });
});
