import type { DestinationSummary, TravelCategorySlug } from '@wayora/contracts';

/**
 * Services worth offering for a destination (demo search and demo booking).
 * Rail and road are offered for the India samples only. A service chosen on
 * the homepage moves to the front when it applies here, and is otherwise not
 * offered (no "trains to Bali"). Pure: also used by the prerender.
 */
export function travelOptionsFor(
  destination: Pick<DestinationSummary, 'region'>,
  preferred?: TravelCategorySlug,
): TravelCategorySlug[] {
  const base: TravelCategorySlug[] =
    destination.region === 'india'
      ? ['flights', 'trains', 'hotels', 'buses', 'cabs', 'holidays']
      : ['flights', 'hotels', 'cabs', 'holidays'];
  if (!preferred || !base.includes(preferred)) return base;
  return [preferred, ...base.filter((s) => s !== preferred)];
}
