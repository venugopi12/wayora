/*
 * Hosting rules for the prerendered build (docs/seo.md#hosting), shared by
 * `vite preview` and the documented web-server configuration.
 *
 * Sections whose every page is known at build time answer unknown URLs with
 * 404.html and a 404 status. Sections fed by the CMS (/guides, /collections,
 * /explore) fall back to the app shell, so content published since the last
 * build still loads (and says "not found" itself, with noindex, if it isn't).
 */
const STATIC_SECTIONS = [
  /^\/discover\/[^/]+$/,
  /^\/discover\/themes\/[^/]+$/,
  /^\/help\/(topics|articles)\/[^/]+$/,
];

export const staticSectionOf = (path: string) => STATIC_SECTIONS.some((r) => r.test(path));
