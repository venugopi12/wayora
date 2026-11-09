#!/usr/bin/env node
/**
 * Lab mobile performance measurements (docs/pwa.md#performance), against a
 * running production build (`npm run build && npx vite preview`):
 *
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs \
 *   node apps/web/scripts/measure-mobile.mjs [baseUrl] [runs]
 *
 * Pixel 7 viewport, 4x CPU slowdown, ~1.6 Mbit/s down / 750 kbit/s up with
 * 150 ms latency. Per page, the median of `runs` loads: FCP, LCP, CLS, one
 * interaction (opening the phone menu) as INP, and JavaScript transferred.
 * Service workers are blocked so every load is a first visit. Lab numbers on
 * one machine: compare before/after on the same machine, not with field data.
 */
/* global window */ // inside page.evaluate / addInitScript (run in the browser)
import { pathToFileURL } from 'node:url';

const mod = process.env.PLAYWRIGHT_MODULE;
if (!mod) {
  console.error(
    'Set PLAYWRIGHT_MODULE to Playwright’s entry point (node_modules/playwright/index.mjs).',
  );
  process.exit(1);
}
const { chromium, devices } = await import(pathToFileURL(mod).href);
const BASE = process.argv[2] ?? 'http://localhost:4173';
const RUNS = Number(process.argv[3] ?? 5);
const day = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);
const PAGES = [
  '/',
  '/discover/goa',
  '/flights',
  `/flights?from=airport%3ABLR&to=airport%3ADEL&depart=${day}`,
];

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const results = {};
for (const path of PAGES) {
  const r = { fcp: [], lcp: [], cls: [], inp: [], js: [] };
  for (let i = 0; i < RUNS; i += 1) {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.addInitScript(() => {
      window.__m = { lcp: 0, cls: 0, inp: 0 };
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__m.lcp = e.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) if (!e.hadRecentInput) window.__m.cls += e.value;
      }).observe({ type: 'layout-shift', buffered: true });
      new PerformanceObserver((l) => {
        for (const e of l.getEntries())
          if (e.interactionId) window.__m.inp = Math.max(window.__m.inp, e.duration);
      }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
    });
    await page.goto(BASE + path, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForTimeout(3000);
    const menu = page.getByRole('button', { name: /open menu/i }).first();
    if (await menu.count()) {
      await menu.tap();
      await page.waitForTimeout(1500);
    }
    const m = await page.evaluate(() => ({
      ...window.__m,
      fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0,
      js: performance
        .getEntriesByType('resource')
        .filter((e) => e.name.endsWith('.js'))
        .reduce((a, e) => a + e.transferSize, 0),
    }));
    for (const k of Object.keys(r)) r[k].push(m[k]);
    await ctx.close();
  }
  results[path] = {
    fcpMs: Math.round(median(r.fcp)),
    lcpMs: Math.round(median(r.lcp)),
    cls: Number(median(r.cls).toFixed(3)),
    inpMs: Math.round(median(r.inp)),
    jsKB: Math.round(median(r.js) / 1024),
  };
  console.log(path, JSON.stringify(results[path]));
}
await browser.close();
