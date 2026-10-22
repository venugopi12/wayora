import type { SearchResult, SearchServiceType } from '@wayora/contracts';

/*
 * Offer integrity rules (docs/search.md#offer-validation), applied when a
 * provider's results are accepted and again whenever a stored session is
 * read back, so a tampered or corrupted session is never served.
 *
 * Price rules (one currency per price, ranges not inverted, integer minor
 * units) are part of the shared result schema itself.
 */

/** An offer id as Wayora issues it: `<providerId>:<offerRef>`. */
export interface ParsedOfferId {
  providerId: string;
  offerRef: string;
}

/** Splits an offer id at its first `:`; null when it can't be a Wayora offer id. */
export function parseOfferId(id: string): ParsedOfferId | null {
  const colon = id.indexOf(':');
  if (colon <= 0 || colon === id.length - 1) return null;
  return { providerId: id.slice(0, colon), offerRef: id.slice(colon + 1) };
}

/**
 * Why a result can't be trusted as an offer of `serviceType` from
 * `providerId`, or null when it can.
 */
export function integrityProblem(
  result: SearchResult,
  expected: { serviceType: SearchServiceType; providerId?: string },
): string | null {
  if (result.serviceType !== expected.serviceType) return 'category does not match the search';
  if (expected.providerId !== undefined && result.providerId !== expected.providerId) {
    return 'provider does not match';
  }
  if (result.id !== `${result.providerId}:${result.offerRef}`) {
    return 'id is not <providerId>:<offerRef>';
  }
  return null;
}
