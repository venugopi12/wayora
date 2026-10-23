/*
 * Browser security headers for the web app (docs/deployment.md#web-server-headers).
 *
 * The web app is a static bundle (apps/web/dist), so whatever serves it —
 * a CDN, nginx, IIS — must send these headers; `vite preview` sends them
 * too, so the production build is tested with them. The CSP is also embedded
 * in index.html as a <meta> tag at build time (without the directives a
 * meta tag can't carry), so the policy holds even on a host that sends no
 * headers.
 *
 * Why each source is allowed:
 * - script-src 'self': only the bundle's own files; no inline scripts, eval
 *   or third-party scripts exist.
 * - style-src 'unsafe-inline': Radix dialogs and sheets lock page scrolling
 *   by injecting a small <style> element at runtime (react-remove-scroll);
 *   a static host can't hand out per-request nonces. Scripts stay strict.
 * - img-src data:/blob:: inline SVG data URIs used by the design system.
 * - connect-src: the API origin (VITE_API_BASE_URL) and nothing else.
 */

/** VITE_API_BASE_URL (e.g. https://api.wayora.example/) → its origin. */
export function apiOriginOf(apiBaseUrl: string): string {
  return new URL(apiBaseUrl).origin;
}

export function contentSecurityPolicy({
  apiOrigin,
  forMetaTag = false,
}: {
  apiOrigin: string;
  /** A <meta> tag can't carry frame-ancestors (browsers ignore it there, with a warning). */
  forMetaTag?: boolean;
}): string {
  const https = apiOrigin.startsWith('https://');
  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'"]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['font-src', ["'self'", 'data:']],
    ['media-src', ["'self'"]],
    ['connect-src', ["'self'", apiOrigin]],
    ['manifest-src', ["'self'"]],
    ['worker-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
  ];
  if (!forMetaTag) directives.push(['frame-ancestors', ["'none'"]]);
  const parts = directives.map(([name, values]) => `${name} ${[...new Set(values)].join(' ')}`);
  if (https) parts.push('upgrade-insecure-requests');
  return parts.join('; ');
}

/**
 * Headers for every response of the web origin. HSTS is deliberately not
 * here: send it from the TLS-terminating proxy, once HTTPS is guaranteed for
 * the whole host (docs/deployment.md#https-and-hsts).
 */
export function securityHeaders({ apiOrigin }: { apiOrigin: string }): Record<string, string> {
  return {
    'Content-Security-Policy': contentSecurityPolicy({ apiOrigin }),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // Older browsers without frame-ancestors support.
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };
}

/**
 * Production builds must name the API explicitly: silently shipping the
 * development default (http://localhost:4000) would produce a site that
 * talks to nobody, or to the wrong host. Plain http is accepted only for
 * localhost (local production previews and CI). Returns the problems (empty: valid).
 */
export function productionApiUrlIssues(value: string | undefined): string[] {
  if (!value) {
    return [
      'VITE_API_BASE_URL is not set. Production builds need the public API URL, e.g. VITE_API_BASE_URL=https://api.wayora.example npm run build',
    ];
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return ['VITE_API_BASE_URL is not a valid URL.'];
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    return ['VITE_API_BASE_URL must use https:// (plain http is only allowed for localhost).'];
  }
  if (url.username || url.password || url.search || url.hash) {
    return ['VITE_API_BASE_URL must be a plain URL without credentials, query or fragment.'];
  }
  return [];
}
