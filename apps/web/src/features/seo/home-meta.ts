import { organizationLd, websiteLd } from './jsonld';
import { DEFAULT_DESCRIPTION, type PageMeta } from './meta';

/*
 * The home page's metadata, on its own so the home page (in the start-up
 * bundle) doesn't pull in pages.ts and the help and catalogue data it builds
 * other pages from (docs/pwa.md#performance).
 */
export function homeMeta(site: string): PageMeta {
  return {
    title: null,
    description: DEFAULT_DESCRIPTION,
    canonicalPath: '/',
    robots: 'index, follow',
    jsonLd: [organizationLd(site), websiteLd(site)],
  };
}
