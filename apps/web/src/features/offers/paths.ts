import { searchServiceTypeSchema, type SearchServiceType } from '@wayora/contracts';
import { serviceBySlug } from '../navigation/config';

/*
 * Offer page URLs (docs/search.md#offer-details):
 *
 *   /offers/:serviceType/:resultId?sid=<searchId>&from=<results query>
 *
 * - `resultId` is the result's id from the search (URL-encoded).
 * - `sid` names the stored search the offer is read from (server side).
 * - `from` is the results page's query string (search, filters, sort,
 *   page), so "Back to results" and "Refresh" restore the same context. It is
 *   only ever appended to the category's own fixed path, never used as a
 *   URL by itself, so it can't redirect anywhere else.
 */

export const OFFER_PATH = '/offers/:serviceType/:resultId';

export function offerPath(
  serviceType: SearchServiceType,
  resultId: string,
  searchId: string,
  resultsSearch: string,
): string {
  const query = new URLSearchParams({ sid: searchId, from: resultsSearch.replace(/^\?/, '') });
  return `/offers/${serviceType}/${encodeURIComponent(resultId)}?${query.toString()}`;
}

/** The results page to return to: the category's path plus the preserved query. */
export function resultsPathFor(serviceType: SearchServiceType, from: string | null): string {
  const base = serviceBySlug[serviceType].path;
  if (!from) return base;
  // Re-serialize: only query parameters survive, whatever `from` contains.
  const query = new URLSearchParams(from).toString();
  return query ? `${base}?${query}` : base;
}

/** Validated route parameters of an offer page. */
export function readOfferParams(
  params: { serviceType?: string; resultId?: string },
  search: URLSearchParams,
):
  | {
      ok: true;
      serviceType: SearchServiceType;
      resultId: string;
      searchId: string | null;
      from: string | null;
    }
  | { ok: false } {
  const type = searchServiceTypeSchema.safeParse(params.serviceType);
  const resultId = params.resultId ?? '';
  if (!type.success || !/^[\x21-\x7e]{1,200}$/.test(resultId)) return { ok: false };
  const sid = search.get('sid');
  const searchId =
    sid && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid) ? sid : null;
  return { ok: true, serviceType: type.data, resultId, searchId, from: search.get('from') };
}
