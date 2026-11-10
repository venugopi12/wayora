import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import {
  apiOriginOf,
  contentSecurityPolicy,
  productionApiUrlIssues,
  securityHeaders,
} from './config/security-headers.ts';
import { siteUrlIssues } from './src/features/seo/site.ts';
import { staticSectionOf } from './src/features/seo/hosting.ts';
import { appManifest, shellPrecacheTransform } from './config/pwa.ts';

const DEV_API = 'http://localhost:4000';

/**
 * Production safety for the static bundle (docs/deployment.md#web):
 * - `vite build` refuses to run without an explicit, safe VITE_API_BASE_URL,
 * - the built index.html carries the Content-Security-Policy as a <meta> tag,
 * - `vite preview` serves the production build with the full header set.
 * The dev server is left alone (its hot reload needs inline scripts).
 */
function securityHeadersPlugin(): Plugin {
  let apiOrigin = DEV_API;
  return {
    name: 'wayora-security-headers',
    configResolved(config) {
      const url = config.env.VITE_API_BASE_URL as string | undefined;
      if (config.command === 'build' && config.mode === 'production') {
        const issues = [
          ...productionApiUrlIssues(url),
          ...siteUrlIssues(config.env.VITE_SITE_URL as string | undefined),
        ];
        if (issues.length) throw new Error(`\n${issues.join('\n')}\n`);
      }
      apiOrigin = apiOriginOf(url || DEV_API);
    },
    transformIndexHtml(html, ctx) {
      if (ctx.server) return html;
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: {
              'http-equiv': 'Content-Security-Policy',
              content: contentSecurityPolicy({ apiOrigin, forMetaTag: true }),
            },
            injectTo: 'head-prepend',
          },
        ],
      };
    },
    configurePreviewServer(server) {
      const headers = securityHeaders({ apiOrigin });
      server.middlewares.use((_req, res, next) => {
        for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
        next();
      });
    },
  };
}

/**
 * `vite preview` serves the build the way docs/deployment.md#web tells a host
 * to (docs/seo.md#hosting): a prerendered page when one exists, a real 404
 * for unknown URLs in fully static sections, and the app shell (app.html)
 * for everything else (client-side routes).
 */
function prerenderedHostingPlugin(): Plugin {
  return {
    name: 'wayora-prerendered-hosting',
    configurePreviewServer(server) {
      const dist = server.config.build.outDir;
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
        if (/\.[a-z0-9]+$/i.test(path)) return next(); // assets, sitemap.xml, robots.txt
        const clean = path.replace(/\/+$/, '') || '/';
        const file = join(dist, clean === '/' ? 'index.html' : `${clean}/index.html`);
        const send = (status: number, f: string) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(readFileSync(f));
        };
        if (existsSync(file) && statSync(file).isFile()) return send(200, file);
        if (staticSectionOf(clean) && existsSync(join(dist, '404.html')))
          return send(404, join(dist, '404.html'));
        if (existsSync(join(dist, 'app.html'))) return send(200, join(dist, 'app.html'));
        return next();
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    securityHeadersPlugin(),
    prerenderedHostingPlugin(),
    // Installable app and service worker (docs/pwa.md). Production builds only:
    // the dev server never registers a worker, so development stays predictable.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      // The app registers the worker itself (src/pwa/register.ts) and asks before updating.
      injectRegister: false,
      registerType: 'prompt',
      manifest: appManifest,
      includeManifestIcons: false,
      // VITE_PWA=off builds a worker that removes itself and its caches (the kill switch).
      selfDestroying: loadEnv(mode, process.cwd(), '').VITE_PWA === 'off',
      injectManifest: {
        globPatterns: [
          'assets/*.{js,css}',
          'icons/*.png',
          'offline.html',
          'offline.js',
          'favicon.svg',
        ],
        // Precache only what the app shell loads at start-up; other chunks are cached when used.
        manifestTransforms: [
          shellPrecacheTransform(fileURLToPath(new URL('./dist/', import.meta.url))),
        ],
        maximumFileSizeToCacheInBytes: 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    // Bare "zod" → src/lib/zod.ts (sets jitless before any schema; see there).
    alias: [
      { find: /^zod$/, replacement: fileURLToPath(new URL('./src/lib/zod.ts', import.meta.url)) },
    ],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
  },
  build: {
    // Production maps are generated for debugging and error tracking but are
    // never referenced from the bundle (`hidden`: no sourceMappingURL), and
    // scripts/extract-sourcemaps.mjs moves them out of dist/ so a deploy of
    // dist/ can't publish them. The dev server always has full source maps.
    sourcemap: 'hidden',
    // Read by scripts/prerender.ts to preload each prerendered page's route
    // chunks, then deleted (dist/.vite is never deployed).
    manifest: true,
    target: 'es2022',
    rolldownOptions: {
      output: {
        // Split rarely-changing vendor code into separately cacheable chunks.
        codeSplitting: {
          groups: [
            {
              name: 'react',
              test: /node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/,
            },
            {
              name: 'motion',
              test: /node_modules[\\/](motion|motion-dom|motion-utils|framer-motion)[\\/]/,
            },
            {
              name: 'data',
              test: /node_modules[\\/](@tanstack|zod)[\\/]/,
            },
            {
              // Only form pages (sign-in, checkout, planner…) load it, so it
              // stays out of the start-up bundle (docs/pwa.md#performance).
              name: 'forms',
              test: /node_modules[\\/](react-hook-form|@hookform)[\\/]/,
            },
          ],
        },
      },
    },
  },
}));
