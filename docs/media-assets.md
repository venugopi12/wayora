# Media assets

Images are listed in two places; components never hard-code image paths:

- `apps/web/src/features/home/media.ts`: homepage hero layers and closing CTA.
- `apps/web/src/features/discover/data.ts`: every destination's `image` and
  every mood's `image` (used by the homepage, Discover and destination pages).
  The test suite checks each path exists in `apps/web/public` and has alt text.

## Current assets: photographs

Every image slot uses a real photograph from [Unsplash](https://unsplash.com),
under the [Unsplash License](https://unsplash.com/license) (free to use,
commercially too; credit not required, given anyway). No paid "Unsplash+"
photos. Each destination photo is tagged on Unsplash as taken in the place it
illustrates. Demo search results (hotels, flights and so on) deliberately
have no photos: the listings are invented, and a real photo would suggest a
real property.

The list is `apps/web/scripts/photos.manifest.json` (page, photographer,
place). The files are **downloaded, not committed** (yet):

```bash
npm run photos              # fetch anything missing
npm run photos -- --force   # fetch everything again
```

`apps/web/scripts/fetch-photos.mjs` asks Unsplash's image server for the
exact sizes the app uses and writes them to `apps/web/public/media/photos/`
(WebP) and `apps/web/public/media/og/` (JPEG social cards, 1200×630). The
site serves them itself; nothing is loaded from another site at runtime.
The Vercel web build (`scripts/vercel/build-web.sh`) and CI run it; a failed
download fails the build, so a deployment never goes live with missing
images. Run it once after cloning, before `npm test` (one test checks every
image file exists). Committing the downloaded files is fine and removes the
build's dependency on Unsplash.

| Slot                     | Place                            | Photographer      | Source                                                                                                            |
| ------------------------ | -------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `hero-mountain-dawn`     | Kedarkantha, Uttarakhand, India  | Karthik B K       | [photo](https://unsplash.com/photos/a-view-of-a-mountain-range-at-sunset-6yzwQhC1bJE)                             |
| `cta-night-peak`         | Nanga Parbat                     | Haseeb Jamil      | [photo](https://unsplash.com/photos/snowy-mountain-peak-under-starry-sky-3s85IxVDyXE)                             |
| `destination-goa`        | Goa, India                       | alexey turenkov   | [photo](https://unsplash.com/photos/blue-body-of-water-under-sunny-sky-bWJiSZjIgTM)                               |
| `destination-jaipur`     | Jaipur, Rajasthan, India         | Roberto Reposo    | [photo](https://unsplash.com/photos/hawa-mahal-india-LgQoL6eOdHs)                                                 |
| `destination-kerala`     | Alappuzha, Kerala, India         | Abhishek Prasad   | [photo](https://unsplash.com/photos/houseboat-on-alappuzha-backwaters-ii0oWs5abCo)                                |
| `destination-manali`     | Manali, Himachal Pradesh, India  | Naman jaswani     | [photo](https://unsplash.com/photos/town-below-snow-covered-mountains-Xpwj1j1HX34)                                |
| `destination-bengaluru`  | Bangalore, Karnataka, India      | zablanca_clicks   | [photo](https://unsplash.com/photos/a-large-building-with-a-lot-of-people-around-it-ZB9Mad3xL8Q)                  |
| `destination-hyderabad`  | Hyderabad, Telangana, India      | Kanishq Kancharla | [photo](https://unsplash.com/photos/charminar-in-hyderabad-india-stands-tall-pWH7AigRk18)                         |
| `destination-mumbai`     | Mumbai, Maharashtra, India       | Nishith Parikh    | [photo](https://unsplash.com/photos/a-body-of-water-with-a-city-in-the-background-nsunJX3Q9lg)                    |
| `destination-delhi`      | Humayun's Tomb, New Delhi, India | Shubham Sharma    | [photo](https://unsplash.com/photos/a-large-building-with-a-fountain-in-front-of-it-pwPSbwExzcY)                  |
| `destination-bali`       | Sidemen, Bali, Indonesia         | Geio Tischler     | [photo](https://unsplash.com/photos/person-walking-through-green-rice-terraces-7hww7t6NLcg)                       |
| `destination-kyoto`      | Kyoto, Japan                     | Leo Bayard        | [photo](https://unsplash.com/photos/a-tall-building-with-a-tower-in-the-middle-of-it-RvFpCWrMuts)                 |
| `destination-singapore`  | Singapore                        | Danny de Groot    | [photo](https://unsplash.com/photos/white-boat-on-water-near-city-buildings-during-daytime-kUsaVA68ZbU)           |
| `destination-dubai`      | Dubai, United Arab Emirates      | David Rodrigo     | [photo](https://unsplash.com/photos/burj-khalifa-and-highway-in-dubai-Fr6zexbmjmc)                                |
| `mood-beach-escapes`     | Gokarna, Karnataka, India        | Shashank Hegade   | [photo](https://unsplash.com/photos/people-near-shore-jUUox80nXtQ)                                                |
| `mood-mountain-retreats` | Adi Kailash, Uttarakhand, India  | Jonathan Charles  | [photo](https://unsplash.com/photos/a-mountain-range-with-snow-capped-mountains-in-the-background-CS3hS-zvI_k)    |
| `mood-cultural-cities`   | Jaipur, India                    | Annie Spratt      | [photo](https://unsplash.com/photos/ornate-brass-door-in-jaipur-KovxPeamVts)                                      |
| `mood-weekend-getaways`  | Nainital, Uttarakhand, India     | Shivansh Singh    | [photo](https://unsplash.com/photos/gray-concrete-road-between-green-trees-during-daytime-T3pH4k0jz8g)            |
| `mood-nature-wellness`   | India                            | Varad Parulekar   | [photo](https://unsplash.com/photos/waterfalls-in-the-middle-of-green-trees-_Y84HXfunEM)                          |
| `mood-city-breaks`       | Powai, Mumbai, India             | Zoshua Colah      | [photo](https://unsplash.com/photos/a-sprawling-cityscape-illuminated-at-night-with-a-highway-bridge-3JrvkmayEow) |

Sizes: hero 2400×1500 and 1200×2000 (phones); closing banner 2000×1000 and
1000×1334; destinations 1200×900 (Manali 2000×834, a panorama); moods
840×1120. About 60–250 kB each, 4.6 MB in total.

The original SVG artwork (`media/artwork/`, `generate-artwork.mjs`,
`generate-og-images.mjs`) is no longer used by the app and is kept only for
reference.

## Replacing a photograph

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
