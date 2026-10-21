import type { DestinationRegion, TravelCategorySlug, TravelMoodSlug } from '@wayora/contracts';
import { DISCOVER, serviceBySlug } from '../navigation/config';

/** Id of the results section, so links and the hero search can jump to it. */
export const COLLECTION_ID = 'collection';

export function destinationPath(slug: string): string {
  return `${DISCOVER.path}/${slug}`;
}

/** /discover with filters applied, optionally jumping to the results. */
export function discoverPath(
  {
    query,
    mood,
    region,
  }: { query?: string; mood?: TravelMoodSlug; region?: DestinationRegion } = {},
  { toResults = false }: { toResults?: boolean } = {},
): string {
  const params = new URLSearchParams();
  if (query?.trim()) params.set('q', query.trim());
  if (mood) params.set('mood', mood);
  if (region) params.set('region', region);
  const search = params.toString();
  return `${DISCOVER.path}${search ? `?${search}` : ''}${toResults ? `#${COLLECTION_ID}` : ''}`;
}

/**
 * A service page with the destination as context, e.g. /flights?to=goa.
 * The service's demo search page prefills the destination where it can.
 */
export function servicePathFor(service: TravelCategorySlug, destinationSlug: string): string {
  return `${serviceBySlug[service].path}?to=${encodeURIComponent(destinationSlug)}`;
}

const ARRIVE_BY: ReadonlySet<TravelCategorySlug> = new Set(['flights', 'trains', 'buses']);

/** "Flights to Goa", "Hotels in Goa", "Holiday packages in Goa". */
export function serviceForPlace(service: TravelCategorySlug, place: string): string {
  return `${serviceBySlug[service].name} ${ARRIVE_BY.has(service) ? 'to' : 'in'} ${place}`;
}
