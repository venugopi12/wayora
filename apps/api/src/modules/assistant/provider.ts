import type { AssistantIntent, AssistantTripContext } from '@wayora/contracts';

/*
 * The assistant provider interface (docs/assistant.md#providers).
 *
 * A provider turns one request into raw output text that SHOULD be a JSON
 * object `{ "blocks": [...] }`. It is never trusted: parse.ts validates it.
 * Providers get only what's in `AssistantGeneration` — the user's message,
 * recent visible messages, and the minimal, authorized plan context built by
 * context.ts — never ids, emails, tokens, payment data or secrets.
 *
 * Implementations: `demo.ts` (rule-based, deterministic, no network; labelled
 * as not AI) and `anthropic.ts` (Anthropic Messages API). Credentials live in
 * the adapter, server-side only.
 */

export interface AssistantGeneration {
  intent: AssistantIntent;
  /** The user's new message. */
  message: string;
  /** Earlier visible messages, oldest first, already shortened. */
  history: readonly { role: 'user' | 'assistant'; text: string }[];
  /** The plan the conversation is about (authorized, minimal), or null. */
  context: AssistantTripContext | null;
  /** Wayora's curated sample destinations (names only). */
  catalog: readonly { id: string; name: string; country: string }[];
  /** Today's date (UTC), so "next weekend" can be reasoned about. */
  today: string;
}

export interface AssistantOutput {
  output: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
}

export interface AssistantProvider {
  /** Stable id stored with replies (`demo`, `anthropic`). */
  readonly id: string;
  /** Shown to users, e.g. "Wayora demo assistant (rule-based, not AI)". */
  readonly label: string;
  /** True for the rule-based demo: its answers are not from a language model. */
  readonly simulated: boolean;
  /** The configured model id, or null (demo). */
  readonly model: string | null;
  generate(
    input: AssistantGeneration,
    options: { signal: AbortSignal; maxOutputTokens: number },
  ): Promise<AssistantOutput>;
}

export type ProviderFailure =
  'timeout' | 'rate_limited' | 'overloaded' | 'network' | 'auth' | 'bad_request' | 'bad_response';

/** A provider failure. The message is for logs only and never contains secrets or output. */
export class AssistantProviderError extends Error {
  constructor(
    readonly kind: ProviderFailure,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'AssistantProviderError';
  }

  /** Worth one more attempt within the time budget. */
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'overloaded' || this.kind === 'network';
  }
}

export interface CallOptions {
  /** Overall budget for every attempt together. */
  timeoutMs: number;
  maxAttempts: number;
  maxOutputTokens: number;
  /** Waits between attempts (tests pass an instant one). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Calls the provider with one overall deadline and a bounded number of
 * attempts. Only transient failures (rate limit, overload, network) are
 * retried, after a short pause, and only while time is left; a timeout,
 * a refused request or an unusable response is never retried — generating
 * is expensive, and repeating it rarely helps.
 */
export async function callProvider(
  provider: AssistantProvider,
  input: AssistantGeneration,
  options: CallOptions,
): Promise<AssistantOutput & { attempts: number }> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const deadline = now() + options.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let attempt = 0;
  try {
    for (;;) {
      attempt += 1;
      try {
        const result = await raceAbort(
          provider.generate(input, {
            signal: controller.signal,
            maxOutputTokens: options.maxOutputTokens,
          }),
          controller.signal,
        );
        return { ...result, attempts: attempt };
      } catch (error) {
        if (controller.signal.aborted) {
          throw new AssistantProviderError('timeout', `no answer within ${options.timeoutMs} ms`);
        }
        const failure =
          error instanceof AssistantProviderError
            ? error
            : new AssistantProviderError('bad_response', 'provider threw an unexpected error');
        const pause = 400 * attempt;
        if (!failure.retryable || attempt >= options.maxAttempts || now() + pause >= deadline) {
          throw failure;
        }
        await sleep(pause);
        if (controller.signal.aborted) {
          throw new AssistantProviderError('timeout', `no answer within ${options.timeoutMs} ms`);
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Rejects as soon as the signal aborts, even if the provider ignores it. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('provider failed'));
      },
    );
  });
}
