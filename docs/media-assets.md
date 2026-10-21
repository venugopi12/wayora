# Media assets

Images are listed in two places; components never hard-code image paths:

- `apps/web/src/features/home/media.ts`: homepage hero layers and closing CTA.
- `apps/web/src/features/discover/data.ts`: every destination's `image` and
  every mood's `image` (used by the homepage, Discover and destination pages).
  The test suite checks each path exists in `apps/web/public` and has alt text.

## Current assets: original artwork

`artwork/` contains **original SVG artwork** made for Wayora by
`apps/web/scripts/generate-artwork.mjs` (deterministic, seeded; re-running it
reproduces the files byte for byte). There are no third-party images, stock
photos, logos or licence obligations.

Photography was intended, but no licensed photo source could be downloaded or
verified while building Phase 4 or Phase 6: the build environment's network
allowlist blocks Unsplash, Pexels and Wikimedia (checked again in Phase 6 from
both the build container and the developer's machine), so nothing was
hot-linked or invented. Destination scenes are _inspired by_ each place's
character (e.g. a pagoda for Kyoto, terraces for Bali); they are not replicas of
specific buildings, and generic towers are used where a real skyline is
dominated by one recognisable landmark.
The artwork is a deliberate, consistent "editorial travel poster" series in the
Wayora palette, not a broken-image placeholder.

| File                                         | Slot                              | Size                  | Notes                                                   |
| -------------------------------------------- | --------------------------------- | --------------------- | ------------------------------------------------------- |
| `hero-dawn-sky.svg`, `-far.svg`, `-near.svg` | Hero, 3 parallax layers           | 2400×1500             | Shared viewBox; far/near are transparent                |
| `hero-dawn-*-portrait.svg`                   | Hero on phones (< 768px)          | 1200×2000             | Art-directed portrait crop                              |
| `mood-beach-escapes.svg`                     | Explore by mood                   | 1200×1500             |                                                         |
| `mood-mountain-retreats.svg`                 | Explore by mood                   | 1200×1500             |                                                         |
| `mood-cultural-cities.svg`                   | Explore by mood                   | 1200×1500             |                                                         |
| `mood-weekend-getaways.svg`                  | Explore by mood                   | 1200×1500             |                                                         |
| `destination-goa.svg`                        | Featured destinations             | 1600×1200             |                                                         |
| `destination-jaipur.svg`                     | Featured destinations             | 1600×1200             | Inspired by Jaipur's palace architecture, not a replica |
| `destination-kerala.svg`                     | Featured destinations (lead tile) | 1600×1200             |                                                         |
| `destination-manali.svg`                     | Featured destinations (panorama)  | 2400×1000             |                                                         |
| `cta-night-ridges.svg` (+ `-portrait`)       | Closing CTA                       | 2400×1200 / 1200×1600 | Bottom fades to exactly `#171B35` (footer navy)         |
| `mood-nature-wellness.svg`                   | Discover moods (Phase 6)          | 1200×1500             | Waterfall into a misty forested valley                  |
| `mood-city-breaks.svg`                       | Discover moods (Phase 6)          | 1200×1500             | Dusk skyline, river and suspension bridge               |
| `destination-bengaluru.svg`                  | Discover destination (Phase 6)    | 1600×1200             | Glass towers behind rain-tree canopies                  |
| `destination-hyderabad.svg`                  | Discover destination (Phase 6)    | 1600×1200             | Four-minaret gateway, inspired by, not a replica        |
| `destination-mumbai.svg`                     | Discover destination (Phase 6)    | 1600×1200             | Curving seafront lit at night                           |
| `destination-delhi.svg`                      | Discover destination (Phase 6)    | 1600×1200             | Domed garden tomb and water channel, not a replica      |
| `destination-bali.svg`                       | Discover destination (Phase 6)    | 1600×1200             | Rice terraces, volcano, split gateway                   |
| `destination-kyoto.svg`                      | Discover destination (Phase 6)    | 1600×1200             | Five-storey pagoda among autumn trees                   |
| `destination-singapore.svg`                  | Discover destination (Phase 6)    | 1600×1200             | Generic night skyline over a bay, observation wheel     |
| `destination-dubai.svg`                      | Discover destination (Phase 6)    | 1600×1200             | Dunes and a generic tower skyline (no landmark replica) |

To regenerate after changing the script:

```bash
node apps/web/scripts/generate-artwork.mjs
```

## Replacing a slot with licensed photography

1. **Licence first.** Use photos you own or that are licensed for commercial
   web use. Keep the licence and source URL. Don't use images with
   recognisable people without a model release, or with third-party logos.
2. **Export optimised files** into `apps/web/public/media/photos/`:
   - Format: AVIF or WebP (JPEG fallback only if needed).
   - Hero: 2400 px wide landscape plus a 1200×2000 portrait crop; target
     ≤ 250 kB each. Keep the top 20% darkish so the white header stays legible.
   - Moods: 1200×1600 (3:4). Destinations: 1600×1200; panorama 2400×1000.
     Target ≤ 150 kB each.
   - Descriptive names: `hero-kerala-backwaters-dawn.avif`, not `IMG_2041.jpg`.
3. **Edit the manifest** (`media.ts` for the hero/CTA, `features/discover/data.ts`
   for destinations and moods): set `src` / `portraitSrc`, write a real
   `alt` describing the scene (keep `alt: ''` only for decorative hero
   layers), adjust `focalPoint` so the subject survives every crop, set
   `tone` to the photo's dominant colour (shown while loading), set
   `kind: 'photo'` and fill `credit` with the source and licence.
4. **Hero:** a single photo replaces the three layers. Keep one entry in
   `HERO_LAYERS` with a small `depth` (e.g. `0.12`).
5. **Check contrast.** Text on images must stay at 4.5:1 or above. The
   scrims in `Hero.tsx`, `DestinationsSection.tsx` and `ClosingCta.tsx` were
   tuned for the artwork; re-measure with real photos (see docs/homepage.md).
6. Run `npm run check` and look at the page at 360, 390, 768, 1024, 1280 and
   1440 px.

Images are rendered through `MediaFrame` (`@wayora/ui`), which reserves the
aspect ratio (no layout shift), lazy-loads everything except the hero, and
falls back to the `tone` colour if a file is missing.
