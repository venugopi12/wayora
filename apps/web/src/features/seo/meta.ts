import { absoluteUrl } from './site';
import type { Robots } from './policy';

/*
 * One description of a page's metadata, turned into head tags by one
 * function. The browser applies the tags to document.head (SeoProvider);
 * the prerender writes the same tags into each page's HTML.
 */

export const SITE_NAME = 'Wayora';
export const DEFAULT_DESCRIPTION =
  'Wayora brings flights, hotels, trains, buses, metro, cabs and holiday packages into one booking experience.';
/** The default social card: a 1200×630 crop of the hero photograph. */
export const DEFAULT_OG_IMAGE = {
  path: '/media/og/default.jpg',
  width: 1200,
  height: 630,
  alt: 'Wayora: travel across India and beyond',
};

export interface PageMeta {
  /** Page title without the site name ("Goa, West coast"); null for the home page. */
  title: string | null;
  description: string;
  /** Canonical path (no query); null for pages that shouldn't have one. */
  canonicalPath: string | null;
  robots: Robots;
  ogType?: 'website' | 'article';
  /** Site-relative path of a raster image (JPEG/PNG), with its size and alt text. */
  image?: { path: string; width: number; height: number; alt: string };
  /** For articles. */
  publishedAt?: string;
  modifiedAt?: string;
  /** JSON-LD objects; each becomes one <script type="application/ld+json">. */
  jsonLd?: object[];
}

export type HeadTag =
  | { tag: 'title'; text: string }
  | { tag: 'meta'; attrs: Record<string, string> }
  | { tag: 'link'; attrs: Record<string, string> }
  | { tag: 'script'; attrs: Record<string, string>; text: string };

export const fullTitle = (title: string | null) =>
  title ? `${title} | ${SITE_NAME}` : `${SITE_NAME}: travel across India and beyond`;

/** Collapse whitespace and cut at a word boundary (meta descriptions ≤ 160). */
export function clip(text: string, max = 160): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20)).replace(/[\s,.;:–—-]+$/, '')}…`;
}

/** JSON for a <script> block: "<" escaped so text can never close the element. */
export const jsonForScript = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

export function headTags(meta: PageMeta, site: string): HeadTag[] {
  const title = fullTitle(meta.title);
  const description = clip(meta.description || DEFAULT_DESCRIPTION);
  const url = meta.canonicalPath ? absoluteUrl(site, meta.canonicalPath) : null;
  const image = meta.image ?? DEFAULT_OG_IMAGE;
  const imageUrl = absoluteUrl(site, image.path);
  const tags: HeadTag[] = [
    { tag: 'title', text: title },
    { tag: 'meta', attrs: { name: 'description', content: description } },
    { tag: 'meta', attrs: { name: 'robots', content: meta.robots } },
  ];
  if (url) tags.push({ tag: 'link', attrs: { rel: 'canonical', href: url } });
  // Social cards only for pages that are meant to be shared (indexable ones).
  if (meta.robots === 'index, follow') {
    tags.push(
      { tag: 'meta', attrs: { property: 'og:site_name', content: SITE_NAME } },
      { tag: 'meta', attrs: { property: 'og:type', content: meta.ogType ?? 'website' } },
      { tag: 'meta', attrs: { property: 'og:title', content: meta.title ?? title } },
      { tag: 'meta', attrs: { property: 'og:description', content: description } },
      ...(url ? [{ tag: 'meta' as const, attrs: { property: 'og:url', content: url } }] : []),
      { tag: 'meta', attrs: { property: 'og:image', content: imageUrl } },
      { tag: 'meta', attrs: { property: 'og:image:width', content: String(image.width) } },
      { tag: 'meta', attrs: { property: 'og:image:height', content: String(image.height) } },
      { tag: 'meta', attrs: { property: 'og:image:alt', content: image.alt } },
      { tag: 'meta', attrs: { property: 'og:locale', content: 'en_IN' } },
      { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
      { tag: 'meta', attrs: { name: 'twitter:title', content: meta.title ?? title } },
      { tag: 'meta', attrs: { name: 'twitter:description', content: description } },
      { tag: 'meta', attrs: { name: 'twitter:image', content: imageUrl } },
      { tag: 'meta', attrs: { name: 'twitter:image:alt', content: image.alt } },
    );
    if (meta.ogType === 'article') {
      if (meta.publishedAt)
        tags.push({
          tag: 'meta',
          attrs: { property: 'article:published_time', content: meta.publishedAt },
        });
      if (meta.modifiedAt)
        tags.push({
          tag: 'meta',
          attrs: { property: 'article:modified_time', content: meta.modifiedAt },
        });
    }
  }
  for (const block of meta.jsonLd ?? []) {
    tags.push({
      tag: 'script',
      attrs: { type: 'application/ld+json' },
      text: jsonForScript(block),
    });
  }
  return tags;
}

/** Escapes text for element content and for double- or single-quoted attributes. */
export const escapeHtml = (v: string) =>
  v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const escapeAttr = escapeHtml;

/** Head tags as HTML (for the prerender), each marked so the browser can replace it. */
export function headHtml(tags: HeadTag[]): string {
  return tags
    .map((t) => {
      const attrs =
        'attrs' in t
          ? Object.entries(t.attrs)
              .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
              .join('')
          : '';
      if (t.tag === 'title') return `<title>${escapeHtml(t.text)}</title>`;
      if (t.tag === 'script') return `<script data-seo${attrs}>${t.text}</script>`;
      return `<${t.tag} data-seo${attrs} />`;
    })
    .join('\n    ');
}
