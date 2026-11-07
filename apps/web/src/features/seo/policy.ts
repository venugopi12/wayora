/*
 * Which pages search engines may index (docs/seo.md#indexing). An allow list:
 * anything not listed here is `noindex`. Private and personal pages (account,
 * trips, checkout, admin, support, reviews you wrote) are never indexable, and
 * robots.txt is not relied on to protect them: they need a session anyway.
 */

export type Robots = 'index, follow' | 'noindex, follow' | 'noindex, nofollow';

const SERVICE_PATHS = ['flights', 'hotels', 'trains', 'buses', 'metro', 'cabs', 'holidays'];

/** Public, indexable page patterns ("*" = one segment). */
export const INDEXABLE_PATTERNS: readonly string[] = [
  '/',
  '/discover',
  '/discover/*',
  '/discover/themes/*',
  '/guides',
  '/guides/*',
  '/collections/*',
  '/explore/*',
  '/help',
  '/help/topics/*',
  '/help/articles/*',
  '/promotions',
  '/about',
  ...SERVICE_PATHS.map((s) => `/${s}`),
];

function matches(pattern: string, path: string): boolean {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  return p.length === s.length && p.every((seg, i) => seg === '*' || seg === s[i]);
}

/** "/discover/goa/" → "/discover/goa"; "/" stays "/". */
export const normalizePath = (path: string) =>
  path.length > 1 ? path.replace(/\/+$/, '') || '/' : '/';

export function isIndexablePath(pathname: string): boolean {
  const path = normalizePath(pathname);
  return INDEXABLE_PATTERNS.some((p) => matches(p, path));
}

/**
 * Robots directive for a URL. Query strings (filters, searches, ?mode=) make
 * a page a variant of its canonical path: not indexed, but its links are
 * followed. Private pages are not followed either.
 */
export function robotsFor(pathname: string, search = ''): Robots {
  if (!isIndexablePath(pathname)) return 'noindex, nofollow';
  return search && search !== '?' ? 'noindex, follow' : 'index, follow';
}

/** The canonical path: no query, no trailing slash. Null when the page isn't indexable. */
export function canonicalPathFor(pathname: string): string | null {
  return isIndexablePath(pathname) ? normalizePath(pathname) : null;
}

/** Paths robots.txt asks crawlers to skip (they're also noindex and need a session). */
export const DISALLOWED_PREFIXES = [
  '/admin',
  '/profile',
  '/trips',
  '/book/',
  '/notifications',
  '/plans',
  '/assistant',
  '/rewards',
  '/support',
  '/reviews',
  '/login',
  '/register',
  '/sign-in',
  '/offers/',
] as const;
