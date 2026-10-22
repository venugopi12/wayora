import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { offerResponseSchema, type SearchPrice } from '@wayora/contracts';
import type { RevalidationOutcome } from '../src/modules/providers/provider.js';
import { ProviderError } from '../src/modules/providers/provider.js';
import { errorForLog, scrub } from '../src/modules/search/errors.js';
import { pricesEqual } from '../src/modules/search/search.service.js';
import { captureLogs } from './fake-redis.js';
import { buildTestApp } from './helpers.js';
import {
  NO_RETRY,
  VALID_INPUTS,
  hotelResult,
  stubProvider,
  type StubProvider,
} from './search-support.js';

/*
 * Offer validation with a provider that supports revalidation. No production
 * adapter does yet (all are demo fixtures); this test-only adapter stands in
 * for a live supplier so the server-side flow is covered before one exists.
 */

const ORIGIN = 'http://localhost:5173';
const { serviceType: _t, ...hotelsBody } = VALID_INPUTS.hotels;

const inr = (rupees: number): SearchPrice => ({
  kind: 'total',
  total: { amountMinor: String(rupees * 100), currency: 'INR' },
  perUnit: { amount: { amountMinor: String(rupees * 100), currency: 'INR' }, unit: 'night' },
});

type Answer = RevalidationOutcome | 'hang' | { throws: unknown } | { raw: unknown };

function revalidatingProvider(answer: () => Answer, timeoutMs = 200) {
  const provider = stubProvider(
    'live-hotels',
    { kind: 'results', results: [hotelResult('live-hotels', 'r1', 4000)] },
    { timeoutMs },
  ) as StubProvider & { revalidations: number };
  provider.revalidations = 0;
  Object.assign(provider, {
    operations: { search: 'supported', revalidate: 'supported', book: 'unsupported' },
    async revalidate() {
      provider.revalidations += 1;
      const a = answer();
      if (a === 'hang') return new Promise<never>(() => undefined);
      if ('throws' in a) throw a.throws;
      if ('raw' in a) return a.raw;
      return a;
    },
  });
  return provider;
}

async function setup(answer: () => Answer, { timeoutMs = 200, logs = captureLogs() } = {}) {
  const provider = revalidatingProvider(answer, timeoutMs);
  const app = buildTestApp({
    searchProviders: [provider],
    searchResilience: NO_RETRY,
    logger: pino({ level: 'info' }, logs.stream),
  });
  const search = await request(app)
    .post('/api/v1/search/hotels')
    .set('Origin', ORIGIN)
    .send(hotelsBody);
  expect(search.status).toBe(200);
  const { searchId } = search.body.data;
  const getOffer = () =>
    request(app)
      .get(`/api/v1/search/hotels/sessions/${searchId}/offer?id=live-hotels%3Ar1`)
      .set('X-Request-Id', 'req-offer-check-1');
  return { app, provider, searchId, getOffer, logs, search };
}

describe('offer revalidation (provider supports it)', () => {
  it('confirmed: same price, with when it was checked', async () => {
    const { getOffer, provider } = await setup(() => ({ status: 'available', price: inr(4000) }));
    const res = await getOffer();
    expect(res.status).toBe(200);
    const offer = offerResponseSchema.parse(res.body.data);
    expect(offer.validation).toEqual({
      status: 'confirmed',
      checkedAt: expect.any(String),
      previousPrice: null,
    });
    expect(offer.result.price).toEqual(inr(4000));
    expect(provider.revalidations).toBe(1);
  });

  it('price changed: the new price is shown with the previous one, and the session is updated', async () => {
    let price = 4500;
    const { app, getOffer } = await setup(() => ({ status: 'available', price: inr(price) }));
    const res = await getOffer();
    expect(res.status).toBe(200);
    expect(res.body.data.result.price).toEqual(inr(4500));
    expect(res.body.data.validation).toMatchObject({
      status: 'price-changed',
      previousPrice: inr(4000),
    });
    // The search page reads the same session: it now lists the new price too.
    const page = await request(app)
      .post('/api/v1/search/hotels')
      .set('Origin', ORIGIN)
      .send({ ...hotelsBody, sortBy: 'price-desc' });
    expect(page.body.data.results[0].price).toEqual(inr(4500));
    // Unchanged on the next check: confirmed against the stored (new) price.
    price = 4500;
    expect((await getOffer()).body.data.validation.status).toBe('confirmed');
  });

  it('unavailable: 410 OFFER_UNAVAILABLE', async () => {
    const { getOffer } = await setup(() => ({ status: 'unavailable' }));
    const res = await getOffer();
    expect(res.status).toBe(410);
    expect(res.body.error).toMatchObject({
      code: 'OFFER_UNAVAILABLE',
      message: expect.stringMatching(/no longer available/),
    });
  });

  it('timeout: 504 PROVIDER_TIMEOUT', async () => {
    const { getOffer } = await setup(() => 'hang', { timeoutMs: 30 });
    const res = await getOffer();
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('PROVIDER_TIMEOUT');
  });

  it('invalid answers (bad shape, another currency, a float) are refused, never shown', async () => {
    for (const raw of [
      { status: 'maybe' },
      {
        status: 'available',
        price: { kind: 'total', total: { amountMinor: '45.5', currency: 'INR' }, perUnit: null },
      },
      {
        status: 'available',
        price: { kind: 'total', total: { amountMinor: '5000', currency: 'USD' }, perUnit: null },
      },
      { status: 'available', price: null },
    ]) {
      const { getOffer } = await setup(() => ({ raw }));
      const res = await getOffer();
      expect(res.status, JSON.stringify(raw)).toBe(503);
      expect(res.body.error.code).toBe('PROVIDER_UNAVAILABLE');
      expect(JSON.stringify(res.body)).not.toMatch(/USD|45\.5/);
    }
  });

  it('supplier errors never leak: no message, URL, credential or body reaches the client or the logs', async () => {
    const secretError = new ProviderError(
      'error',
      'HTTP 500 POST https://ops:hunter2@api.supplier.example/v2/offers/r1?apikey=SK_live_123 Authorization: Bearer eyJhbGciOi.secret body={"pnr":"ZX81"} password=pa55',
    );
    const { getOffer, logs } = await setup(() => ({ throws: secretError }));
    const res = await getOffer();
    expect(res.status).toBe(503);
    expect(res.body.error).toEqual({
      code: 'PROVIDER_UNAVAILABLE',
      message: expect.stringMatching(/couldn't check this offer/),
      requestId: 'req-offer-check-1',
    });
    const leaked = /hunter2|SK_live_123|eyJhbGciOi|pa55|apikey=|supplier\.example|ZX81|HTTP 500/;
    expect(JSON.stringify(res.body)).not.toMatch(leaked);

    // Logged for operators, with request and provider context, but scrubbed.
    const entry = logs.entries().find((e) => e.msg === 'Offer revalidation failed')!;
    expect(entry).toMatchObject({
      requestId: 'req-offer-check-1',
      providerId: 'live-hotels',
      operation: 'revalidate',
      outcome: 'error',
    });
    expect(logs.text).not.toMatch(/hunter2|SK_live_123|eyJhbGciOi|pa55/);
    expect(JSON.stringify(entry.err)).toContain('api.supplier.example/v2/offers/r1?[REDACTED]');
  });

  it('demo providers are never rechecked: the offer is valid for the session only', async () => {
    const app = buildTestApp();
    const search = await request(app)
      .post('/api/v1/search/hotels')
      .set('Origin', ORIGIN)
      .send(hotelsBody);
    const { searchId, results } = search.body.data;
    const res = await request(app).get(
      `/api/v1/search/hotels/sessions/${searchId}/offer?id=${encodeURIComponent(results[0].id)}`,
    );
    expect(res.body.data.validation).toEqual({
      status: 'session',
      checkedAt: null,
      previousPrice: null,
    });
    expect(res.body.data.disclaimer).toMatch(/^Demo data/);
  });
});

describe('search errors never leak supplier details', () => {
  it('search responses and logs stay clean when a provider throws something sensitive', async () => {
    const logs = captureLogs();
    const app = buildTestApp({
      searchProviders: [
        stubProvider('leaky', {
          kind: 'throw',
          error: Object.assign(
            new Error(
              'getaddrinfo ENOTFOUND internal-fares.corp.local token=abc123 at https://u:p@fares.example/q?secret=zzz',
            ),
            { code: 'ENOTFOUND', response: { body: 'card 4111111111111111' } },
          ),
        }),
        stubProvider('ok', { kind: 'results', results: [hotelResult('ok', 'a', 3000)] }),
      ],
      searchResilience: NO_RETRY,
      logger: pino({ level: 'info' }, logs.stream),
    });
    const res = await request(app)
      .post('/api/v1/search/hotels')
      .set('Origin', ORIGIN)
      .set('X-Request-Id', 'req-search-leak-1')
      .send(hotelsBody);
    expect(res.status).toBe(200);
    const leaky = res.body.data.providerStatuses.find(
      (s: { providerId: string }) => s.providerId === 'leaky',
    );
    expect(leaky).toMatchObject({
      status: 'error',
      message: 'This provider could not complete the search.',
    });
    const secrets = /abc123|u:p@|zzz|4111111111111111|corp\.local/;
    expect(JSON.stringify(res.body)).not.toMatch(secrets);
    const entry = logs.entries().find((e) => e.msg === 'Provider search failed')!;
    expect(entry).toMatchObject({
      requestId: 'req-search-leak-1',
      providerId: 'leaky',
      operation: 'search',
    });
    // The host name stays for diagnosis; credentials, query strings and bodies do not.
    expect(logs.text).not.toMatch(/abc123|u:p@|zzz|4111111111111111/);
  });
});

describe('scrubbing for logs', () => {
  it('masks credentials in URLs, key/value pairs and auth headers, and truncates', () => {
    expect(scrub('GET https://user:pw@api.x.example/v1/a?key=1&b=2#frag failed')).toBe(
      'GET https://api.x.example/v1/a?[REDACTED] failed',
    );
    expect(scrub('apiKey=abc token: "xyz" password=p clientSecret=q')).toBe(
      'apiKey=[REDACTED] token: "[REDACTED]" password=[REDACTED] clientSecret=[REDACTED]',
    );
    expect(scrub('client_secret=q api-key=k')).toBe('client_secret=[REDACTED] api-key=[REDACTED]');
    const header = scrub('Authorization: Bearer abc.def-ghi');
    expect(header).not.toContain('abc.def-ghi');
    expect(header).toMatch(/^Authorization: /);
    expect(scrub('Basic dXNlcjpwYXNz')).toBe('Basic [REDACTED]');
    expect(scrub('x'.repeat(1_000))).toHaveLength(300);
  });

  it('errorForLog keeps the class and a scrubbed message only', () => {
    const err = Object.assign(new Error('boom token=t1'), { code: 'E_X', stack: 'secret stack' });
    expect(errorForLog(err)).toEqual({
      name: 'Error',
      message: 'boom token=[REDACTED]',
      code: 'E_X',
    });
    expect(errorForLog('plain password=p')).toEqual({
      name: 'NonError',
      message: 'plain password=[REDACTED]',
    });
  });
});

describe('price comparison', () => {
  it('is exact over integer minor units', () => {
    expect(pricesEqual(inr(4000), inr(4000))).toBe(true);
    expect(pricesEqual(inr(4000), inr(4001))).toBe(false);
    const range = (min: string, max: string): SearchPrice => ({
      kind: 'range',
      min: { amountMinor: min, currency: 'INR' },
      max: { amountMinor: max, currency: 'INR' },
    });
    expect(pricesEqual(range('100', '200'), range('0100', '200'))).toBe(true);
    expect(pricesEqual(range('100', '200'), inr(1))).toBe(false);
    expect(pricesEqual(null, null)).toBe(true);
    expect(pricesEqual(null, inr(1))).toBe(false);
  });
});
