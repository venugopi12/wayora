import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/modules/providers/provider.js';
import { TimeoutError } from '../src/modules/search/concurrency.js';
import {
  CircuitBreaker,
  CircuitOpenError,
  backoffDelay,
  callProvider,
  isTransient,
  type ProviderCallOptions,
} from '../src/modules/search/resilience.js';
import { captureLogs } from './fake-redis.js';
import { hotelResult, hotelsRequest, serviceWith, stubProvider } from './search-support.js';

const policy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 400 };

/** A controllable monotonic clock. */
function manualClock(start = 1_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => void (at += ms) };
}

function options(overrides: Partial<ProviderCallOptions> = {}): ProviderCallOptions {
  return {
    providerId: 'p',
    timeoutMs: 200,
    deadline: performance.now() + 5_000,
    retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 4 },
    breaker: new CircuitBreaker({ failureThreshold: 100, cooldownMs: 1_000 }),
    idempotent: true,
    ...overrides,
  };
}

/** An operation that fails with the given errors in turn, then succeeds. */
function scripted(...failures: unknown[]) {
  const op = {
    calls: 0,
    run: async (_signal: AbortSignal) => {
      op.calls += 1;
      const failure = failures[op.calls - 1];
      if (failure !== undefined) throw failure;
      return 'ok';
    },
  };
  return op;
}

const transient = () => new ProviderError('unavailable', 'HTTP 503 from supplier');
const permanent = () => new ProviderError('error', 'HTTP 401 invalid credentials');

describe('backoff', () => {
  it('is exponential with full jitter and a cap', () => {
    expect(backoffDelay(1, policy, () => 0.999)).toBe(99);
    expect(backoffDelay(2, policy, () => 0.999)).toBe(199);
    expect(backoffDelay(3, policy, () => 0.999)).toBe(399);
    expect(backoffDelay(6, policy, () => 0.999)).toBe(399); // capped at maxDelayMs
    expect(backoffDelay(3, policy, () => 0)).toBe(0); // full jitter starts at zero
  });

  it('classifies transient failures: timeouts and ProviderError(transient) only', () => {
    expect(isTransient(new TimeoutError(10))).toBe(true);
    expect(isTransient(transient())).toBe(true);
    expect(isTransient(new ProviderError('error', 'reset', { transient: true }))).toBe(true);
    expect(isTransient(permanent())).toBe(false);
    expect(isTransient(new ProviderError('unavailable', 'gone', { transient: false }))).toBe(false);
    expect(isTransient(new TypeError('undefined is not a function'))).toBe(false); // bugs aren't retried
  });
});

describe('callProvider retries', () => {
  it('retries transient failures with bounded attempts, then succeeds', async () => {
    const op = scripted(transient(), new TimeoutError(5));
    const retries: number[] = [];
    await expect(
      callProvider(options({ onRetry: ({ attempt }) => void retries.push(attempt) }), op.run),
    ).resolves.toBe('ok');
    expect(op.calls).toBe(3);
    expect(retries).toEqual([1, 2]);
  });

  it('gives up after maxAttempts with the last error', async () => {
    const op = scripted(transient(), transient(), transient(), transient());
    await expect(callProvider(options(), op.run)).rejects.toBeInstanceOf(ProviderError);
    expect(op.calls).toBe(3);
  });

  it('never retries permanent errors, unknown errors or non-idempotent operations', async () => {
    const auth = scripted(permanent());
    await expect(callProvider(options(), auth.run)).rejects.toThrow(/invalid credentials/);
    expect(auth.calls).toBe(1);

    const bug = scripted(new TypeError('boom'));
    await expect(callProvider(options(), bug.run)).rejects.toThrow('boom');
    expect(bug.calls).toBe(1);

    const write = scripted(transient());
    await expect(callProvider(options({ idempotent: false }), write.run)).rejects.toThrow(/503/);
    expect(write.calls).toBe(1);
  });

  it('times out each attempt and respects the overall deadline', async () => {
    let calls = 0;
    const hang = async () => {
      calls += 1;
      return new Promise<never>(() => undefined);
    };
    const started = performance.now();
    await expect(
      callProvider(
        options({
          timeoutMs: 1_000, // the deadline is shorter than one attempt
          deadline: performance.now() + 120,
          retry: { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 1 },
        }),
        hang,
      ),
    ).rejects.toBeInstanceOf(TimeoutError);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(400);
    // No time left for a meaningful second attempt.
    expect(calls).toBe(1);
  });

  it('does not wait for a backoff that would end past the deadline', async () => {
    const op = scripted(transient(), transient());
    const started = performance.now();
    await expect(
      callProvider(
        options({
          deadline: performance.now() + 150,
          retry: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 1_000 },
          random: () => 0.9,
        }),
        op.run,
      ),
    ).rejects.toThrow(/503/);
    expect(op.calls).toBe(1);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('stops at once when the client goes away during a backoff', async () => {
    const controller = new AbortController();
    const op = scripted(transient(), transient());
    const pending = callProvider(
      options({
        signal: controller.signal,
        retry: { maxAttempts: 3, baseDelayMs: 2_000, maxDelayMs: 2_000 },
        random: () => 0.5,
      }),
      op.run,
    );
    setTimeout(() => controller.abort(new Error('client went away')), 20);
    await expect(pending).rejects.toThrow('client went away');
    expect(op.calls).toBe(1);
  });
});

describe('circuit breaker', () => {
  it('closed → open after the threshold; open skips calls without running them', async () => {
    const clock = manualClock();
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 30_000 }, clock.now);
    const failing = scripted(permanent(), permanent(), permanent());
    for (let i = 0; i < 2; i += 1) {
      await expect(callProvider(options({ breaker }), failing.run)).rejects.toThrow();
    }
    expect(breaker.state).toBe('open');
    await expect(callProvider(options({ breaker }), failing.run)).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    expect(failing.calls).toBe(2); // the third call never reached the provider
  });

  it('a success resets the failure count while closed', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1_000 });
    breaker.onFailure();
    breaker.onSuccess();
    breaker.onFailure();
    expect(breaker.state).toBe('closed');
  });

  it('half-open after the cooldown: exactly one trial; success closes, failure reopens', () => {
    const clock = manualClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000 }, clock.now);
    breaker.onFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
    clock.advance(30_000);
    expect(breaker.state).toBe('half-open');
    expect(breaker.tryAcquire()).toBe(true); // the trial
    expect(breaker.tryAcquire()).toBe(false); // nobody else while it runs
    breaker.onFailure();
    expect(breaker.state).toBe('open'); // trial failed: open again, new cooldown
    clock.advance(29_999);
    expect(breaker.tryAcquire()).toBe(false);
    clock.advance(1);
    expect(breaker.tryAcquire()).toBe(true);
    breaker.onSuccess();
    expect(breaker.state).toBe('closed');
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('a trial abandoned by the client frees the slot for the next caller', () => {
    const clock = manualClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10 }, clock.now);
    breaker.onFailure();
    clock.advance(10);
    expect(breaker.tryAcquire()).toBe(true);
    breaker.release();
    expect(breaker.tryAcquire()).toBe(true);
  });
});

describe('resilience inside a search', () => {
  it('retries a flaky provider and logs the retry with the request id and provider', async () => {
    let calls = 0;
    const flaky = stubProvider('flaky', {
      kind: 'results',
      results: [hotelResult('flaky', 'a', 4000)],
    });
    const search = flaky.search.bind(flaky);
    flaky.search = async (request, context) => {
      calls += 1;
      if (calls === 1) {
        throw new ProviderError(
          'unavailable',
          'HTTP 503 from https://api.supplier.example/x?key=s3cret',
          {
            transient: true,
          },
        );
      }
      return search(request, context);
    };
    const logs = captureLogs();
    const service = serviceWith([flaky], {
      logger: pino({ level: 'info' }, logs.stream),
      resilience: { retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 } },
    });
    const response = await service.search(hotelsRequest(), { requestId: 'req-retry-1' });
    expect(response.results.map((r) => r.id)).toEqual(['flaky:a']);
    expect(calls).toBe(2);
    const retry = logs.entries().find((e) => e.msg === 'Retrying provider call');
    expect(retry).toMatchObject({ requestId: 'req-retry-1', providerId: 'flaky', attempt: 1 });
    expect(logs.text).not.toContain('s3cret');
  });

  it('isolates breakers per provider: one failing supplier is skipped, others still answer', async () => {
    const clock = manualClock();
    const down = stubProvider('down', {
      kind: 'throw',
      error: new ProviderError('unavailable', 'outage'),
    });
    const good = stubProvider('good', { kind: 'results', results: [hotelResult('good', 'a', 1)] });
    const service = serviceWith([down, good], {
      resilience: {
        clock: clock.now,
        retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
        breaker: { failureThreshold: 2, cooldownMs: 60_000 },
      },
    });
    // Different searches each time (no reuse), so every search asks providers.
    for (const adults of [1, 2, 3]) await service.search(hotelsRequest({ adults }));
    expect(down.calls).toBe(2); // third search skipped it
    expect(good.calls).toBe(3);
    expect(service.breakerFor('down').state).toBe('open');
    expect(service.breakerFor('good').state).toBe('closed');
    const skipped = await service.search(hotelsRequest({ adults: 4 }));
    expect(skipped.providerStatuses.map((s) => [s.providerId, s.status, s.message])).toEqual([
      ['down', 'unavailable', 'This provider is unavailable right now.'],
      ['good', 'success', null],
    ]);
    // After the cooldown one trial goes through again.
    clock.advance(60_000);
    await service.search(hotelsRequest({ adults: 4, children: 1 }));
    expect(down.calls).toBe(3);
  });
});
