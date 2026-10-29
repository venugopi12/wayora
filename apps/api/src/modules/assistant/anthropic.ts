import { buildPrompt } from './prompt.js';
import {
  AssistantProviderError,
  type AssistantGeneration,
  type AssistantOutput,
  type AssistantProvider,
} from './provider.js';

/*
 * Anthropic Messages API adapter (docs/assistant.md#anthropic).
 *
 * - The API key and model come from AI_API_KEY / AI_MODEL; no model is
 *   assumed. The key is sent only in the `x-api-key` header to the configured
 *   origin and never logged, returned or included in errors.
 * - Not streamed: one request, one complete answer (`stream` is not used).
 * - Errors become AssistantProviderError kinds by HTTP status only; the
 *   provider's error body is never read into messages or logs.
 * - A reply cut off at the token limit is treated as unusable rather than
 *   parsed half-way.
 */

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_ORIGIN = 'https://api.anthropic.com';

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

interface MessagesResponse {
  content?: unknown;
  stop_reason?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

const count = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

export function failureForStatus(status: number): AssistantProviderError {
  if (status === 401 || status === 403) {
    return new AssistantProviderError(
      'auth',
      `provider refused the credentials (${status})`,
      status,
    );
  }
  if (status === 429) {
    return new AssistantProviderError('rate_limited', 'provider rate limit', status);
  }
  if (status >= 500) {
    return new AssistantProviderError('overloaded', `provider error ${status}`, status);
  }
  return new AssistantProviderError(
    'bad_request',
    `provider refused the request (${status})`,
    status,
  );
}

export class AnthropicProvider implements AssistantProvider {
  readonly id = 'anthropic';
  readonly label = 'AI assistant (Anthropic)';
  readonly simulated = false;
  readonly model: string;
  /** A true private field: never serialized, logged or enumerable. */
  readonly #apiKey: string;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicOptions) {
    this.#apiKey = options.apiKey;
    this.model = options.model;
    this.url = `${(options.baseUrl ?? DEFAULT_ORIGIN).replace(/\/+$/, '')}/v1/messages`;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async generate(
    input: AssistantGeneration,
    options: { signal: AbortSignal; maxOutputTokens: number },
  ): Promise<AssistantOutput> {
    const prompt = buildPrompt(input);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        signal: options.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.#apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: options.maxOutputTokens,
          system: prompt.system,
          messages: prompt.messages,
        }),
      });
    } catch {
      if (options.signal.aborted) throw new AssistantProviderError('timeout', 'request aborted');
      throw new AssistantProviderError('network', 'could not reach the provider');
    }
    if (!response.ok) {
      // Drain without reading the body into anything.
      await response.body?.cancel().catch(() => undefined);
      throw failureForStatus(response.status);
    }
    let body: MessagesResponse;
    try {
      body = (await response.json()) as MessagesResponse;
    } catch {
      throw new AssistantProviderError('bad_response', 'response was not JSON', response.status);
    }
    if (body.stop_reason === 'max_tokens') {
      throw new AssistantProviderError('bad_response', 'reply cut off at the token limit');
    }
    const parts = Array.isArray(body.content) ? body.content : [];
    const text = parts
      .flatMap((part) =>
        part &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
          ? [(part as { text: string }).text]
          : [],
      )
      .join('');
    if (!text.trim()) throw new AssistantProviderError('bad_response', 'empty reply');
    return {
      output: text,
      usage: {
        inputTokens: count(body.usage?.input_tokens),
        outputTokens: count(body.usage?.output_tokens),
      },
    };
  }
}
