import { ProviderError } from '../providers/provider.js';
import { TimeoutError, withTimeout } from './concurrency.js';

/*
 * Resilience for provider calls (docs/search.md#timeouts-retries-and-circuit-breakers).
 *
 * - Every attempt has a time limit: the provider's own, cut short by what
 *   is left of the overall deadline for the search or offer check.
 * - Only transient failures (timeouts, ProviderError with `transient`) of
 *   idempotent, read-only operations are retried, with exponential backoff
 *   and full jitter, and never past the deadline. Everything else fails at
 *   once. Unknown errors are treated as permanent: an adapter must say a
 *   failure is transient before it is retried.
 * - A circuit breaker per provider stops calling a supplier that keeps
 *   failing, so a down supplier costs a search nothing instead of a full
 *   timeout, and lets one trial call through after a cooldown.
 *
 * Breakers are per API process: each instance learns about a failing
 * supplier from its own calls. That keeps them independent of Redis (whose
 * outage must not take provider calls down with it).
 */

export interface RetryPolicy {
  /** Total attempts including the first (1 = never retry). */
  maxAttempts: number;
  /** Backoff before retry n is a random delay in [0, min(maxDelayMs, baseDelayMs × 2^(n-1))]. */
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface BreakerOptions {
  /** Consecutive failed calls that open the breaker. */
  failureThreshold: number;
  /** How long the breaker stays open before a trial call. */
  cooldownMs: number;
}

export type BreakerState = 'closed' | 'open' | 'half-open';

/** The provider was skipped because its breaker is open. */
export class CircuitOpenError extends Error {
  constructor(readonly providerId: string) {
    super(`Circuit open for provider ${providerId}`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * closed ──(failureThreshold consecutive failures)──▶ open
 * open ──(cooldownMs elapsed; next call is the single trial)──▶ half-open
 * half-open ──trial succeeds──▶ closed     half-open ──trial fails──▶ open
 */
export class CircuitBreaker {
  private status: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;

  constructor(
    private readonly options: BreakerOptions,
    /** Monotonic milliseconds. */
    private readonly clock: () => number = () => performance.now(),
  ) {}

  /** The state as a caller would find it now. */
  get state(): BreakerState {
    if (this.status === 'open' && this.clock() - this.openedAt >= this.options.cooldownMs) {
      return 'half-open';
    }
    return this.status;
  }

  /** Whether a call may go ahead. In half-open, only one trial call at a time. */
  tryAcquire(): boolean {
    if (this.status === 'closed') return true;
    if (this.status === 'open') {
      if (this.clock() - this.openedAt < this.options.cooldownMs) return false;
      this.status = 'half-open';
      this.trialInFlight = false;
    }
    if (this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  onSuccess(): void {
    this.status = 'closed';
    this.failures = 0;
    this.trialInFlight = false;
  }

  onFailure(): void {
    if (this.status === 'half-open') {
      this.open();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.options.failureThreshold) this.open();
  }

  /** A call ended without an outcome (the client went away): free the trial slot. */
  release(): void {
    if (this.status === 'half-open') this.trialInFlight = false;
  }

  private open(): void {
    this.status = 'open';
    this.openedAt = this.clock();
    this.failures = 0;
    this.trialInFlight = false;
  }
}

/** Whether trying the same read again soon may succeed. */
export function isTransient(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  if (error instanceof ProviderError) return error.transient;
  return false;
}

/** Delay before retry `retry` (1-based): full jitter over an exponential ceiling. */
export function backoffDelay(retry: number, policy: RetryPolicy, random = Math.random): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retry - 1));
  return Math.floor(random() * ceiling);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface ProviderCallOptions {
  providerId: string;
  /** The provider's own limit for one attempt. */
  timeoutMs: number;
  /** Monotonic time (same clock as `clock`) by which everything must be done. */
  deadline: number;
  /** Aborts everything (the client went away). */
  signal?: AbortSignal | undefined;
  retry: RetryPolicy;
  breaker: CircuitBreaker;
  /** Only idempotent, read-only operations may be retried. */
  idempotent: boolean;
  clock?: () => number;
  random?: () => number;
  /** Called before each retry, for logging. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/**
 * Runs one provider operation with time limits, retries and the breaker.
 * Resolves with the operation's value; rejects with the last error
 * (TimeoutError, ProviderError, CircuitOpenError, other) or, if `signal`
 * aborted, with its reason.
 */
export async function callProvider<T>(
  options: ProviderCallOptions,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const clock = options.clock ?? (() => performance.now());
  const { breaker, signal, retry } = options;
  if (!breaker.tryAcquire()) throw new CircuitOpenError(options.providerId);

  const maxAttempts = options.idempotent ? retry.maxAttempts : 1;
  for (let attempt = 1; ; attempt += 1) {
    const remaining = options.deadline - clock();
    try {
      if (remaining <= 0) throw new TimeoutError(0);
      const value = await withTimeout(
        Math.min(options.timeoutMs, Math.ceil(remaining)),
        signal,
        operation,
      );
      breaker.onSuccess();
      return value;
    } catch (error) {
      if (signal?.aborted) {
        breaker.release();
        throw signal.reason;
      }
      const delayMs = backoffDelay(attempt, retry, options.random);
      // A retry needs time for the wait plus a meaningful attempt.
      const minimumAttemptMs = Math.min(100, options.timeoutMs);
      const canRetry =
        attempt < maxAttempts &&
        isTransient(error) &&
        clock() + delayMs + minimumAttemptMs < options.deadline;
      if (!canRetry) {
        breaker.onFailure();
        throw error;
      }
      options.onRetry?.({ attempt, delayMs, error });
      try {
        await sleep(delayMs, signal);
      } catch (abortReason) {
        breaker.release();
        throw abortReason;
      }
    }
  }
}
