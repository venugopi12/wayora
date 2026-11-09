import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ManifestOptions } from 'vite-plugin-pwa';

/*
 * Web app manifest and precache rules (docs/pwa.md#manifest). Tested in
 * test/pwa-config.test.ts.
 */

export const THEME_COLOR = '#faf9f6';
export const BRAND_COLOR = '#5463B1';

export const appManifest: Partial<ManifestOptions> = {
  id: '/',
  name: 'Wayora: flights, hotels, trains, buses and holidays',
  short_name: 'Wayora',
  description:
    'Plan and book flights, hotels, trains, buses, metro, cabs and holiday packages in one place.',
  lang: 'en-IN',
  dir: 'ltr',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  display_override: ['standalone', 'minimal-ui'],
  // Matches the site header and page background, so the status bar blends in.
  theme_color: THEME_COLOR,
  background_color: THEME_COLOR,
  categories: ['travel'],
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
  shortcuts: [
    {
      name: 'Search flights',
      short_name: 'Flights',
      url: '/flights',
      icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
    },
    {
      name: 'Search hotels',
      short_name: 'Hotels',
      url: '/hotels',
      icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
    },
    {
      name: 'My trips',
      short_name: 'Trips',
      url: '/trips',
      icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
    },
  ],
};

interface ManifestEntry {
  url: string;
  revision: string | null;
  size: number;
}

/** `/assets/…` files the built start-up page loads (script, modulepreloads, stylesheet). */
export function shellAssets(html: string): Set<string> {
  return new Set(
    [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]!),
  );
}

/**
 * Keeps the precache small on mobile data: of the build's JavaScript and CSS,
 * only the files the start-up page loads (other route chunks are cached the
 * first time they're used). Icons, the offline page and the favicon stay.
 */
export function shellPrecacheTransform(outDir: string) {
  return (entries: ManifestEntry[]) => {
    const index = join(outDir, 'index.html');
    if (!existsSync(index)) {
      return { manifest: entries, warnings: ['index.html not found: precaching every asset.'] };
    }
    const shell = shellAssets(readFileSync(index, 'utf8'));
    const manifest = entries.filter((e) => !e.url.startsWith('assets/') || shell.has(e.url));
    return { manifest, warnings: [] };
  };
}
