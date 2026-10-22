import { vi } from 'vitest';
import {
  DEMO_DATA_DISCLAIMER,
  offerResponseSchema,
  searchResponseSchema,
  type OfferResponse,
  type ProviderStatus,
  type SearchFacets,
  type SearchResponse,
  type SearchResult,
} from '@wayora/contracts';
import { flightFacets } from './search-fixtures';

/*
 * A stand-in for the search API, installed as `fetch`:
 *   POST /api/v1/search/:serviceType                     → queued or default reply
 *   GET  /api/v1/search/:serviceType/sessions/:id/offer  → a result of a search it answered
 * Responses are built from the shared contract and validated against it, so
 * the UI is tested against the real response shapes. The API's own
 * behaviour is covered by apps/api/test/search-*.test.ts.
 */

export interface SearchCall {
  serviceType: string;
  body: Record<string, unknown>;
  signal: AbortSignal | undefined;
}

type OfferReply =
  | { kind: 'error'; status: number; code: string; message: string }
  | { kind: 'transform'; transform: (offer: OfferResponse) => OfferResponse };

type Reply =
  | { kind: 'ok'; response: SearchResponse }
  | { kind: 'error'; status: number; code: string; message: string }
  | { kind: 'network' };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let nextSearch = 1;
const newSearchId = () => `01890000-0000-7000-8000-${String((nextSearch += 1)).padStart(12, '0')}`;

const okStatus = (count: number): ProviderStatus => ({
  providerId: 'demo-provider',
  providerName: 'Wayora demo provider',
  kind: 'demo',
  status: count > 0 ? 'success' : 'empty',
  resultCount: count,
  durationMs: 3,
  message: null,
});

export function searchResponse(
  results: SearchResult[],
  {
    statuses,
    page = 1,
    pageSize = 10,
    total,
    facets,
    searchId = newSearchId(),
    expiresAt = '2030-01-01T10:10:00Z',
  }: {
    statuses?: ProviderStatus[];
    page?: number;
    pageSize?: number;
    total?: number;
    facets?: SearchFacets;
    searchId?: string;
    /** When the session ends (far in the future unless a test needs it to pass). */
    expiresAt?: string;
  } = {},
): SearchResponse {
  const totalResults = total ?? results.length;
  const providerStatuses = statuses ?? [okStatus(results.length)];
  const failed = providerStatuses.filter((s) => s.status !== 'success' && s.status !== 'empty');
  const flights = results.filter((r) => r.serviceType === 'flights');
  return searchResponseSchema.parse({
    searchId,
    serviceType: results[0]?.serviceType ?? 'flights',
    results,
    pagination: { page, pageSize, totalResults, totalPages: Math.ceil(totalResults / pageSize) },
    providerStatuses,
    dataSource: results.length ? 'demo' : 'none',
    disclaimer: DEMO_DATA_DISCLAIMER,
    warnings: [
      { code: 'DEMO_DATA', message: DEMO_DATA_DISCLAIMER },
      ...(failed.length
        ? [{ code: 'PARTIAL_RESULTS', message: 'Some providers didn’t answer.' }]
        : []),
    ],
    generatedAt: '2026-10-21T10:00:00Z',
    expiresAt,
    facets:
      facets ??
      (flights.length === results.length
        ? flightFacets(flights)
        : { price: null, durationMinutes: null, options: {} }),
  });
}

export function installFakeSearchApi(
  defaultReply: Reply = { kind: 'ok', response: searchResponse([]) },
) {
  const calls: SearchCall[] = [];
  const offerCalls: string[] = [];
  const queue: { reply: Reply; gate?: Promise<void> }[] = [];
  const offerQueue: OfferReply[] = [];
  /** Searches the fake has answered, by searchId (like the API's session store). */
  const sessions = new Map<string, SearchResponse>();
  let defaultResponse = defaultReply;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const signal = init?.signal ?? undefined;

    const offer = /^\/api\/v1\/search\/([a-z]+)\/sessions\/([^/]+)\/offer$/.exec(url.pathname);
    if (offer && (init?.method ?? 'GET') === 'GET') {
      const id = url.searchParams.get('id') ?? '';
      offerCalls.push(`${offer[1]}|${decodeURIComponent(offer[2]!)}|${id}`);
      const error = (status: number, code: string, message: string) =>
        json(status, { error: { code, message, requestId: 'req-offer-1' } });
      const queued = offerQueue.shift();
      if (queued?.kind === 'error') return error(queued.status, queued.code, queued.message);
      // Same order of checks as the API (docs/search.md#offer-validation).
      const session = sessions.get(decodeURIComponent(offer[2]!));
      if (!session) {
        return error(
          410,
          'SEARCH_EXPIRED',
          'This search has expired. Search again to see current results.',
        );
      }
      if (session.serviceType !== offer[1]) {
        return error(409, 'CATEGORY_MISMATCH', `This search is for ${session.serviceType}.`);
      }
      const result = session.results.find((r) => r.id === id);
      if (!result) {
        return error(404, 'OFFER_NOT_IN_SEARCH', "That offer isn't part of this search.");
      }
      const data: OfferResponse = offerResponseSchema.parse({
        searchId: session.searchId,
        serviceType: session.serviceType,
        result,
        disclaimer: result.source === 'demo' ? DEMO_DATA_DISCLAIMER : null,
        generatedAt: session.generatedAt,
        expiresAt: session.expiresAt,
        validation: { status: 'session', checkedAt: null, previousPrice: null },
      });
      const body =
        queued?.kind === 'transform' ? offerResponseSchema.parse(queued.transform(data)) : data;
      return json(200, { data: body, meta: { requestId: 'req-1' } });
    }

    const match = /^\/api\/v1\/search\/([a-z]+)$/.exec(url.pathname);
    // Everything else (catalog, /auth/session…) behaves as offline, like other web tests.
    if (!match) throw new TypeError('offline');
    calls.push({
      serviceType: match[1]!,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      signal,
    });
    const next = queue.shift() ?? { reply: defaultResponse };
    if (next.gate) {
      await Promise.race([
        next.gate,
        new Promise((_, reject) =>
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true }),
        ),
      ]);
    }
    const { reply } = next;
    if (reply.kind === 'network') throw new TypeError('Failed to fetch');
    if (reply.kind === 'error') {
      return json(reply.status, {
        error: { code: reply.code, message: reply.message, requestId: 'req-1' },
      });
    }
    sessions.set(reply.response.searchId, reply.response);
    return json(200, { data: reply.response, meta: { requestId: 'req-1' } });
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    calls,
    offerCalls,
    sessions,
    /** Change the reply used when nothing is queued. */
    setDefault(reply: Reply) {
      defaultResponse = reply;
    },
    /** Queue the reply for the next offer request (an API error, or a change to the answer). */
    nextOffer(reply: OfferReply) {
      offerQueue.push(reply);
    },
    /** Queue the reply for the next search request. */
    next(reply: Reply) {
      queue.push({ reply });
    },
    /** Queue a reply that waits until the returned function is called. */
    nextHeld(reply: Reply): () => void {
      let release!: () => void;
      queue.push({ reply, gate: new Promise<void>((r) => (release = r)) });
      return () => release();
    },
  };
}
