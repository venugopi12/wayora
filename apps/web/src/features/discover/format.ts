import type { DestinationSummary } from '@wayora/contracts';
import { regionBySlug } from './data';

/**
 * Where a destination is, in one short line: "Rajasthan, India", "Indonesia",
 * or the region for city-states ("Southeast Asia" for Singapore).
 */
export function placeLine(
  d: Pick<DestinationSummary, 'name' | 'country' | 'locality' | 'region'>,
): string {
  if (d.country === d.name) return regionBySlug[d.region].name;
  return d.locality ? `${d.locality}, ${d.country}` : d.country;
}
