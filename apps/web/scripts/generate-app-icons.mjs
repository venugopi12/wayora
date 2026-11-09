#!/usr/bin/env node
/**
 * Generates the installed-app icons (docs/pwa.md#icons) from Wayora's mark
 * (the same drawing as public/favicon.svg), as PNG because launchers and
 * splash screens need raster icons:
 *
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs \
 *   node apps/web/scripts/generate-app-icons.mjs
 *
 * Writes apps/web/public/icons/:
 *   icon-192.png, icon-512.png   rounded tile on a transparent background ("any")
 *   maskable-512.png             full-bleed tile, mark inside the 80% safe zone ("maskable")
 *   apple-touch-icon.png         180×180, full-bleed (iOS rounds the corners itself)
 *   badge-96.png                 white mark on transparent (Android status-bar badge)
 * Output is committed; re-run after changing the mark.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OUT = fileURLToPath(new URL('../public/icons/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const mod = process.env.PLAYWRIGHT_MODULE;
if (!mod) {
  console.error(
    'Set PLAYWRIGHT_MODULE to Playwright’s entry point (node_modules/playwright/index.mjs).',
  );
  process.exit(1);
}
const { chromium } = await import(pathToFileURL(mod).href);
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);

const BRAND = '#5463B1';
// The mark from favicon.svg, drawn in a 32×32 box.
const MARK = (color) =>
  `<path d="M8 11.5C8 18.8 9.9 22.5 12 22.5s4-3.7 4-11c0 7.3 1.9 11 4 11s4-3.7 4-11" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8" cy="10.5" r="2.7" fill="${color}"/><circle cx="16" cy="10.5" r="2.2" fill="${color}"/><circle cx="24" cy="10.5" r="2.7" fill="${color}"/>`;

/** `scale`: how much of the tile the 32-unit mark box fills (centred). */
const svg = ({ tile, radius, scale, color }) => {
  const s = scale;
  const offset = (32 - 32 * s) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${
    tile ? `<rect width="32" height="32" rx="${radius}" fill="${BRAND}"/>` : ''
  }<g transform="translate(${offset} ${offset + 0.6 * s}) scale(${s})">${MARK(color)}</g></svg>`;
};

const ICONS = [
  ['icon-192.png', 192, svg({ tile: true, radius: 9, scale: 1, color: '#fff' })],
  ['icon-512.png', 512, svg({ tile: true, radius: 9, scale: 1, color: '#fff' })],
  // Maskable: no rounding (the launcher masks it), mark within the central 80%.
  ['maskable-512.png', 512, svg({ tile: true, radius: 0, scale: 0.72, color: '#fff' })],
  ['apple-touch-icon.png', 180, svg({ tile: true, radius: 0, scale: 0.82, color: '#fff' })],
  ['badge-96.png', 96, svg({ tile: false, radius: 0, scale: 1.1, color: '#fff' })],
];

for (const [file, size, markup] of ICONS) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><img style="display:block;width:${size}px;height:${size}px" src="data:image/svg+xml;base64,${Buffer.from(markup).toString('base64')}"></body></html>`,
  );
  writeFileSync(join(OUT, file), await page.screenshot({ omitBackground: true, type: 'png' }));
  await page.close();
  console.log(`✓ ${file} (${size}×${size})`);
}
await browser.close();
