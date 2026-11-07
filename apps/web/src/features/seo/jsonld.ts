import { absoluteUrl } from './site';
import { SITE_NAME } from './meta';

/*
 * schema.org structured data (docs/seo.md#structured-data). Each builder
 * describes only what the page visibly shows: no ratings, prices, offers or
 * availability are ever added. FAQPage isn't used: FAQ rich results are
 * limited to authoritative government and health sites.
 */

const CONTEXT = 'https://schema.org';

export function organizationLd(site: string) {
  return {
    '@context': CONTEXT,
    '@type': 'Organization',
    '@id': `${site}/#organization`,
    name: SITE_NAME,
    url: `${site}/`,
    logo: absoluteUrl(site, '/media/og/logo.png'),
  };
}

export function websiteLd(site: string) {
  return {
    '@context': CONTEXT,
    '@type': 'WebSite',
    '@id': `${site}/#website`,
    name: SITE_NAME,
    url: `${site}/`,
    inLanguage: 'en-IN',
    publisher: { '@id': `${site}/#organization` },
  };
}

export interface Crumb {
  name: string;
  /** Path of the page; the last crumb (the current page) may omit it. */
  path?: string;
}

export function breadcrumbLd(site: string, crumbs: Crumb[]) {
  return {
    '@context': CONTEXT,
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      ...(c.path ? { item: absoluteUrl(site, c.path) } : {}),
    })),
  };
}

export function articleLd(
  site: string,
  a: {
    path: string;
    headline: string;
    description: string;
    imagePath: string | null;
    author: string;
    publishedAt: string;
    modifiedAt: string;
    about: { name: string; path: string }[];
  },
) {
  return {
    '@context': CONTEXT,
    '@type': 'Article',
    headline: a.headline.slice(0, 110),
    description: a.description,
    mainEntityOfPage: absoluteUrl(site, a.path),
    ...(a.imagePath ? { image: [absoluteUrl(site, a.imagePath)] } : {}),
    datePublished: a.publishedAt,
    dateModified: a.modifiedAt,
    // The byline names a person on Wayora's staff; the publisher is Wayora.
    author: { '@type': 'Person', name: a.author },
    publisher: { '@id': `${site}/#organization` },
    ...(a.about.length
      ? {
          about: a.about.map((d) => ({
            '@type': 'TouristDestination',
            name: d.name,
            url: absoluteUrl(site, d.path),
          })),
        }
      : {}),
  };
}

export function touristDestinationLd(
  site: string,
  d: {
    path: string;
    name: string;
    description: string;
    country: string;
    imagePath: string | null;
    /** Places listed on the page. */
    attractions: { name: string; description: string }[];
  },
) {
  return {
    '@context': CONTEXT,
    '@type': 'TouristDestination',
    name: d.name,
    description: d.description,
    url: absoluteUrl(site, d.path),
    ...(d.imagePath ? { image: absoluteUrl(site, d.imagePath) } : {}),
    containedInPlace: { '@type': 'Country', name: d.country },
    ...(d.attractions.length
      ? {
          includesAttraction: d.attractions.map((a) => ({
            '@type': 'TouristAttraction',
            name: a.name,
            description: a.description,
          })),
        }
      : {}),
  };
}

export function collectionPageLd(
  site: string,
  c: { path: string; name: string; description: string; items: { name: string; path: string }[] },
) {
  return {
    '@context': CONTEXT,
    '@type': 'CollectionPage',
    name: c.name,
    description: c.description,
    url: absoluteUrl(site, c.path),
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: c.items.map((item, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: item.name,
        url: absoluteUrl(site, item.path),
      })),
    },
  };
}
