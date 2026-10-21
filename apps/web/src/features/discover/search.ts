/**
 * Search, filtering and recommendations over the SAMPLE destination dataset.
 * Pure functions, no network: a discovery API can replace them later without
 * changing the components that call them.
 */
import type { DestinationSummary, DestinationRegion, TravelMoodSlug } from '@wayora/contracts';
import { DESTINATIONS, regionBySlug } from './data';

/** Lower-cases, strips accents and collapses spaces, so "Kyōto " matches "kyoto". */
export function normalizeSearch(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function searchableText(d: DestinationSummary): string[] {
  return [d.name, d.country, d.locality ?? '', regionBySlug[d.region].name, ...d.aliases]
    .filter(Boolean)
    .map(normalizeSearch);
}

/**
 * Case-insensitive, partial matching on name, country, locality, region and
 * aliases. Ranking: name starts with the query, then any word starts with it,
 * then the query appears anywhere. Ties keep dataset order. An empty query
 * returns the source unchanged.
 */
export function searchDestinations(
  query: string,
  source: readonly DestinationSummary[] = DESTINATIONS,
): DestinationSummary[] {
  const q = normalizeSearch(query);
  if (!q) return [...source];
  const ranked: { d: DestinationSummary; score: number; index: number }[] = [];
  source.forEach((d, index) => {
    const name = normalizeSearch(d.name);
    const haystack = searchableText(d);
    let score: number | null = null;
    if (name.startsWith(q)) score = 0;
    else if (haystack.some((h) => h.split(' ').some((word) => word.startsWith(q)))) score = 1;
    else if (haystack.some((h) => h.includes(q))) score = 2;
    if (score !== null) ranked.push({ d, score, index });
  });
  return ranked.sort((a, b) => a.score - b.score || a.index - b.index).map((x) => x.d);
}

export interface DestinationFilters {
  query?: string;
  mood?: TravelMoodSlug;
  region?: DestinationRegion;
}

/** Applies mood and region filters, then the text search (which also orders results). */
export function filterDestinations(
  { query = '', mood, region }: DestinationFilters,
  source: readonly DestinationSummary[] = DESTINATIONS,
): DestinationSummary[] {
  const narrowed = source.filter(
    (d) => (!mood || d.categories.includes(mood)) && (!region || d.region === region),
  );
  return searchDestinations(query, narrowed);
}

export function hasActiveFilters({ query, mood, region }: DestinationFilters): boolean {
  return Boolean(query?.trim() || mood || region);
}

export function findDestination(
  slug: string | undefined,
  source: readonly DestinationSummary[] = DESTINATIONS,
): DestinationSummary | undefined {
  return slug ? source.find((d) => d.slug === slug) : undefined;
}

/**
 * Related destinations from the local dataset: two points per shared mood,
 * one for the same region. Only destinations with something in common are
 * returned (no filler), best first, ties in dataset order.
 */
export function relatedDestinations(
  destination: DestinationSummary,
  {
    limit = 3,
    source = DESTINATIONS,
  }: { limit?: number; source?: readonly DestinationSummary[] } = {},
): DestinationSummary[] {
  return source
    .map((d, index) => {
      if (d.slug === destination.slug) return null;
      const shared = d.categories.filter((c) => destination.categories.includes(c)).length;
      const score = shared * 2 + (d.region === destination.region ? 1 : 0);
      return score > 0 ? { d, score, index } : null;
    })
    .filter((x): x is { d: DestinationSummary; score: number; index: number } => x !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((x) => x.d);
}

/** For an unknown slug: destinations whose name or aliases resemble it. */
export function suggestForSlug(
  slug: string,
  source: readonly DestinationSummary[] = DESTINATIONS,
): DestinationSummary[] {
  const words = normalizeSearch(slug.replace(/[-_]+/g, ' ')).split(' ').filter(Boolean);
  const found = new Map<string, DestinationSummary>();
  for (const word of words) {
    // Try progressively shorter prefixes so "jaipurr" or "kyot" still find a match.
    for (let len = word.length; len >= Math.min(3, word.length); len -= 1) {
      const hits = searchDestinations(word.slice(0, len), source);
      if (hits.length) {
        hits.forEach((d) => found.set(d.slug, d));
        break;
      }
    }
  }
  return [...found.values()].slice(0, 3);
}
