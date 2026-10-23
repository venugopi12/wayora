import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import {
  apiOriginOf,
  contentSecurityPolicy,
  productionApiUrlIssues,
  securityHeaders,
} from './config/security-headers.ts';

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
        const issues = productionApiUrlIssues(url);
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

export default defineConfig({
  plugins: [react(), tailwindcss(), securityHeadersPlugin()],
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
              test: /node_modules[\\/](@tanstack|zod|react-hook-form|@hookform)[\\/]/,
            },
          ],
        },
      },
    },
  },
});
