import { DISALLOWED_PREFIXES, isIndexablePath } from '../features/seo/policy';

/*
 * What the service worker may cache, and how (docs/pwa.md#caching). Pure, so
 * the rules are unit-tested and the worker (src/sw.ts) only wires them up.
 *
 * The rule of thumb: only things that are the same for every visitor are
 * cached. Anything personal (account, trips, bookings, payments,
 * notifications, admin, support, assistant…) never touches a service-worker
 * cache, so nothing one person saw can appear for the next person on a shared
 * device. Requests that change something (POST, PATCH, PUT, DELETE) are never
 * intercepted: they go to the network or fail, and are never queued to be
 * sent later.
 */

/** Bump to drop every runtime cache on the next activation. */
export const CACHE_VERSION = 'v1';

export const CACHE_NAMES = {
  /** Content-hashed JavaScript, CSS and fonts not in the precache. */
  assets: `wayora-assets-${CACHE_VERSION}`,
  /** Public images: destination artwork, social images, icons. */
  media: `wayora-media-${CACHE_VERSION}`,
  /** Public pages (HTML) people opened, for reading offline. */
  pages: `wayora-pages-${CACHE_VERSION}`,
  /** Public, cacheable API answers (published guides, popular destinations…). */
  publicApi: `wayora-public-api-${CACHE_VERSION}`,
} as const;

/** Runtime caches Wayora owns (precache names are Workbox's own). */
export const RUNTIME_CACHE_PREFIX = 'wayora-';

export const isCurrentCache = (name: string) =>
  (Object.values(CACHE_NAMES) as string[]).includes(name);

/** Limits per cache (oldest entries go first). */
export const CACHE_LIMITS = {
  assets: { maxEntries: 150, maxAgeSeconds: 60 * 60 * 24 * 30 },
  media: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30 },
  pages: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 * 14 },
  publicApi: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 7 },
} as const;

/** How long a page or public API request waits for the network before a saved copy is used. */
export const NETWORK_TIMEOUT_SECONDS = 4;

export const OFFLINE_PAGE = '/offline.html';

/**
 * Public API reads that are identical for every visitor (the API marks them
 * `Cache-Control: public`). Everything else under /api/ is never cached.
 */
export const PUBLIC_API_PATTERNS: readonly RegExp[] = [
  /^\/api\/v1\/content$/, // published lists (query string varies)
  /^\/api\/v1\/content\/(guides|collections|explore)\/[a-z0-9-]+$/,
  /^\/api\/v1\/discover\/popular$/,
  /^\/api\/v1\/catalog\/categories(\/[a-z]+)?$/,
];

export type Route =
  /** Not handled by the service worker at all (the browser's normal behaviour). */
  | { kind: 'bypass'; reason: string }
  /** Hashed build files: cache first (they never change at the same URL). */
  | { kind: 'asset' }
  /** Public images: serve the saved copy, refresh it in the background. */
  | { kind: 'media' }
  /** A public page: network first, a saved copy when offline, else the offline page. */
  | { kind: 'public-page' }
  /** A page that is personal or not public: network only, the offline page when offline. */
  | { kind: 'private-page' }
  /** A public API read: network first, a saved copy when offline. */
  | { kind: 'public-api' };

export interface RequestInfoLike {
  url: string;
  method: string;
  mode?: string;
  destination?: string;
}

export interface PolicyContext {
  /** The site's origin (the service worker's). */
  origin: string;
  /** The API's origin (may be the same as the site's). */
  apiOrigin: string;
}

/** Robots.txt's private prefixes (a defence on top of the indexable allow list). */
const isPrivatePath = (path: string) =>
  DISALLOWED_PREFIXES.some((p) => path.startsWith(p.replace(/\/$/, '')));

export function classify(req: RequestInfoLike, ctx: PolicyContext): Route {
  if (req.method !== 'GET') return { kind: 'bypass', reason: 'not a read' };
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return { kind: 'bypass', reason: 'bad url' };
  }
  const path = url.pathname;

  if (url.origin === ctx.apiOrigin && path.startsWith('/api/')) {
    return PUBLIC_API_PATTERNS.some((p) => p.test(path))
      ? { kind: 'public-api' }
      : { kind: 'bypass', reason: 'api: personal or changing' };
  }
  if (url.origin !== ctx.origin) return { kind: 'bypass', reason: 'other origin' };

  if (req.mode === 'navigate') {
    if (isPrivatePath(path) || !isIndexablePath(path)) return { kind: 'private-page' };
    return { kind: 'public-page' };
  }
  if (path.startsWith('/assets/')) return { kind: 'asset' };
  if (path.startsWith('/media/') || path.startsWith('/icons/') || path === '/favicon.svg') {
    return { kind: 'media' };
  }
  return { kind: 'bypass', reason: 'not cached (service worker, manifest, sitemap…)' };
}

/**
 * Whether a response may be stored. Respects the server: only successful,
 * same-for-everyone responses (`Cache-Control: public`, or a hashed/static
 * file with no `no-store`/`private`), never anything that sets a cookie.
 */
export function mayStore(
  route: Route,
  res: { status: number; type?: string; headers: { get(name: string): string | null } },
): boolean {
  if (res.status !== 200) return false;
  if (res.type === 'opaque' || res.type === 'opaqueredirect') return false;
  const cc = (res.headers.get('Cache-Control') ?? '').toLowerCase();
  if (/(^|,)\s*(no-store|private)\b/.test(cc)) return false;
  if (res.headers.get('Set-Cookie')) return false;
  if (route.kind === 'public-api') return /(^|,)\s*public\b/.test(cc);
  return route.kind === 'asset' || route.kind === 'media' || route.kind === 'public-page';
}

/** Messages the page sends the worker. */
export type WorkerMessage =
  | { type: 'SKIP_WAITING' }
  /** Sign-out or account change: drop saved pages and API answers (defence in depth). */
  | { type: 'CLEAR_RUNTIME_CACHES' };
