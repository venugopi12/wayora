import type { DestinationSummary, TravelMoodSlug } from '@wayora/contracts';
import { DESTINATIONS } from './data';

/*
 * Destination themes (docs/seo.md#destination-urls): readable, indexable
 * pages at /discover/themes/:slug over the editorial moods and the
 * international regions of the sample dataset. Editorial groupings, not
 * popularity. There's no adventure theme: no destination data supports it.
 */

export interface Theme {
  slug: string;
  title: string;
  /** One sentence for cards and the meta description. */
  description: string;
  matches: (d: DestinationSummary) => boolean;
}

const byMood = (mood: TravelMoodSlug) => (d: DestinationSummary) => d.categories.includes(mood);

export const THEMES: readonly Theme[] = [
  {
    slug: 'beach-destinations',
    title: 'Beach destinations',
    description:
      'Coastlines for slow days and sunsets: beach destinations in Wayora’s Discover collection.',
    matches: byMood('beach-escapes'),
  },
  {
    slug: 'hill-stations',
    title: 'Hill stations and mountains',
    description:
      'Cool air, valleys and mountain towns: hill stations and mountain retreats in Wayora’s Discover collection.',
    matches: byMood('mountain-retreats'),
  },
  {
    slug: 'heritage',
    title: 'Heritage and culture',
    description:
      'Forts, temples, old quarters and living traditions: heritage destinations in Wayora’s Discover collection.',
    matches: byMood('cultural-journeys'),
  },
  {
    slug: 'nature-and-wellness',
    title: 'Nature and wellness',
    description:
      'Green landscapes and restful places: nature and wellness destinations in Wayora’s Discover collection.',
    matches: byMood('nature-wellness'),
  },
  {
    slug: 'city-breaks',
    title: 'City breaks',
    description: 'Food, neighbourhoods and nightlife: city breaks in Wayora’s Discover collection.',
    matches: byMood('city-breaks'),
  },
  {
    slug: 'weekend-getaways',
    title: 'Weekend getaways',
    description:
      'Short-trip favourites that suit a long weekend: getaways in Wayora’s Discover collection.',
    matches: byMood('weekend-getaways'),
  },
  {
    slug: 'international',
    title: 'International destinations',
    description:
      'Southeast Asia, East Asia and the Middle East: international destinations in Wayora’s Discover collection.',
    matches: (d) => d.region !== 'india',
  },
];

export const themePath = (slug: string) => `/discover/themes/${slug}`;
export const findTheme = (slug: string | undefined) => THEMES.find((t) => t.slug === slug);
export const destinationsFor = (theme: Theme) => DESTINATIONS.filter(theme.matches);
/** Themes with at least two destinations (no thin pages). */
export const PUBLISHED_THEMES = THEMES.filter((t) => destinationsFor(t).length >= 2);
