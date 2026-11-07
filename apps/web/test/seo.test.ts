import { describe, expect, it } from 'vitest';
import { publicContentSchema } from '@wayora/contracts';
import { DESTINATIONS } from '../src/features/discover/data';
import { withDetails } from '../src/features/discover/details';
import { PUBLISHED_THEMES, THEMES, destinationsFor } from '../src/features/discover/themes';
import { staticSectionOf } from '../src/features/seo/hosting';
import { escapeHtml, headHtml, headTags, jsonForScript } from '../src/features/seo/meta';
import {
  blocksHtml,
  contentBody,
  contentMeta,
  destinationMeta,
  notFoundMeta,
  publicPages,
  themeMeta,
} from '../src/features/seo/pages';
import {
  DISALLOWED_PREFIXES,
  canonicalPathFor,
  isIndexablePath,
  robotsFor,
} from '../src/features/seo/policy';
import { siteUrlIssues } from '../src/features/seo/site';
import { buildSitemaps, robotsTxt, sitemapEntries } from '../src/features/seo/sitemap';
import { guide } from './content-fixtures';

const SITE = 'https://www.wayora.example';

const attr = (tags: ReturnType<typeof headTags>, key: string, value: string) =>
  tags.find((t) => t.tag !== 'title' && t.attrs[key] === value);
const ldOf = (tags: ReturnType<typeof headTags>) =>
  tags
    .filter((t) => t.tag === 'script')
    .map((t) => JSON.parse((t as { text: string }).text) as Record<string, unknown>);

describe('indexing policy', () => {
  it('indexes public pages and never private ones', () => {
    for (const p of [
      '/',
      '/discover',
      '/discover/goa',
      '/discover/themes/heritage',
      '/guides/x',
      '/help/articles/cookies',
      '/flights',
      '/about',
    ])
      expect(robotsFor(p), p).toBe('index, follow');
    for (const p of [
      '/admin',
      '/admin/content',
      '/profile',
      '/trips/WAY-123',
      '/book/flights/abc',
      '/plans/1',
      '/assistant',
      '/rewards',
      '/support/new',
      '/reviews',
      '/login',
      '/register',
      '/notifications',
      '/offers/flights/abc',
      '/legal/privacy',
      '/status',
      '/design-system',
    ])
      expect(robotsFor(p), p).toBe('noindex, nofollow');
  });

  it('treats query strings as variants: noindex, but links are followed', () => {
    expect(robotsFor('/discover', '?mood=beach-escapes')).toBe('noindex, follow');
    expect(robotsFor('/flights', '?to=goa')).toBe('noindex, follow');
    expect(robotsFor('/admin', '?q=x')).toBe('noindex, nofollow');
  });

  it('gives canonical paths without trailing slashes, and none for private pages', () => {
    expect(canonicalPathFor('/discover/goa/')).toBe('/discover/goa');
    expect(canonicalPathFor('/')).toBe('/');
    expect(canonicalPathFor('/profile')).toBeNull();
    expect(isIndexablePath('/discover/goa/extra')).toBe(false);
  });
});

describe('head tags', () => {
  it('builds title, description, robots, canonical, Open Graph and Twitter tags', () => {
    const d = withDetails(DESTINATIONS.find((x) => x.slug === 'goa'))!;
    const tags = headTags(destinationMeta(SITE, d), SITE);
    expect(tags[0]).toEqual({ tag: 'title', text: `Goa, ${d.locality} | Wayora` });
    expect(attr(tags, 'rel', 'canonical')).toMatchObject({
      attrs: { href: `${SITE}/discover/goa` },
    });
    expect(attr(tags, 'name', 'robots')).toMatchObject({ attrs: { content: 'index, follow' } });
    expect(attr(tags, 'property', 'og:image')).toMatchObject({
      attrs: { content: `${SITE}/media/og/destination-goa.jpg` },
    });
    expect(attr(tags, 'property', 'og:image:width')).toMatchObject({ attrs: { content: '1200' } });
    expect(attr(tags, 'name', 'twitter:card')).toMatchObject({
      attrs: { content: 'summary_large_image' },
    });
    const description = attr(tags, 'name', 'description');
    expect(
      description?.tag === 'meta' && (description.attrs.content ?? '').length,
    ).toBeLessThanOrEqual(160);
  });

  it('adds no social cards or canonical link to noindex pages', () => {
    const tags = headTags(notFoundMeta(), SITE);
    expect(attr(tags, 'name', 'robots')).toMatchObject({ attrs: { content: 'noindex, follow' } });
    expect(attr(tags, 'rel', 'canonical')).toBeUndefined();
    expect(tags.some((t) => t.tag === 'meta' && 'property' in t.attrs)).toBe(false);
  });

  it('escapes markup in attributes and inside JSON-LD scripts', () => {
    const tags = headTags(
      contentMeta(
        SITE,
        guide({
          title: 'A </script><script>alert(1)</script> guide',
          metaDescription: 'Say "hi" <b>',
        }),
      ),
      SITE,
    );
    const html = headHtml(tags);
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&quot;hi&quot;');
    expect(jsonForScript({ a: '</script>' })).toBe('{"a":"\\u003c/script>"}');
    expect(escapeHtml('<a href="x">&')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;');
  });
});

describe('structured data', () => {
  it('destination pages describe a TouristDestination with breadcrumbs, and no prices or ratings', () => {
    for (const s of DESTINATIONS) {
      const ld = ldOf(headTags(destinationMeta(SITE, withDetails(s)!), SITE));
      expect(ld.map((b) => b['@type'])).toEqual(['BreadcrumbList', 'TouristDestination']);
      for (const b of ld) expect(b['@context']).toBe('https://schema.org');
      const text = JSON.stringify(ld);
      for (const banned of ['aggregateRating', 'review', 'offers', 'price', 'openingHours'])
        expect(text, `${s.slug}: ${banned}`).not.toContain(banned);
    }
  });

  it('guides are Articles with the staff byline and real dates', () => {
    const ld = ldOf(headTags(contentMeta(SITE, guide()), SITE));
    const article = ld.find((b) => b['@type'] === 'Article')!;
    expect(article).toMatchObject({
      headline: 'Goa in the monsoon',
      datePublished: '2026-11-01T09:00:00.000+00:00',
      dateModified: '2026-11-03T09:00:00.000+00:00',
      mainEntityOfPage: `${SITE}/guides/goa-monsoon-guide`,
    });
    expect(JSON.stringify(article.author)).toContain('Asha R.');
    expect(ld.find((b) => b['@type'] === 'BreadcrumbList')).toBeDefined();
  });

  it('collections are CollectionPages listing their destinations', () => {
    const ld = ldOf(
      headTags(
        contentMeta(
          SITE,
          guide({
            type: 'collection',
            path: '/collections/coast',
            slug: 'coast',
            destinations: ['goa', 'kerala'],
            readingMinutes: null,
          }),
        ),
        SITE,
      ),
    );
    const page = ld.find((b) => b['@type'] === 'CollectionPage')!;
    expect(JSON.stringify(page)).toContain(`${SITE}/discover/kerala`);
    expect(ld.some((b) => b['@type'] === 'Article')).toBe(false);
  });

  it('never claims FAQPage rich results', () => {
    const pages = publicPages(SITE, [
      guide(),
      guide({
        type: 'faq',
        slug: 'goa-faq',
        path: null,
        title: 'Is Goa open in the monsoon?',
        destinations: ['goa'],
      }),
    ]);
    for (const p of pages) expect(JSON.stringify(p.meta.jsonLd ?? [])).not.toContain('FAQPage');
  });
});

describe('public pages (what the build prerenders)', () => {
  const pages = publicPages(SITE, [guide()]);

  it('has unique, indexable paths and no private pages', () => {
    const paths = pages.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of pages) {
      expect(isIndexablePath(p.path), p.path).toBe(true);
      expect(p.meta.robots).toBe('index, follow');
      expect(p.meta.canonicalPath).toBe(p.path);
      expect(DISALLOWED_PREFIXES.some((d) => p.path.startsWith(d))).toBe(false);
    }
    expect(paths).toContain('/discover/goa');
    expect(paths).toContain('/guides/goa-monsoon-guide');
    expect(paths).toContain('/guides');
  });

  it('leaves out the guides index when there are no guides, and unpublished themes', () => {
    const empty = publicPages(SITE, []).map((p) => p.path);
    expect(empty).not.toContain('/guides');
    const hidden = THEMES.filter((t) => !PUBLISHED_THEMES.includes(t));
    for (const t of hidden) {
      expect(destinationsFor(t).length).toBeLessThan(2);
      expect(empty).not.toContain(`/discover/themes/${t.slug}`);
    }
    for (const t of PUBLISHED_THEMES) expect(empty).toContain(`/discover/themes/${t.slug}`);
  });

  it('gives every page one h1, a breadcrumb trail and a main landmark', () => {
    for (const p of pages) {
      expect(p.body.match(/<h1[\s>]/g), p.path).toHaveLength(1);
      expect(p.body).toContain('<main');
      if (p.path !== '/') expect(p.body, p.path).toContain('aria-label="Breadcrumb"');
    }
  });

  it('prerenders destination pages with things to see and do, and linked guides and FAQs', () => {
    const faq = guide({
      type: 'faq',
      slug: 'goa-faq',
      path: null,
      title: 'Is Goa open in the monsoon?',
      body: [{ type: 'paragraph', text: 'Most of it is.' }],
    });
    const goa = publicPages(SITE, [guide(), faq]).find((p) => p.path === '/discover/goa')!;
    expect(goa.body).toContain('Things to see and do');
    expect(goa.body).toContain('href="/guides/goa-monsoon-guide"');
    expect(goa.body).toContain('Is Goa open in the monsoon?');
    expect(goa.lastmod).toBe('2026-11-03T09:00:00.000+00:00');
    expect(goa.body).not.toMatch(/₹|\$\d|rating|per night/i);
  });

  it('renders content blocks as escaped text, never as markup', () => {
    const html = blocksHtml([
      { type: 'paragraph', text: '<img src=x onerror=alert(1)> and <b>bold</b>' },
      { type: 'list', style: 'number', items: ['<script>x</script>'] },
    ]);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(html).toContain('<ol>');
    const body = contentBody(guide());
    expect(body).toContain('width="1600" height="1200"');
    expect(body).toContain('By Asha R., Wayora team');
  });

  it('theme metadata lists only destinations that match the theme', () => {
    const t = PUBLISHED_THEMES.find((x) => x.slug === 'beach-destinations')!;
    const ld = JSON.stringify(themeMeta(SITE, t).jsonLd);
    for (const d of DESTINATIONS) {
      const inTheme = d.categories.includes('beach-escapes');
      expect(ld.includes(`/discover/${d.slug}"`), d.slug).toBe(inTheme);
    }
  });

  it('the fixture matches the public content contract', () => {
    expect(publicContentSchema.safeParse(guide()).success).toBe(true);
  });
});

describe('sitemap and robots.txt', () => {
  it('lists each indexable page once, without query strings or private pages', () => {
    const entries = sitemapEntries([
      { path: '/discover/goa' },
      { path: '/discover/goa/', lastmod: '2026-11-03T00:00:00Z' },
      { path: '/discover?mood=x' },
      { path: '/profile' },
      { path: '/' },
    ]);
    expect(entries).toEqual([
      { path: '/' },
      { path: '/discover/goa', lastmod: '2026-11-03T00:00:00Z' },
    ]);
  });

  it('writes lastmod only when it is known', () => {
    const [map] = buildSitemaps(SITE, [{ path: '/' }, { path: '/help', lastmod: '2026-11-07' }]);
    expect(map!.file).toBe('sitemap.xml');
    expect(map!.xml).toContain(`<url><loc>${SITE}/</loc></url>`);
    expect(map!.xml).toContain(`<url><loc>${SITE}/help</loc><lastmod>2026-11-07</lastmod></url>`);
  });

  it('splits into a sitemap index past the URL limit', () => {
    const files = buildSitemaps(
      SITE,
      ['/', '/about', '/discover', '/discover/goa', '/discover/kyoto'].map((path) => ({ path })),
      2,
    );
    expect(files.map((f) => f.file)).toEqual([
      'sitemap.xml',
      'sitemap-1.xml',
      'sitemap-2.xml',
      'sitemap-3.xml',
    ]);
    expect(files[0]!.xml).toContain('<sitemapindex');
    expect(files[0]!.xml).toContain(`<loc>${SITE}/sitemap-3.xml</loc>`);
    expect(files[3]!.xml.match(/<url>/g)).toHaveLength(1);
  });

  it('allows public content, disallows private paths and names the sitemap', () => {
    const txt = robotsTxt(SITE);
    expect(txt).toContain('User-agent: *\nAllow: /');
    for (const p of ['/admin', '/profile', '/trips', '/book/', '/plans', '/assistant', '/login'])
      expect(txt).toContain(`Disallow: ${p}\n`);
    expect(txt).not.toMatch(/Disallow: \/(discover|guides|help|assets|media)/);
    expect(txt).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  });
});

describe('hosting rules and the site URL', () => {
  it('answers 404 for unknown pages in fully prerendered sections only', () => {
    expect(staticSectionOf('/discover/atlantis')).toBe(true);
    expect(staticSectionOf('/help/articles/nope')).toBe(true);
    // CMS sections fall back to the app, which shows not-found once the API answers.
    expect(staticSectionOf('/guides/new-guide')).toBe(false);
    expect(staticSectionOf('/trips/WAY-1')).toBe(false);
  });

  it('requires an https origin for production builds', () => {
    expect(siteUrlIssues(undefined)).toHaveLength(1);
    expect(siteUrlIssues('http://www.wayora.example')).toHaveLength(1);
    expect(siteUrlIssues('https://www.wayora.example/app')).toHaveLength(1);
    expect(siteUrlIssues('https://www.wayora.example')).toEqual([]);
    expect(siteUrlIssues('http://localhost:4173')).toEqual([]);
  });
});
