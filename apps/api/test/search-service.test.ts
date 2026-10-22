import { describe, expect, it } from 'vitest';
import { DEMO_DATA_DISCLAIMER, searchResponseSchema } from '@wayora/contracts';
import { ProviderError } from '../src/modules/providers/provider.js';
import { MemorySearchSessionStore } from '../src/modules/search/sessions.js';
import {
  mapWithConcurrency,
  withTimeout,
  TimeoutError,
} from '../src/modules/search/concurrency.js';
import { requestKey } from '../src/modules/search/search.service.js';
import { AppError } from '../src/utils/errors.js';
import {
  hotelResult,
  hotelsRequest,
  serviceWith,
  stubProvider,
  unavailable,
} from './search-support.js';

const ok = (id: string, ...results: unknown[]) => stubProvider(id, { kind: 'results', results });

describe('search orchestration', () => {
  it('single provider: returns its validated results with status metadata', async () => {
    const service = serviceWith([
      ok('p1', hotelResult('p1', 'a', 5000), hotelResult('p1', 'b', 4000)),
    ]);
    const response = await service.search(hotelsRequest());
    expect(searchResponseSchema.parse(response)).toEqual(response);
    // Hotels default to lowest price first (DEFAULT_SORT).
    expect(response.results.map((r) => r.id)).toEqual(['p1:b', 'p1:a']);
    expect(response.providerStatuses).toEqual([
      {
        providerId: 'p1',
        providerName: 'Stub p1',
        kind: 'demo',
        status: 'success',
        resultCount: 2,
        durationMs: expect.any(Number),
        message: null,
      },
    ]);
    expect(response.dataSource).toBe('demo');
    expect(response.disclaimer).toBe(DEMO_DATA_DISCLAIMER);
    expect(response.warnings.map((w) => w.code)).toEqual(['DEMO_DATA']);
    expect(response.pagination).toEqual({ page: 1, pageSize: 10, totalResults: 2, totalPages: 1 });
  });

  it('multiple providers: merges their results, then applies the category sort', async () => {
    const service = serviceWith([
      ok('p1', hotelResult('p1', 'a', 5000)),
      ok('p2', hotelResult('p2', 'x', 3000)),
    ]);
    const response = await service.search(hotelsRequest());
    expect(response.results.map((r) => r.id)).toEqual(['p2:x', 'p1:a']);
    expect(response.providerStatuses.map((s) => s.status)).toEqual(['success', 'success']);
  });

  it('partial failure: keeps the good results and says which providers failed', async () => {
    const service = serviceWith([
      ok('good', hotelResult('good', 'a', 5000)),
      stubProvider('down', { kind: 'throw', error: unavailable }),
      stubProvider('broken', {
        kind: 'throw',
        error: new Error('ECONNRESET at 10.0.0.12 with token=abc'),
      }),
      stubProvider('slow', { kind: 'hang' }, { timeoutMs: 30 }),
    ]);
    const response = await service.search(hotelsRequest());
    expect(response.results.map((r) => r.id)).toEqual(['good:a']);
    expect(response.providerStatuses.map((s) => [s.providerId, s.status, s.message])).toEqual([
      ['good', 'success', null],
      // Fixed wording: the adapter's own message ('Supplier maintenance window.') stays in logs.
      ['down', 'unavailable', 'This provider is unavailable right now.'],
      ['broken', 'error', 'This provider could not complete the search.'],
      ['slow', 'timeout', 'This provider took too long to answer.'],
    ]);
    // Internal error details never reach the response.
    expect(JSON.stringify(response)).not.toMatch(/ECONNRESET|10\.0\.0\.12|token/);
    expect(response.warnings.find((w) => w.code === 'PARTIAL_RESULTS')?.message).toMatch(
      /Stub down, Stub broken, Stub slow/,
    );
  });

  it('all providers fail: a stable error code by cause, not an empty success', async () => {
    const failure = async (...providers: Parameters<typeof serviceWith>[0]) =>
      (await serviceWith(providers)
        .search(hotelsRequest())
        .catch((e: unknown) => e)) as AppError;
    const slow = (id: string) => stubProvider(id, { kind: 'hang' }, { timeoutMs: 20 });
    const down = (id: string) => stubProvider(id, { kind: 'throw', error: unavailable });

    expect(await failure(slow('a'), slow('b'))).toMatchObject({
      code: 'PROVIDER_TIMEOUT',
      status: 504,
    });
    expect(await failure(down('a'), down('b'))).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      status: 503,
    });
    const mixed = await failure(down('a'), slow('b'));
    expect(mixed).toBeInstanceOf(AppError);
    expect(mixed).toMatchObject({ code: 'SEARCH_FAILED', status: 502 });
    expect(mixed.message).toMatch(/couldn't search hotels right now/);
  });

  it('zero results from healthy providers is a successful, empty search', async () => {
    const response = await serviceWith([ok('p1'), ok('p2')]).search(hotelsRequest());
    expect(response.results).toEqual([]);
    expect(response.providerStatuses.map((s) => s.status)).toEqual(['empty', 'empty']);
    expect(response.dataSource).toBe('none');
    // The (empty) answer still came from demo fixtures, so it is labelled as demo.
    expect(response.disclaimer).toBe(DEMO_DATA_DISCLAIMER);
    expect(response.warnings.map((w) => w.code)).toContain('DEMO_DATA');
    expect(response.pagination).toEqual({ page: 1, pageSize: 10, totalResults: 0, totalPages: 0 });
  });

  it('an empty answer from live providers only carries no demo label', async () => {
    const live = stubProvider('live-1', { kind: 'results', results: [] }, { kind: 'live' });
    const response = await serviceWith([live]).search(hotelsRequest());
    expect(response.disclaimer).toBeNull();
    expect(response.warnings.map((w) => w.code)).not.toContain('DEMO_DATA');
  });

  it('no enabled provider for the category: 503 with a clear message', async () => {
    const flightsOnly = serviceWith([
      stubProvider('f', { kind: 'results', results: [] }, { serviceTypes: ['flights'] }),
    ]);
    await expect(flightsOnly.search(hotelsRequest())).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: "Hotels search isn't available right now.",
    });
  });

  it('times out a provider that ignores its abort signal, without waiting for it', async () => {
    const started = Date.now();
    const response = await serviceWith([
      ok('fast', hotelResult('fast', 'a', 1000)),
      stubProvider('stuck', { kind: 'hang' }, { timeoutMs: 50 }),
    ]).search(hotelsRequest());
    expect(Date.now() - started).toBeLessThan(1000);
    expect(response.providerStatuses[1]).toMatchObject({ status: 'timeout', resultCount: 0 });
  });

  it('validates provider output: drops malformed results, rejects impersonation, flags all-invalid providers', async () => {
    const malformed = {
      ...hotelResult('mixed', 'bad', 100),
      price: { kind: 'total', total: { amountMinor: '1.5', currency: 'INR' }, perUnit: null },
    };
    const impersonating = hotelResult('someone-else', 'fake', 100);
    const service = serviceWith([
      ok(
        'mixed',
        hotelResult('mixed', 'good', 2000),
        malformed,
        impersonating,
        'not even an object',
      ),
      ok('garbage', { hello: 'world' }),
      stubProvider('no-array', { kind: 'results', results: undefined as unknown as [] }),
    ]);
    const response = await service.search(hotelsRequest());
    expect(response.results.map((r) => r.id)).toEqual(['mixed:good']);
    expect(response.providerStatuses.map((s) => [s.providerId, s.status, s.resultCount])).toEqual([
      ['mixed', 'success', 1],
      ['garbage', 'error', 0],
      ['no-array', 'error', 0],
    ]);
    expect(response.warnings.find((w) => w.code === 'INVALID_PROVIDER_RESULTS')?.message).toBe(
      '4 results with incomplete data were left out.',
    );
  });

  it('de-duplicates results that share a reliable key, keeping the cheaper one', async () => {
    const service = serviceWith([
      ok(
        'p1',
        hotelResult('p1', 'a', 5000, { dedupeKey: 'same-room' }),
        hotelResult('p1', 'b', 7000),
      ),
      ok(
        'p2',
        hotelResult('p2', 'a2', 4500, { dedupeKey: 'same-room' }),
        hotelResult('p2', 'c', 6000, { dedupeKey: 'other' }),
      ),
    ]);
    const response = await service.search(hotelsRequest());
    // The cheaper duplicate wins; then lowest price first.
    expect(response.results.map((r) => r.id)).toEqual(['p2:a2', 'p2:c', 'p1:b']);
    // Keyless results are never merged, even if they look alike.
    const keyless = serviceWith([
      ok('p1', hotelResult('p1', 'a', 5000)),
      ok('p2', hotelResult('p2', 'a', 5000)),
    ]);
    expect((await keyless.search(hotelsRequest())).results).toHaveLength(2);
  });

  it('filters, sorts and pages after merging', async () => {
    const service = serviceWith([
      ok(
        'p1',
        hotelResult('p1', 'pool', 9000, {
          amenities: ['wifi', 'pool'],
          property: { name: 'Pool', propertyType: 'resort', area: null, cityName: 'Goa' },
        }),
        hotelResult('p1', 'cheap', 3000),
        hotelResult('p1', 'mid', 6000, { amenities: ['wifi', 'pool'] }),
      ),
    ]);
    const asc = await service.search(hotelsRequest({ sortBy: 'price-asc' }));
    expect(asc.results.map((r) => r.offerRef)).toEqual(['cheap', 'mid', 'pool']);
    const desc = await service.search(hotelsRequest({ sortBy: 'price-desc' }));
    expect(desc.results.map((r) => r.offerRef)).toEqual(['pool', 'mid', 'cheap']);
    const pool = await service.search(hotelsRequest({ filters: { amenities: ['pool'] } }));
    expect(pool.results.map((r) => r.offerRef)).toEqual(['mid', 'pool']);
    const resorts = await service.search(hotelsRequest({ filters: { propertyTypes: ['resort'] } }));
    expect(resorts.results.map((r) => r.offerRef)).toEqual(['pool']);
    const budget = await service.search(
      hotelsRequest({ filters: { maxNightlyPriceMinor: '600000' } }),
    );
    expect(budget.results.map((r) => r.offerRef)).toEqual(['cheap', 'mid']);
    const page2 = await service.search(
      hotelsRequest({ sortBy: 'price-asc', pageSize: 2, page: 2 }),
    );
    expect(page2.results.map((r) => r.offerRef)).toEqual(['pool']);
    expect(page2.pagination).toEqual({ page: 2, pageSize: 2, totalResults: 3, totalPages: 2 });
    const beyond = await service.search(hotelsRequest({ pageSize: 2, page: 5 }));
    expect(beyond.results).toEqual([]);
  });

  it('never mixes currencies: no conversion, price filters skip other currencies, with warnings', async () => {
    const usd = hotelResult('p1', 'usd', 0, {
      price: {
        kind: 'total',
        total: { amountMinor: '9000', currency: 'USD' },
        perUnit: { amount: { amountMinor: '9000', currency: 'USD' }, unit: 'night' },
      },
    });
    const service = serviceWith([ok('p1', hotelResult('p1', 'inr', 5000), usd)]);
    const sorted = await service.search(hotelsRequest({ sortBy: 'price-asc' }));
    expect(sorted.results.map((r) => r.offerRef)).toEqual(['inr', 'usd']); // other currency last, not compared
    expect(sorted.warnings.find((w) => w.code === 'CURRENCY_NOT_CONVERTED')?.message).toMatch(
      /USD.*not converted to INR/,
    );
    const limited = await service.search(
      hotelsRequest({ filters: { maxNightlyPriceMinor: '1000000' } }),
    );
    expect(limited.results.map((r) => r.offerRef)).toEqual(['inr']);
    expect(limited.warnings.map((w) => w.code)).toContain('PRICE_FILTER_CURRENCY');
  });

  it('queries providers with bounded concurrency', async () => {
    let running = 0;
    let peak = 0;
    const hooks = {
      onStart: () => (peak = Math.max(peak, (running += 1))),
      onEnd: () => (running -= 1),
    };
    const providers = Array.from({ length: 6 }, (_, i) =>
      stubProvider(
        `p${i}`,
        { kind: 'results', results: [hotelResult(`p${i}`, 'x', 1000)], delayMs: 15 },
        hooks,
      ),
    );
    const response = await serviceWith(providers, { concurrency: 2 }).search(hotelsRequest());
    expect(peak).toBe(2);
    expect(response.results).toHaveLength(6);
  });

  it('reuses a complete provider round for paging, sorting and filtering, but not after failures', async () => {
    let clock = new Date('2026-10-21T08:00:00Z');
    const now = () => clock;
    const provider = ok('p1', hotelResult('p1', 'a', 5000), hotelResult('p1', 'b', 3000));
    const service = serviceWith([provider], {
      sessions: new MemorySearchSessionStore(10, now),
      now,
    });
    const first = await service.search(hotelsRequest());
    const second = await service.search(hotelsRequest({ sortBy: 'price-asc', page: 1 }));
    expect(provider.calls).toBe(1);
    expect(second.searchId).toBe(first.searchId);
    expect(second.results.map((r) => r.offerRef)).toEqual(['b', 'a']);
    // A different party size is a different search.
    await service.search(hotelsRequest({ adults: 3, rooms: 1 }));
    expect(provider.calls).toBe(2);
    // Expired after the session lifetime (10 minutes by default).
    clock = new Date(clock.getTime() + 601_000);
    const third = await service.search(hotelsRequest());
    expect(provider.calls).toBe(3);
    expect(third.searchId).not.toBe(first.searchId);

    const flaky = stubProvider('flaky', {
      kind: 'throw',
      error: new ProviderError('unavailable', 'Down.'),
    });
    const partial = serviceWith([ok('p2', hotelResult('p2', 'a', 1)), flaky], {
      sessions: new MemorySearchSessionStore(10, now),
      now,
    });
    await partial.search(hotelsRequest());
    await partial.search(hotelsRequest());
    expect(flaky.calls).toBe(2); // partial rounds are not cached, so a retry really retries
  });

  it('request keys separate everything that changes provider answers', () => {
    const providers = [ok('p1')];
    const base = requestKey(hotelsRequest(), providers);
    expect(
      requestKey(
        hotelsRequest({ sortBy: 'price-asc', page: 2, filters: { amenities: ['pool'] } }),
        providers,
      ),
    ).toBe(base);
    expect(requestKey(hotelsRequest({ currency: 'USD' }), providers)).not.toBe(base);
    expect(requestKey(hotelsRequest({ children: 1 }), providers)).not.toBe(base);
    expect(requestKey(hotelsRequest({ destination: 'city:jaipur' }), providers)).not.toBe(base);
    expect(requestKey(hotelsRequest(), [{ ...providers[0]!, version: '2' }])).not.toBe(base);
  });

  it('stops when the caller aborts', async () => {
    const controller = new AbortController();
    const pending = serviceWith([
      stubProvider('slow', { kind: 'results', results: [], delayMs: 100 }),
    ]).search(hotelsRequest(), { signal: controller.signal });
    controller.abort(new Error('client went away'));
    await expect(pending).rejects.toThrow('client went away');
  });
});

describe('concurrency helpers', () => {
  it('mapWithConcurrency keeps input order', async () => {
    const out = await mapWithConcurrency([30, 10, 20], 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2]);
  });

  it('withTimeout rejects with TimeoutError and aborts the signal', async () => {
    let seen: AbortSignal | undefined;
    await expect(
      withTimeout(20, undefined, (signal) => {
        seen = signal;
        return new Promise(() => undefined);
      }),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(seen?.aborted).toBe(true);
    await expect(withTimeout(1000, undefined, async () => 'done')).resolves.toBe('done');
  });
});
