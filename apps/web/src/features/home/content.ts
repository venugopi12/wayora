/**
 * Homepage selections from the shared Discover content
 * (features/discover/data.ts). The homepage shows a subset; Discover shows
 * everything. SAMPLE CONTENT: inspiration, not inventory.
 */
import type { DestinationSummary } from '@wayora/contracts';
import { HOMEPAGE_FEATURED, HOMEPAGE_MOODS, moodBySlug, type Mood } from '../discover/data';
import { findDestination } from '../discover/search';

export const HOME_MOODS: readonly Mood[] = HOMEPAGE_MOODS.map((slug) => moodBySlug[slug]);

export const FEATURED_DESTINATIONS: readonly DestinationSummary[] = HOMEPAGE_FEATURED.map(
  (slug) => {
    const destination = findDestination(slug);
    if (!destination) throw new Error(`HOMEPAGE_FEATURED references unknown destination "${slug}"`);
    return destination;
  },
);
