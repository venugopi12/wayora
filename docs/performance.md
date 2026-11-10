# Performance

Lab measurements of the production web build and what was changed because
of them. All numbers are measured, not estimated; field data (real users)
doesn't exist yet because Wayora isn't deployed.

## How it was measured (Phase 32)

- Production build (`npm run build`) served by `vite preview`, API on the
  same machine, Chromium 141 (Playwright 1.56.1), service worker cold.
- **Phone profile**: Pixel 7 viewport, 4× CPU slowdown, 1.6 Mbps down /
  750 kbps up, 150 ms round trip (similar to Lighthouse's mobile profile).
  Median of 3 loads per page. INP is the slowest interaction during the run
  (opening the menu).
- **Desktop profile**: 1366×900, no CPU slowdown, 20 Mbps, 40 ms. Median of 3.
- Targets: LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1.

## Results

Phone profile, after the Phase 32 changes:

| Page                        | FCP    | LCP         | CLS   | INP        | JS (gzip) |
| --------------------------- | ------ | ----------- | ----- | ---------- | --------- |
| Home `/`                    | 1.22 s | 2.92–3.11 s | 0.011 | 184–240 ms | 299 kB    |
| Destination `/discover/goa` | 1.19 s | 2.02 s      | 0     | 176–192 ms | 359 kB    |
| Guide                       | 1.22 s | 2.02 s      | 0.001 | 152–176 ms | 326 kB    |
| Flights search form         | 1.20 s | 3.14 s      | 0.005 | 144–176 ms | 343 kB    |
| Flights results             | 1.18 s | 3.27 s      | 0.024 | 144–152 ms | 343 kB    |

Ranges are the spread over separate runs of the same build.

Desktop profile: LCP 0.80 s (home), 0.49 s (flights), 0.71 s (destination),
0.66 s (guide).

**Where the targets are missed**: on the phone profile, the home page and
the search pages reach their largest paint after about 3.1 s, and home
interactions are sometimes above 200 ms. Both come from the size of the
start-up JavaScript (≈ 300 kB gzip: React, the router, Radix primitives used
by the header and menus, Motion): the prerendered HTML paints in ~1.2 s, but
the real page appears only after that code has downloaded and run.
Destination pages and guides meet the targets. Desktop meets them
everywhere.

## Changes made (Phase 32)

1. **Route chunks preloaded on prerendered pages** (`scripts/prerender.ts`).
   A page's lazy route module used to be requested only after the entry had
   run: a second round trip. Each prerendered page now has
   `<link rel="modulepreload">` for its route module and that module's
   imports (from Vite's build manifest, which is deleted after use).
   Measured on `/flights`: LCP 3.30 → 3.17 s on the phone profile, and
   2.91 → 2.45 s on a 10 Mbps / 300 ms link (5 runs each, medians).
2. **All three home hero layers preloaded** (`src/features/seo/pages.ts`),
   not only the back one: the middle layer is the home page's LCP element.
   The files are small SVGs (3–20 kB). Home LCP: 3.35 s before, 2.92–3.11 s
   after.

## What would close the remaining gap

Not done in Phase 32 because each is a larger change than a release check
should make:

- Server-side rendering or hydrating the prerendered HTML, so the real page
  paints before the JavaScript has run.
- A smaller start-up bundle: load the desktop navigation menu, account menu
  and toasts on first use instead of at start-up (Radix navigation-menu,
  menu, dropdown, toast and popover are all in the entry chunk today).
- Measure real users (web-vitals reporting) before optimising further.

## Earlier phases

Phase 30 (docs/pwa.md#performance) split vendor chunks, removed the SEO page
module from the entry, fixed the guide CLS (0.368 → 0.001) and preloaded the
destination image (LCP 4.18 → 2.05 s).
