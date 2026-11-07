import { DISALLOWED_PREFIXES, isIndexablePath, normalizePath } from './policy';
import { escapeHtml } from './meta';
import { absoluteUrl } from './site';

/*
 * XML sitemaps and robots.txt (docs/seo.md#sitemap), built at build time
 * from the same page list the prerender uses. Only indexable paths without
 * query strings are listed, once each; <lastmod> only when it's known.
 */

export interface SitemapEntry {
  path: string;
  lastmod?: string;
}

/** The sitemap protocol's limit is 50,000 URLs per file; stay well under it. */
export const MAX_URLS_PER_SITEMAP = 45_000;

const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?>';
const day = (iso: string) => iso.slice(0, 10);

export function sitemapEntries(entries: SitemapEntry[]): SitemapEntry[] {
  const seen = new Map<string, SitemapEntry>();
  for (const e of entries) {
    const path = normalizePath(e.path);
    if (path.includes('?') || path.includes('#') || !isIndexablePath(path)) continue;
    const prev = seen.get(path);
    if (!prev || (e.lastmod && (!prev.lastmod || e.lastmod > prev.lastmod)))
      seen.set(path, { ...e, path });
  }
  return [...seen.values()].sort((a, b) =>
    a.path === '/' ? -1 : b.path === '/' ? 1 : a.path.localeCompare(b.path),
  );
}

function urlset(site: string, entries: SitemapEntry[]): string {
  const urls = entries
    .map(
      (e) =>
        `  <url><loc>${escapeHtml(absoluteUrl(site, e.path))}</loc>${e.lastmod ? `<lastmod>${day(e.lastmod)}</lastmod>` : ''}</url>`,
    )
    .join('\n');
  return `${xmlHeader}\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/**
 * `sitemap.xml`, or, past MAX_URLS_PER_SITEMAP, a `sitemap.xml` index that
 * points at `sitemap-1.xml`, `sitemap-2.xml`, ….
 */
export function buildSitemaps(
  site: string,
  input: SitemapEntry[],
  max = MAX_URLS_PER_SITEMAP,
): { file: string; xml: string }[] {
  const entries = sitemapEntries(input);
  if (entries.length <= max) return [{ file: 'sitemap.xml', xml: urlset(site, entries) }];
  const chunks: SitemapEntry[][] = [];
  for (let i = 0; i < entries.length; i += max) chunks.push(entries.slice(i, i + max));
  const files = chunks.map((c, i) => ({ file: `sitemap-${i + 1}.xml`, xml: urlset(site, c) }));
  const index = `${xmlHeader}\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${files
    .map((f, i) => {
      const last = chunks[i]!.map((e) => e.lastmod)
        .filter(Boolean)
        .sort()
        .at(-1);
      return `  <sitemap><loc>${escapeHtml(absoluteUrl(site, `/${f.file}`))}</loc>${last ? `<lastmod>${day(last)}</lastmod>` : ''}</sitemap>`;
    })
    .join('\n')}\n</sitemapindex>\n`;
  return [{ file: 'sitemap.xml', xml: index }, ...files];
}

/** robots.txt: crawl everything public (assets included), skip private areas, point at the sitemap. */
export function robotsTxt(site: string): string {
  return [
    '# Wayora (docs/seo.md#robots). Private pages also send noindex and need a session;',
    '# this file only saves crawlers a wasted visit.',
    'User-agent: *',
    'Allow: /',
    ...DISALLOWED_PREFIXES.map((p) => `Disallow: ${p}`),
    '',
    `Sitemap: ${absoluteUrl(site, '/sitemap.xml')}`,
    '',
  ].join('\n');
}
