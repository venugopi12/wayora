import {
  CONTENT_TYPE_LABEL,
  HELP_ARTICLES,
  HELP_CATEGORIES,
  PLANNER_CATALOG,
  TRAVEL_CATEGORIES,
  type ContentBlock,
  type Destination,
  type DestinationSummary,
  type PublicContent,
  type TravelCategorySlug,
} from '@wayora/contracts';
import { DESTINATIONS, regionBySlug } from '../discover/data';
import { withDetails } from '../discover/details';
import { PUBLISHED_THEMES, destinationsFor, themePath, type Theme } from '../discover/themes';
import { travelOptionsFor } from '../discover/travel';
import {
  breadcrumbLd,
  articleLd,
  collectionPageLd,
  touristDestinationLd,
  type Crumb,
} from './jsonld';
import { HERO_LAYERS } from '../home/media';
import { homeMeta } from './home-meta';
import { aboutMeta, notFoundMeta, promotionsMeta, simpleMeta } from './simple-meta';
import { DEFAULT_DESCRIPTION, clip, escapeHtml, type PageMeta } from './meta';

/*
 * Every public, indexable page in one place (docs/seo.md#rendering):
 * its metadata (used by the React page and the prerender), the semantic HTML
 * the prerender puts in the page body before the app loads, and its sitemap
 * entry. Pure: no browser or build APIs. Content comes from the same records
 * the pages render: the destination dataset, the planner catalogue, the Help
 * Center and published CMS content.
 */

export const destinationPathOf = (slug: string) => `/discover/${slug}`;
export const helpPath = '/help';
export const helpTopicPathOf = (c: string) => `/help/topics/${c}`;
export const helpArticlePathOf = (s: string) => `/help/articles/${s}`;
export const GUIDES_PATH = '/guides';
export const THEMES_PATH = '/discover/themes';

const DESTINATION_BY_SLUG = new Map(DESTINATIONS.map((d) => [d.slug, d]));
export const destinationBySlug = (slug: string) => DESTINATION_BY_SLUG.get(slug);

const serviceName = (s: TravelCategorySlug) => TRAVEL_CATEGORIES.find((c) => c.slug === s)!.name;
const ARRIVE_BY = new Set<TravelCategorySlug>(['flights', 'trains', 'buses']);
export const serviceLinkText = (s: TravelCategorySlug, place: string) =>
  `${serviceName(s)} ${ARRIVE_BY.has(s) ? 'to' : 'in'} ${place}`;
export const serviceSearchPath = (s: TravelCategorySlug, destination: string) =>
  `/${s}?to=${encodeURIComponent(destination)}`;

/** Catalogue categories that describe a place one visits (TouristAttraction in JSON-LD). */
const PLACE_CATEGORIES = new Set(['sightseeing', 'culture', 'nature', 'beach']);

/** Things to see and do on a destination page: the curated planner catalogue (sample planning data). */
export function attractionsFor(slug: string, max = 8) {
  const d = PLANNER_CATALOG.find((x) => x.id === slug);
  return (d?.activities ?? []).slice(0, max).map((a) => ({
    name: a.title,
    area: a.area,
    description: a.summary,
    category: a.category,
    minutes: a.typicalMinutes,
  }));
}

export const placeLineOf = (d: Pick<DestinationSummary, 'locality' | 'country' | 'region'>) =>
  [d.locality, d.region === 'india' ? null : d.country].filter(Boolean).join(', ') || d.country;

// ─── Metadata ────────────────────────────────────────────────────────────

const crumbsLd = (site: string, crumbs: Crumb[]) => breadcrumbLd(site, crumbs);

export { homeMeta };

const HERO_PRELOAD = HERO_LAYERS[0]!.portraitSrc
  ? [
      { href: HERO_LAYERS[0]!.portraitSrc, media: '(max-width: 767px)' },
      { href: HERO_LAYERS[0]!.src, media: '(min-width: 768px)' },
    ]
  : [{ href: HERO_LAYERS[0]!.src }];

export function discoverMeta(site: string): PageMeta {
  return {
    title: 'Discover destinations',
    description:
      'Beaches, hill towns, heritage cities and international getaways: explore Wayora’s curated destinations and plan the journey.',
    canonicalPath: '/discover',
    robots: 'index, follow',
    jsonLd: [crumbsLd(site, [{ name: 'Home', path: '/' }, { name: 'Discover' }])],
  };
}

export function destinationMeta(site: string, d: Destination): PageMeta {
  const path = destinationPathOf(d.slug);
  const og = d.image?.src.match(/destination-([a-z-]+)\.svg$/)
    ? `/media/og/destination-${d.slug}.jpg`
    : null;
  return {
    title: `${d.name}, ${placeLineOf(d)}`,
    description: clip(`${d.description} ${d.intro}`),
    canonicalPath: path,
    robots: 'index, follow',
    ...(og && d.image ? { image: { path: og, width: 1200, height: 630, alt: d.image.alt } } : {}),
    jsonLd: [
      crumbsLd(site, [
        { name: 'Home', path: '/' },
        { name: 'Discover', path: '/discover' },
        { name: d.name },
      ]),
      touristDestinationLd(site, {
        path,
        name: d.name,
        description: clip(d.intro, 300),
        country: d.country,
        imagePath: og,
        // Only the listed items that are places (not meals, shopping or nightlife).
        attractions: attractionsFor(d.slug)
          .filter((a) => PLACE_CATEGORIES.has(a.category))
          .map((a) => ({ name: a.name, description: a.description })),
      }),
    ],
  };
}

export function themesIndexMeta(site: string): PageMeta {
  return {
    title: 'Destination themes',
    description:
      'Browse Wayora’s destinations by theme: beaches, heritage, city breaks, weekend getaways and international trips.',
    canonicalPath: THEMES_PATH,
    robots: 'index, follow',
    jsonLd: [
      crumbsLd(site, [
        { name: 'Home', path: '/' },
        { name: 'Discover', path: '/discover' },
        { name: 'Themes' },
      ]),
    ],
  };
}

export function themeMeta(site: string, t: Theme): PageMeta {
  const path = themePath(t.slug);
  return {
    title: t.title,
    description: t.description,
    canonicalPath: path,
    robots: 'index, follow',
    jsonLd: [
      crumbsLd(site, [
        { name: 'Home', path: '/' },
        { name: 'Discover', path: '/discover' },
        { name: 'Themes', path: THEMES_PATH },
        { name: t.title },
      ]),
      collectionPageLd(site, {
        path,
        name: t.title,
        description: t.description,
        items: destinationsFor(t).map((d) => ({ name: d.name, path: destinationPathOf(d.slug) })),
      }),
    ],
  };
}

export function guidesIndexMeta(site: string): PageMeta {
  return {
    title: 'Travel guides and articles',
    description: 'Destination guides, travel articles and practical tips from the Wayora team.',
    canonicalPath: GUIDES_PATH,
    robots: 'index, follow',
    jsonLd: [crumbsLd(site, [{ name: 'Home', path: '/' }, { name: 'Guides' }])],
  };
}

const sectionCrumb = (c: Pick<PublicContent, 'type'>): Crumb =>
  c.type === 'collection'
    ? { name: 'Discover', path: '/discover' }
    : c.type === 'landing'
      ? { name: 'Discover', path: '/discover' }
      : { name: 'Guides', path: GUIDES_PATH };

export function contentMeta(site: string, c: PublicContent): PageMeta {
  const path = c.path ?? '/';
  const about = c.destinations.flatMap((s) => {
    const d = destinationBySlug(s);
    return d ? [{ name: d.name, path: destinationPathOf(s) }] : [];
  });
  const isArticle = c.type === 'guide' || c.type === 'article' || c.type === 'tip';
  const description = c.metaDescription || clip(c.summary);
  return {
    title: c.seoTitle || c.title,
    description,
    canonicalPath: path,
    robots: 'index, follow',
    ogType: isArticle ? 'article' : 'website',
    ...(c.cover ? { image: { path: c.cover.og, width: 1200, height: 630, alt: c.cover.alt } } : {}),
    ...(isArticle ? { publishedAt: c.publishedAt, modifiedAt: c.updatedAt } : {}),
    jsonLd: [
      crumbsLd(site, [{ name: 'Home', path: '/' }, sectionCrumb(c), { name: c.title }]),
      isArticle
        ? articleLd(site, {
            path,
            headline: c.title,
            description,
            imagePath: c.cover?.og ?? null,
            author: c.author,
            publishedAt: c.publishedAt,
            modifiedAt: c.updatedAt,
            about,
          })
        : collectionPageLd(site, { path, name: c.title, description, items: about }),
    ],
  };
}

export function helpMeta(site: string): PageMeta {
  return {
    title: 'Help Center',
    description:
      'Answers about Wayora bookings, payments, cancellations, refunds, rewards, coupons, your account and technical problems.',
    canonicalPath: helpPath,
    robots: 'index, follow',
    jsonLd: [crumbsLd(site, [{ name: 'Home', path: '/' }, { name: 'Help Center' }])],
  };
}

export function helpTopicMeta(site: string, slug: string): PageMeta | null {
  const c = HELP_CATEGORIES.find((x) => x.slug === slug);
  if (!c) return null;
  return {
    title: `${c.title}: help`,
    description: clip(c.description),
    canonicalPath: helpTopicPathOf(slug),
    robots: 'index, follow',
    jsonLd: [
      crumbsLd(site, [
        { name: 'Home', path: '/' },
        { name: 'Help Center', path: helpPath },
        { name: c.title },
      ]),
    ],
  };
}

export function helpArticleMeta(site: string, slug: string): PageMeta | null {
  const a = HELP_ARTICLES.find((x) => x.slug === slug);
  if (!a) return null;
  const c = HELP_CATEGORIES.find((x) => x.slug === a.category)!;
  return {
    title: a.title,
    description: clip(a.summary),
    canonicalPath: helpArticlePathOf(slug),
    robots: 'index, follow',
    jsonLd: [
      crumbsLd(site, [
        { name: 'Home', path: '/' },
        { name: 'Help Center', path: helpPath },
        { name: c.title, path: helpTopicPathOf(c.slug) },
        { name: a.title },
      ]),
    ],
  };
}

export function serviceMeta(site: string, slug: TravelCategorySlug): PageMeta {
  const c = TRAVEL_CATEGORIES.find((x) => x.slug === slug)!;
  return {
    title: `${c.name}: search and book`,
    description: clip(
      `${c.description} Search Wayora’s demo ${c.name.toLowerCase()} results; bookings are demonstrations, with no real reservation or payment.`,
    ),
    canonicalPath: `/${slug}`,
    robots: 'index, follow',
    jsonLd: [crumbsLd(site, [{ name: 'Home', path: '/' }, { name: c.name }])],
  };
}

export { aboutMeta, notFoundMeta, promotionsMeta, simpleMeta };

// ─── Prerendered body (HTML) ─────────────────────────────────────────────

const e = escapeHtml;
const a = (href: string, text: string) => `<a href="${e(href)}">${e(text)}</a>`;

function nav(): string {
  return `<header><nav aria-label="Site"><a href="/">Wayora</a> · ${a('/discover', 'Discover')} · ${a(GUIDES_PATH, 'Guides')} · ${a(helpPath, 'Help')}</nav></header>`;
}
function crumbs(items: Crumb[]): string {
  return `<nav aria-label="Breadcrumb"><ol>${items
    .map(
      (c) =>
        `<li>${c.path ? a(c.path, c.name) : `<span aria-current="page">${e(c.name)}</span>`}</li>`,
    )
    .join('')}</ol></nav>`;
}
function page(main: string, breadcrumb?: Crumb[]): string {
  return `<div data-prerendered class="mx-auto max-w-3xl px-4 py-10">${nav()}${breadcrumb ? crumbs(breadcrumb) : ''}<main id="main">${main}</main><footer><p>${a('/discover', 'Discover destinations')} · ${a(GUIDES_PATH, 'Travel guides')} · ${a(helpPath, 'Help Center')} · ${a('/about', 'About Wayora')}</p></footer></div>`;
}
const list = (items: string[]) =>
  items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>` : '';

export function blocksHtml(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'heading':
          return `<h${b.level}>${e(b.text)}</h${b.level}>`;
        case 'paragraph':
          return b.text
            .split(/\n{2,}/)
            .map((p) => `<p>${e(p)}</p>`)
            .join('');
        case 'list':
          return `<${b.style === 'number' ? 'ol' : 'ul'}>${b.items.map((i) => `<li>${e(i)}</li>`).join('')}</${b.style === 'number' ? 'ol' : 'ul'}>`;
        case 'tip':
          return `<div role="note"><p><strong>Tip:</strong> ${e(b.text)}</p></div>`;
        case 'provider':
          return `<div role="note"><p><strong>Set by the provider, not Wayora:</strong> ${e(b.text)}</p></div>`;
        case 'image':
          return `<figure><img src="/media/artwork/${e(b.media)}.svg" alt="${e(b.alt)}" width="1600" height="1200" loading="lazy" decoding="async" />${b.caption ? `<figcaption>${e(b.caption)}</figcaption>` : ''}</figure>`;
      }
    })
    .join('');
}

const destinationCard = (d: DestinationSummary) =>
  `${a(destinationPathOf(d.slug), d.name)} (${e(placeLineOf(d))}): ${e(d.description)}`;

export function homeBody(): string {
  return page(
    `<h1>Wayora: flights, hotels, trains, buses, metro, cabs and holiday packages</h1><p>${e(DEFAULT_DESCRIPTION)}</p><h2>Travel</h2>${list(
      TRAVEL_CATEGORIES.map((c) => a(`/${c.slug}`, c.name)),
    )}<h2>Destinations</h2>${list(DESTINATIONS.map(destinationCard))}`,
  );
}

export function discoverBody(): string {
  return page(
    `<h1>Discover destinations</h1><p>A small, curated collection of sample destinations with editorial descriptions.</p><h2>Themes</h2>${list(
      PUBLISHED_THEMES.map((t) => `${a(themePath(t.slug), t.title)}: ${e(t.description)}`),
    )}<h2>All destinations</h2>${list(DESTINATIONS.map(destinationCard))}`,
    [{ name: 'Home', path: '/' }, { name: 'Discover' }],
  );
}

export function destinationBody(
  d: Destination,
  related: DestinationSummary[],
  guides: PublicContent[],
  faqs: PublicContent[],
): string {
  const places = attractionsFor(d.slug);
  return page(
    `<article><h1>${e(d.name)}</h1><p>${e(placeLineOf(d))}, ${e(regionBySlug[d.region].name)}</p>${
      d.image
        ? `<img src="${e(d.image.src)}" alt="${e(d.image.alt)}" width="1600" height="1200" />`
        : ''
    }<p>${e(d.description)}</p><h2>Why it’s worth exploring</h2><p>${e(d.intro)}</p>${d.highlights
      .map((h) => `<h3>${e(h.title)}</h3><p>${e(h.text)}</p>`)
      .join('')}${
      places.length
        ? `<h2>Things to see and do in ${e(d.name)}</h2><p>From Wayora’s sample planning data: no opening hours or prices.</p>${list(places.map((p) => `<strong>${e(p.name)}</strong> (${e(p.area)}): ${e(p.description)}`))}`
        : ''
    }<h2>Plan the journey</h2>${list(travelOptionsFor(d).map((s) => a(serviceSearchPath(s, d.slug), serviceLinkText(s, d.name))))}${
      guides.length
        ? `<h2>Guides about ${e(d.name)}</h2>${list(guides.map((g) => `${a(g.path!, g.title)}: ${e(g.summary)}`))}`
        : ''
    }${faqs.length ? `<h2>Questions about ${e(d.name)}</h2>${faqs.map((f) => `<h3>${e(f.title)}</h3>${blocksHtml(f.body)}`).join('')}` : ''}${
      related.length ? `<h2>More destinations</h2>${list(related.map(destinationCard))}` : ''
    }</article>`,
    [{ name: 'Home', path: '/' }, { name: 'Discover', path: '/discover' }, { name: d.name }],
  );
}

export function themesIndexBody(): string {
  return page(
    `<h1>Destination themes</h1>${list(PUBLISHED_THEMES.map((t) => `${a(themePath(t.slug), t.title)}: ${e(t.description)}`))}`,
    [{ name: 'Home', path: '/' }, { name: 'Discover', path: '/discover' }, { name: 'Themes' }],
  );
}

export function themeBody(t: Theme): string {
  return page(
    `<h1>${e(t.title)}</h1><p>${e(t.description)}</p>${list(destinationsFor(t).map(destinationCard))}<p>${a(THEMES_PATH, 'All themes')}</p>`,
    [
      { name: 'Home', path: '/' },
      { name: 'Discover', path: '/discover' },
      { name: 'Themes', path: THEMES_PATH },
      { name: t.title },
    ],
  );
}

export function guidesIndexBody(items: PublicContent[]): string {
  const guides = items.filter(
    (c) => c.type === 'guide' || c.type === 'article' || c.type === 'tip',
  );
  return page(
    `<h1>Travel guides and articles</h1>${guides.length ? list(guides.map((g) => `${a(g.path!, g.title)} (${e(CONTENT_TYPE_LABEL[g.type])}): ${e(g.summary)}`)) : '<p>No guides have been published yet.</p>'}`,
    [{ name: 'Home', path: '/' }, { name: 'Guides' }],
  );
}

export function contentBody(c: PublicContent): string {
  const places = c.destinations.flatMap((s) => {
    const d = destinationBySlug(s);
    return d ? [d] : [];
  });
  const date = (iso: string) => iso.slice(0, 10);
  return page(
    `<article><h1>${e(c.title)}</h1><p>${e(CONTENT_TYPE_LABEL[c.type])} · By ${e(c.author)}, Wayora team · Published <time datetime="${e(c.publishedAt)}">${date(c.publishedAt)}</time>${
      c.updatedAt !== c.publishedAt
        ? ` · Updated <time datetime="${e(c.updatedAt)}">${date(c.updatedAt)}</time>`
        : ''
    }${c.readingMinutes ? ` · ${c.readingMinutes} min read` : ''}</p>${
      c.cover
        ? `<img src="${e(c.cover.src)}" alt="${e(c.cover.alt)}" width="${c.cover.width}" height="${c.cover.height}" />`
        : ''
    }${c.summary ? `<p>${e(c.summary)}</p>` : ''}${blocksHtml(c.body)}${
      places.length ? `<h2>Destinations</h2>${list(places.map(destinationCard))}` : ''
    }${c.related.length ? `<h2>Related reading</h2>${list(c.related.map((r) => (r.path ? `${a(r.path, r.title)}: ${e(r.summary)}` : e(r.title))))}` : ''}</article>`,
    [{ name: 'Home', path: '/' }, sectionCrumb(c), { name: c.title }],
  );
}

export function helpBody(): string {
  return page(
    `<h1>Help Center</h1>${HELP_CATEGORIES.map(
      (c) =>
        `<h2>${a(helpTopicPathOf(c.slug), c.title)}</h2>${list(HELP_ARTICLES.filter((x) => x.category === c.slug).map((x) => a(helpArticlePathOf(x.slug), x.title)))}`,
    ).join('')}`,
    [{ name: 'Home', path: '/' }, { name: 'Help Center' }],
  );
}

export function helpTopicBody(slug: string): string {
  const c = HELP_CATEGORIES.find((x) => x.slug === slug)!;
  return page(
    `<h1>${e(c.title)}</h1><p>${e(c.description)}</p>${list(HELP_ARTICLES.filter((x) => x.category === slug).map((x) => `${a(helpArticlePathOf(x.slug), x.title)}: ${e(x.summary)}`))}`,
    [{ name: 'Home', path: '/' }, { name: 'Help Center', path: helpPath }, { name: c.title }],
  );
}

export function helpArticleBody(slug: string): string {
  const x = HELP_ARTICLES.find((h) => h.slug === slug)!;
  const c = HELP_CATEGORIES.find((h) => h.slug === x.category)!;
  const body = x.body
    .map((b) =>
      b.type === 'p'
        ? `<p>${e(b.text)}</p>`
        : b.type === 'list' || b.type === 'steps'
          ? `<${b.type === 'steps' ? 'ol' : 'ul'}>${b.items.map((i) => `<li>${e(i)}</li>`).join('')}</${b.type === 'steps' ? 'ol' : 'ul'}>`
          : `<div role="note"><p><strong>${b.type === 'provider' ? 'Set by the provider, not Wayora' : 'Demo bookings'}:</strong> ${e(b.text)}</p></div>`,
    )
    .join('');
  const related = x.related.flatMap((s) => {
    const r = HELP_ARTICLES.find((h) => h.slug === s);
    return r ? [a(helpArticlePathOf(r.slug), r.title)] : [];
  });
  return page(
    `<article><h1>${e(x.title)}</h1><p>${e(x.summary)}</p>${body}${related.length ? `<h2>Related articles</h2>${list(related)}` : ''}</article>`,
    [
      { name: 'Home', path: '/' },
      { name: 'Help Center', path: helpPath },
      { name: c.title, path: helpTopicPathOf(c.slug) },
      { name: x.title },
    ],
  );
}

export function serviceBody(slug: TravelCategorySlug): string {
  const c = TRAVEL_CATEGORIES.find((x) => x.slug === slug)!;
  return page(
    `<h1>${e(c.name)}</h1><p>${e(c.description)}</p><p>Search runs in your browser against Wayora’s demo results: bookings are demonstrations, with no real reservation or payment.</p>`,
    [{ name: 'Home', path: '/' }, { name: c.name }],
  );
}

export function simpleBody(title: string, text: string, breadcrumb: Crumb[]): string {
  return page(`<h1>${e(title)}</h1><p>${e(text)}</p>`, breadcrumb);
}

export function notFoundBody(): string {
  return page(
    `<h1>Page not found</h1><p>This page doesn’t exist on Wayora. ${a('/discover', 'Discover destinations')} or ${a(helpPath, 'visit the Help Center')}.</p>`,
  );
}

// ─── All public pages ────────────────────────────────────────────────────

export interface PublicPage {
  path: string;
  meta: PageMeta;
  body: string;
  /** Only when accurately known (Help Center review dates, content updates). */
  lastmod?: string;
  /**
   * The page's largest image, fetched early (`<link rel="preload">`) so it
   * isn't discovered only after the app's JavaScript runs (docs/pwa.md#performance).
   */
  preloadImages?: { href: string; media?: string }[];
  /** CMS content the app starts from instead of fetching it again (no loading flash). */
  content?: PublicContent;
}

/**
 * Every indexable page, given the published CMS content. Pages for
 * destinations, themes and help come from code-reviewed data; guides,
 * collections and landing pages from published content only.
 */
export function publicPages(site: string, content: PublicContent[]): PublicPage[] {
  const withPage = content.filter((c) => c.path);
  const guidesFor = (slug: string) =>
    withPage.filter(
      (c) => ['guide', 'article', 'tip'].includes(c.type) && c.destinations.includes(slug),
    );
  const faqsFor = (slug: string) =>
    content.filter((c) => c.type === 'faq' && c.destinations.includes(slug));
  const latest = (items: PublicContent[]) =>
    items
      .map((c) => c.updatedAt)
      .sort()
      .at(-1);
  const pages: PublicPage[] = [
    {
      path: '/',
      meta: homeMeta(site),
      body: homeBody(),
      // The hero's back layer (portrait art on phones), the home page's largest paint.
      preloadImages: HERO_PRELOAD,
    },
    { path: '/discover', meta: discoverMeta(site), body: discoverBody() },
    { path: THEMES_PATH, meta: themesIndexMeta(site), body: themesIndexBody() },
    ...PUBLISHED_THEMES.map((t) => ({
      path: themePath(t.slug),
      meta: themeMeta(site, t),
      body: themeBody(t),
    })),
    ...DESTINATIONS.map((summary) => {
      const d = withDetails(summary)!;
      const related = DESTINATIONS.filter(
        (x) => x.slug !== d.slug && x.categories.some((c) => d.categories.includes(c)),
      ).slice(0, 4);
      const guides = guidesFor(d.slug);
      const faqs = faqsFor(d.slug);
      const lastmod = latest([...guides, ...faqs]);
      return {
        path: destinationPathOf(d.slug),
        meta: destinationMeta(site, d),
        body: destinationBody(d, related, guides, faqs),
        ...(lastmod ? { lastmod } : {}),
        ...(d.image ? { preloadImages: [{ href: d.image.src }] } : {}),
      };
    }),
    // The guides index only once there are guides to list (no empty, thin page).
    ...(withPage.some((c) => ['guide', 'article', 'tip'].includes(c.type))
      ? [
          {
            path: GUIDES_PATH,
            meta: guidesIndexMeta(site),
            body: guidesIndexBody(withPage),
            lastmod: latest(withPage)!,
          },
        ]
      : []),
    ...withPage.map((c) => ({
      path: c.path!,
      meta: contentMeta(site, c),
      body: contentBody(c),
      lastmod: c.updatedAt,
      content: c,
      ...(c.cover ? { preloadImages: [{ href: c.cover.src }] } : {}),
    })),
    {
      path: helpPath,
      meta: helpMeta(site),
      body: helpBody(),
      lastmod: HELP_ARTICLES.map((h) => h.reviewed)
        .sort()
        .at(-1)!,
    },
    ...HELP_CATEGORIES.map((c) => ({
      path: helpTopicPathOf(c.slug),
      meta: helpTopicMeta(site, c.slug)!,
      body: helpTopicBody(c.slug),
      lastmod: HELP_ARTICLES.filter((h) => h.category === c.slug)
        .map((h) => h.reviewed)
        .sort()
        .at(-1)!,
    })),
    ...HELP_ARTICLES.map((h) => ({
      path: helpArticlePathOf(h.slug),
      meta: helpArticleMeta(site, h.slug)!,
      body: helpArticleBody(h.slug),
      lastmod: h.reviewed,
    })),
    ...TRAVEL_CATEGORIES.map((c) => ({
      path: `/${c.slug}`,
      meta: serviceMeta(site, c.slug),
      body: serviceBody(c.slug),
    })),
    {
      path: '/promotions',
      meta: promotionsMeta(),
      body: simpleBody(
        'Offers and coupons',
        'Promotions running on Wayora now, with their terms. Each offer says what it applies to and when it ends; eligibility is checked at payment.',
        [{ name: 'Home', path: '/' }, { name: 'Offers' }],
      ),
    },
    {
      path: '/about',
      meta: aboutMeta(),
      body: simpleBody('About Wayora', DEFAULT_DESCRIPTION, [
        { name: 'Home', path: '/' },
        { name: 'About' },
      ]),
    },
  ];
  return pages;
}
