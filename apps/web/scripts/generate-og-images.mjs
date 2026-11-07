#!/usr/bin/env node
/**
 * Generates the raster social cards (Open Graph / Twitter) from Wayora's own
 * artwork, because social platforms don't accept SVG images:
 *
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs \
 *   node apps/web/scripts/generate-og-images.mjs
 *
 * Writes apps/web/public/media/og/: destination-<slug>.jpg (1200×630), the
 * site default default.jpg (1200×630) and logo.png (512×512, from the
 * favicon). Output is committed; re-run after changing the artwork. Needs
 * Playwright's Chromium (a development tool only, not a dependency of the
 * app); set PLAYWRIGHT_MODULE to its entry point.
 */
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const ART = join(PUBLIC, 'media/artwork');
const OUT = join(PUBLIC, 'media/og');
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
const page = await browser.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 1,
});

const dataUrl = (file) => `data:image/svg+xml;base64,${readFileSync(file).toString('base64')}`;
const card = (
  art,
  title,
  line,
) => `<!doctype html><html><body style="margin:0;width:1200px;height:630px;position:relative;overflow:hidden;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
  <img src="${dataUrl(art)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" />
  <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(23,27,53,0) 35%,rgba(23,27,53,.82) 100%)"></div>
  <div style="position:absolute;left:64px;right:64px;bottom:56px;color:#fff">
    <div style="font-size:26px;font-weight:600;letter-spacing:.04em;opacity:.9">WAYORA</div>
    <div style="font-size:72px;font-weight:700;line-height:1.05;margin-top:8px">${title}</div>
    ${line ? `<div style="font-size:28px;margin-top:12px;opacity:.9">${line}</div>` : ''}
  </div></body></html>`;

const NAMES = {
  goa: 'Goa',
  jaipur: 'Jaipur',
  kerala: 'Kerala',
  manali: 'Manali',
  bengaluru: 'Bengaluru',
  hyderabad: 'Hyderabad',
  mumbai: 'Mumbai',
  delhi: 'Delhi',
  bali: 'Bali',
  kyoto: 'Kyoto',
  singapore: 'Singapore',
  dubai: 'Dubai',
};
for (const file of readdirSync(ART).filter((f) => /^destination-[a-z-]+\.svg$/.test(f))) {
  const slug = file.slice('destination-'.length, -4);
  await page.setContent(
    card(join(ART, file), NAMES[slug] ?? slug, 'Travel guide and ways to get there'),
  );
  await page.screenshot({ path: join(OUT, `destination-${slug}.jpg`), type: 'jpeg', quality: 82 });
}
await page.setContent(
  card(
    join(ART, 'hero-dawn-far.svg'),
    'Travel across India and beyond',
    'Flights, hotels, trains, buses, cabs and holidays',
  ),
);
await page.screenshot({ path: join(OUT, 'default.jpg'), type: 'jpeg', quality: 82 });

await page.setViewportSize({ width: 512, height: 512 });
await page.setContent(
  `<!doctype html><html><body style="margin:0;background:#fff"><img src="${dataUrl(join(PUBLIC, 'favicon.svg'))}" style="width:512px;height:512px;display:block" /></body></html>`,
);
await page.screenshot({ path: join(OUT, 'logo.png'), type: 'png' });
await browser.close();
console.log(`Wrote social cards to ${OUT}`);
