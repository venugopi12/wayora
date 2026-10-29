import { ProviderError } from './provider.js';

/*
 * HTTP for live supplier adapters (Phase 22, docs/providers.md#http-providerhttpclient).
 *
 * One small helper so every live adapter treats suppliers the same way:
 *
 * - The adapter builds the URL from its configured base and passes the
 *   attempt's `signal`; the search resilience layer owns time limits,
 *   retries (transient failures of reads only) and the circuit breaker.
 * - Status codes become ProviderError kinds: 408/425/429/5xx and dropped
 *   connections are `unavailable` and transient (worth one retry); 401/403
 *   (credentials), other 4xx (a request the supplier rejects) and unusable
 *   bodies are `error` and never retried.
 * - Error messages carry the provider id, method, path and status only:
 *   never the query string, headers, credentials or the supplier's body.
 *   Error bodies are not read at all.
 * - Success bodies must be JSON, within a size limit; what they contain is
 *   the adapter's job to validate (a schema) before mapping it.
 *
 * Booking or payment calls must not go through `retry`-able paths: this
 * helper never retries by itself, and adapters declare only read operations
 * (search, revalidate) to the resilience layer as idempotent.
 */

export interface ProviderHttpRequest {
  method?: 'GET' | 'POST';
  /** Absolute URL from the adapter's configured base. */
  url: string;
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** Auth and supplier-specific headers. Never logged. */
  headers?: Readonly<Record<string, string>>;
  /** Sent as JSON. */
  body?: unknown;
  signal: AbortSignal;
  /** Statuses to return instead of throwing (e.g. 404 = "offer gone" on revalidation). */
  acceptStatuses?: readonly number[];
  /** Largest response body accepted (default 2 MB). */
  maxBytes?: number;
}

export interface ProviderHttpResponse {
  status: number;
  /** Parsed JSON for 2xx; null for an accepted non-2xx status (body not read). */
  body: unknown;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface ProviderHttpClientOptions {
  providerId: string;
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** "GET /v1/offers": method and path only, for messages and logs. */
function describe(method: string, url: string): string {
  try {
    return `${method} ${new URL(url).pathname}`;
  } catch {
    return method;
  }
}

/** Maps an HTTP status to a ProviderError (never including the response body). */
export function providerErrorForStatus(
  providerId: string,
  what: string,
  status: number,
): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError(
      'error',
      `${providerId}: ${what} refused the credentials (${status})`,
      {
        transient: false,
      },
    );
  }
  if (TRANSIENT_STATUSES.has(status) || status >= 500) {
    return new ProviderError('unavailable', `${providerId}: ${what} answered ${status}`, {
      transient: true,
    });
  }
  return new ProviderError('error', `${providerId}: ${what} rejected the request (${status})`, {
    transient: false,
  });
}

export class ProviderHttpClient {
  readonly providerId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ProviderHttpClientOptions) {
    this.providerId = options.providerId;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async requestJson(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    const method = request.method ?? 'GET';
    const url = new URL(request.url);
    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const what = describe(method, request.url);
    const headers: Record<string, string> = { accept: 'application/json', ...request.headers };
    if (request.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
        signal: request.signal,
        redirect: 'error',
      });
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason ?? error;
      throw new ProviderError('unavailable', `${this.providerId}: ${what} could not be reached`, {
        transient: true,
      });
    }

    if (!response.ok) {
      // Error bodies are never read: they may echo the request or hold supplier detail.
      await response.body?.cancel().catch(() => undefined);
      if (request.acceptStatuses?.includes(response.status)) {
        return { status: response.status, body: null };
      }
      throw providerErrorForStatus(this.providerId, what, response.status);
    }

    const type = response.headers.get('content-type') ?? '';
    if (!/\bjson\b/i.test(type)) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderError('error', `${this.providerId}: ${what} did not answer with JSON`);
    }
    const max = request.maxBytes ?? DEFAULT_MAX_BYTES;
    const declared = Number(response.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > max) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderError('error', `${this.providerId}: ${what} answer is too large`);
    }
    let text: string;
    try {
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > max) {
        throw new ProviderError('error', `${this.providerId}: ${what} answer is too large`);
      }
      text = new TextDecoder().decode(bytes);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (request.signal.aborted) throw request.signal.reason ?? error;
      throw new ProviderError('unavailable', `${this.providerId}: ${what} answer was cut off`, {
        transient: true,
      });
    }
    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      throw new ProviderError('error', `${this.providerId}: ${what} answered malformed JSON`);
    }
  }
}
