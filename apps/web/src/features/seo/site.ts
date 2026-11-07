/*
 * The public site URL (docs/seo.md#configuration). Pure: the prerender script
 * passes it in explicitly; the browser reads it from VITE_SITE_URL.
 */

/** Problems with a production site URL (empty when it's usable). */
export function siteUrlIssues(value: string | undefined): string[] {
  if (!value) {
    return [
      'VITE_SITE_URL is not set. Production builds need the public site URL for canonical links, the sitemap and social cards, e.g. VITE_SITE_URL=https://www.wayora.example',
    ];
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return ['VITE_SITE_URL is not a valid URL.'];
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    return ['VITE_SITE_URL must use https:// (plain http is only allowed for localhost).'];
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    return [
      'VITE_SITE_URL must be the site origin only, e.g. https://www.wayora.example (no path, query or credentials).',
    ];
  }
  return [];
}

/** "https://www.wayora.example/" → "https://www.wayora.example". */
export const normalizeSite = (value: string) => new URL(value).origin;

/** An absolute URL on the site; `path` starts with "/". */
export function absoluteUrl(site: string, path: string): string {
  return `${site}${path.startsWith('/') ? path : `/${path}`}`;
}
