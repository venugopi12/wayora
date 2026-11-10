#!/usr/bin/env tsx
/**
 * Build-time prerendering (docs/seo.md#rendering). Runs after `vite build`:
 *
 *   VITE_SITE_URL=https://www.wayora.example \
 *   PRERENDER_CONTENT_URL=https://api.wayora.example \   (optional: published CMS content)
 *   tsx scripts/prerender.ts
 *
 * For every public, indexable page it writes dist/<path>/index.html: the app
 * shell with that page's title, description, canonical link, social cards
 * and JSON-LD, and a semantic text version of the page inside #root (React
 * replaces it when the app starts). It also writes:
 *
 *   app.html     the app shell for client-side routes (noindex until the app runs)
 *   404.html     for unknown URLs in fully static sections
 *   sitemap.xml  (an index plus sitemap-N.xml past 45,000 URLs)
 *   robots.txt
 *
 * CMS content is fetched from PRERENDER_CONTENT_URL's /api/v1/content/feed.
 * Without it, guides, collections and landing pages aren't prerendered or
 * listed (a warning says so); they still work as client-rendered pages.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { contentFeedSchema, type PublicContent } from '@wayora/contracts';
import {
  DEFAULT_DESCRIPTION,
  escapeHtml,
  headHtml,
  headTags,
  jsonForScript,
} from '../src/features/seo/meta';
import { PRERENDERED_CONTENT_ID } from '../src/features/content/prerendered';
import { notFoundBody, notFoundMeta, publicPages } from '../src/features/seo/pages';
import { buildSitemaps, robotsTxt } from '../src/features/seo/sitemap';
import { normalizeSite, siteUrlIssues } from '../src/features/seo/site';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
// The same values `vite build` used: the environment first, then apps/web/.env files.
const ENV = {
  ...loadEnv('production', fileURLToPath(new URL('..', import.meta.url)), ''),
  ...process.env,
};

function fail(message: string): never {
  console.error(`\n✗ Prerender: ${message}\n`);
  process.exit(1);
}

async function loadContent(): Promise<PublicContent[]> {
  const base = ENV.PRERENDER_CONTENT_URL;
  if (!base) {
    console.warn(
      '! Prerender: PRERENDER_CONTENT_URL is not set, so published guides, collections and landing pages are not prerendered or in the sitemap. They still load as client-rendered pages.',
    );
    return [];
  }
  const url = `${base.replace(/\/+$/, '')}/api/v1/content/feed`;
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { Accept: 'application/json' },
    });
  } catch (e) {
    fail(
      `couldn't reach ${url} (${(e as Error).message}). Unset PRERENDER_CONTENT_URL to build without CMS content.`,
    );
  }
  if (!res.ok) fail(`${url} answered ${res.status}.`);
  const parsed = contentFeedSchema.safeParse(((await res.json()) as { data?: unknown }).data);
  if (!parsed.success) fail(`${url} returned content that doesn't match the contract.`);
  return parsed.data.items;
}

/** The built shell with its own head metadata removed, ready for a page's. */
function shellWithout(html: string): string {
  return html
    .replace(/<title>[\s\S]*?<\/title>\s*/i, '')
    .replace(/<meta\b[^>]*\bdata-seo\b[^>]*>\s*/gi, '');
}

function compose(shell: string, head: string, body: string): string {
  if (!shell.includes('<div id="root"></div>'))
    fail(
      'dist/index.html has no empty <div id="root"></div>: run `vite build` first (npm run build does), since prerendering replaces it.',
    );
  return shell
    .replace('</head>', `    ${head}\n  </head>`)
    .replace('<div id="root"></div>', `<div id="root">${body}</div>`);
}

function write(path: string, html: string) {
  const file = path === '/' ? join(DIST, 'index.html') : join(DIST, path.slice(1), 'index.html');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}

/*
 * Route chunks (Phase 32, docs/performance.md#route-preloads). The app shell
 * only knows its entry; a page's lazy route module is requested after the
 * entry has run, a second round trip that measured ~0.8 s of LCP on a
 * throttled phone. Each prerendered page therefore preloads its route
 * module and that module's static imports from the start.
 */
type ViteManifest = Record<string, { file: string; imports?: string[]; isEntry?: boolean }>;

const ROUTE_MODULES: [RegExp, string][] = [
  [/^\/(flights|hotels|trains|buses|metro|cabs|holidays)$/, 'src/features/search/routes.tsx'],
  [/^\/discover(\/|$)/, 'src/features/discover/routes.tsx'],
  [/^\/(guides|collections|explore)(\/|$)/, 'src/features/content/routes.tsx'],
  [/^\/help(\/|$)/, 'src/features/help/routes.tsx'],
  [/^\/(about|privacy|terms)$/, 'src/features/info/routes.tsx'],
  [/^\/promotions$/, 'src/features/promotions/routes.tsx'],
];

function routePreloader(manifest: ViteManifest | null) {
  if (!manifest) return () => '';
  const entry = Object.values(manifest).find((c) => c.isEntry);
  // Already preloaded by the shell: the entry and everything it imports statically.
  const inShell = new Set<string>();
  const walk = (key: string, into: Set<string>) => {
    const chunk = manifest[key];
    if (!chunk || into.has(chunk.file)) return;
    into.add(chunk.file);
    for (const i of chunk.imports ?? []) walk(i, into);
  };
  const entryKey = Object.keys(manifest).find((k) => manifest[k] === entry);
  if (entryKey) walk(entryKey, inShell);
  return (path: string) => {
    const module = ROUTE_MODULES.find(([re]) => re.test(path))?.[1];
    if (!module) return '';
    // The bundler may merge a small route module into a shared chunk, which the
    // manifest then doesn't name: that page simply goes without the preload.
    if (!manifest[module]) return '';
    const files = new Set<string>();
    walk(module, files);
    return [...files]
      .filter((f) => !inShell.has(f) && f.endsWith('.js'))
      .map((f) => `<link rel="modulepreload" crossorigin href="/${escapeHtml(f)}" />`)
      .join('\n    ');
  };
}

async function main() {
  const issues = siteUrlIssues(ENV.VITE_SITE_URL);
  if (issues.length) fail(issues.join(' '));
  const site = normalizeSite(ENV.VITE_SITE_URL!);
  const shell = shellWithout(readFileSync(join(DIST, 'index.html'), 'utf8'));
  const content = await loadContent();

  // The app shell for client-side routes: noindex until the app sets the page's own robots.
  writeFileSync(
    join(DIST, 'app.html'),
    compose(
      shell,
      headHtml(
        headTags(
          {
            title: null,
            description: DEFAULT_DESCRIPTION,
            canonicalPath: null,
            robots: 'noindex, nofollow',
          },
          site,
        ),
      ),
      '',
    ),
  );
  writeFileSync(
    join(DIST, '404.html'),
    compose(shell, headHtml(headTags(notFoundMeta(), site)), notFoundBody()),
  );

  const manifestFile = join(DIST, '.vite', 'manifest.json');
  const preloadRoute = routePreloader(
    existsSync(manifestFile)
      ? (JSON.parse(readFileSync(manifestFile, 'utf8')) as ViteManifest)
      : null,
  );
  const pages = publicPages(site, content);
  const seen = new Set<string>();
  for (const p of pages) {
    if (seen.has(p.path)) fail(`two pages share ${p.path}.`);
    seen.add(p.path);
    const preloads = (p.preloadImages ?? [])
      .map(
        (i) =>
          `<link rel="preload" as="image" href="${escapeHtml(i.href)}"${i.media ? ` media="${escapeHtml(i.media)}"` : ''} fetchpriority="high" />`,
      )
      .join('\n    ');
    // The published entry itself, so the app shows it at once instead of fetching it again.
    const data = p.content
      ? `<script type="application/json" id="${PRERENDERED_CONTENT_ID}">${jsonForScript(p.content)}</script>`
      : '';
    write(
      p.path,
      compose(
        shell,
        [headHtml(headTags(p.meta, site)), preloads, preloadRoute(p.path), data]
          .filter(Boolean)
          .join('\n    '),
        p.body,
      ),
    );
  }

  const sitemaps = buildSitemaps(
    site,
    pages.map((p) => ({ path: p.path, ...(p.lastmod ? { lastmod: p.lastmod } : {}) })),
  );
  for (const s of sitemaps) writeFileSync(join(DIST, s.file), s.xml);
  writeFileSync(join(DIST, 'robots.txt'), robotsTxt(site));
  // Build metadata only: never deployed.
  rmSync(join(DIST, '.vite'), { recursive: true, force: true });

  console.log(
    `✓ Prerendered ${pages.length} pages (${content.length} published content entries) for ${site}; wrote app.html, 404.html, ${sitemaps.map((s) => s.file).join(', ')} and robots.txt.`,
  );
}

await main();
