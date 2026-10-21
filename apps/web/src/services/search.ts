import {
  offerResponseSchema,
  searchResponseSchema,
  type OfferResponse,
  type SearchRequestInput,
  type SearchResponse,
  type SearchServiceType,
} from '@wayora/contracts';
import { api } from './api';

/**
 * POST /api/v1/search/:serviceType. The response is validated against the
 * shared contract; `signal` cancels the request when a newer search replaces it.
 */
export function searchTravel(
  request: SearchRequestInput,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const { serviceType, ...body } = request;
  return api.request(`/search/${serviceType}`, {
    method: 'POST',
    body,
    schema: searchResponseSchema,
    timeoutMs: 15_000,
    reportsSessionEnd: false,
    ...(signal ? { signal } : {}),
  });
}

/**
 * GET /api/v1/search/:serviceType/sessions/:searchId/offer?id=… — one result
 * from the server's stored search. The price and details come from the
 * server, never from the URL or the results page.
 */
export function fetchOffer(
  serviceType: SearchServiceType,
  searchId: string,
  resultId: string,
  signal?: AbortSignal,
): Promise<OfferResponse> {
  const query = new URLSearchParams({ id: resultId });
  return api.request(
    `/search/${serviceType}/sessions/${encodeURIComponent(searchId)}/offer?${query.toString()}`,
    {
      schema: offerResponseSchema,
      reportsSessionEnd: false,
      ...(signal ? { signal } : {}),
    },
  );
}
