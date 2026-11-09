import type { PageMeta } from './meta';

/*
 * Metadata for simple pages, on its own so pages in the start-up bundle (the
 * home page's offers, about) don't pull in pages.ts and the data it builds
 * other pages from (docs/pwa.md#performance).
 */

export function simpleMeta(path: string, title: string, description: string): PageMeta {
  return { title, description, canonicalPath: path, robots: 'index, follow' };
}

export const promotionsMeta = () =>
  simpleMeta(
    '/promotions',
    'Offers and coupons',
    'Promotions running on Wayora now, with their terms. Eligibility is checked at payment.',
  );

export const aboutMeta = () =>
  simpleMeta(
    '/about',
    'About Wayora',
    'Wayora brings flights, hotels, trains, buses, metro, cabs and holiday packages into one booking experience.',
  );

/** For pages that don't exist: never indexed. */
export function notFoundMeta(title = 'Page not found'): PageMeta {
  return {
    title,
    description: 'This page doesn’t exist on Wayora.',
    canonicalPath: null,
    robots: 'noindex, follow',
  };
}
