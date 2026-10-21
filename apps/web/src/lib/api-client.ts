import type { z } from 'zod';
import {
  API_V1_PREFIX,
  REQUEST_ID_HEADER,
  apiErrorEnvelopeSchema,
  apiSuccessEnvelopeSchema,
  type ApiErrorCode,
  type ValidationIssue,
} from '@wayora/contracts';

/** Client-side error codes for failures that never produced an API envelope. */
export type ClientErrorCode = 'NETWORK_ERROR' | 'TIMEOUT' | 'INVALID_RESPONSE';

export class ApiClientError extends Error {
  constructor(
    readonly code: ApiErrorCode | ClientErrorCode,
    message: string,
    readonly status: number | null,
    readonly requestId: string | null = null,
    readonly details: ValidationIssue[] = [],
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export interface RequestOptions<T extends z.ZodType> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Response `data` schema — every response is validated at runtime. */
  schema: T;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Non-2xx statuses whose body is still a success envelope (e.g. 503 from readiness). */
  acceptStatuses?: number[];
  /**
   * Set to false where a 401 is an expected answer rather than a lost
   * session (sign-in with wrong credentials, the initial "who am I" check),
   * so `onSessionEnded` isn't triggered.
   */
  reportsSessionEnd?: boolean;
}

export interface ApiClientOptions {
  fetchImpl?: typeof fetch;
  /**
   * Cookie mode. The session cookie is HttpOnly and sent by the browser
   * itself; it is never read or stored by this code. Use `include` when the
   * API is on another origin (e.g. localhost:4000 in development).
   */
  credentials?: RequestCredentials;
  /** Called when an authenticated request comes back 401 (session expired or revoked). */
  onSessionEnded?: () => void;
}

export interface ApiClient {
  readonly baseUrl: string;
  request<T extends z.ZodType>(path: string, options: RequestOptions<T>): Promise<z.output<T>>;
}

/**
 * Small typed fetch wrapper for the Wayora API:
 * - prefixes /api/v1, sends JSON, applies a timeout,
 * - validates the success envelope with the caller's Zod schema,
 * - converts error envelopes and transport failures into ApiClientError,
 * - reports a 401 on an authenticated call once, through `onSessionEnded`.
 */
export function createApiClient(
  baseUrl: string,
  options: ApiClientOptions | typeof fetch = {},
): ApiClient {
  const {
    fetchImpl,
    credentials = 'same-origin',
    onSessionEnded,
  } = typeof options === 'function' ? { fetchImpl: options } : options;
  return {
    baseUrl,
    async request(
      path,
      {
        method = 'GET',
        body,
        schema,
        signal,
        timeoutMs = 10_000,
        acceptStatuses = [],
        reportsSessionEnd = true,
      },
    ) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      let response: Response;
      try {
        // Resolve fetch per call (not at import) so polyfills and test stubs apply.
        const doFetch = fetchImpl ?? globalThis.fetch;
        response = await doFetch(`${baseUrl}${API_V1_PREFIX}${path}`, {
          method,
          signal: combined,
          credentials,
          headers: {
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (error) {
        if (signal?.aborted) throw error; // caller cancelled (e.g. React Query) — rethrow as-is
        if (timeout.aborted) {
          throw new ApiClientError('TIMEOUT', 'The server took too long to respond.', null);
        }
        throw new ApiClientError('NETWORK_ERROR', 'Could not reach the Wayora API.', null);
      }

      const requestId = response.headers.get(REQUEST_ID_HEADER);
      const json: unknown = await response.json().catch(() => undefined);

      if (response.ok || acceptStatuses.includes(response.status)) {
        const parsed = apiSuccessEnvelopeSchema(schema).safeParse(json);
        if (!parsed.success) {
          throw new ApiClientError(
            'INVALID_RESPONSE',
            'The API returned an unexpected response.',
            response.status,
            requestId,
          );
        }
        return (parsed.data as { data: z.output<typeof schema> }).data;
      }

      const parsedError = apiErrorEnvelopeSchema.safeParse(json);
      if (parsedError.success) {
        const { code, message, requestId: id, details } = parsedError.data.error;
        if (response.status === 401 && reportsSessionEnd) onSessionEnded?.();
        throw new ApiClientError(code, message, response.status, id, details ?? []);
      }
      throw new ApiClientError(
        'INVALID_RESPONSE',
        `The API responded with HTTP ${response.status}.`,
        response.status,
        requestId,
      );
    },
  };
}
