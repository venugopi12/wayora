# Destination discovery (Phase 6)

Discover helps people find a place, understand it, and see how they could
travel there. It runs entirely on a **curated sample dataset** bundled with the
web app. There is no discovery API yet, and nothing on these pages is live
inventory: no prices, fares, availability, ratings, reviews or deals.

## Pages

| Route                 | What it is                                                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/discover`           | Hero with destination search → explore by mood → the collection (results) → browse by region → editor's picks → trip ideas → closing CTA.                                                                                     |
| `/discover/:slug`     | One destination: breadcrumb, hero image, mood tags, editorial intro and highlights, travel options, related destinations (and a paired destination where one exists).                                                         |
| `/discover/<unknown>` | "We couldn't find that destination", with close matches ("Did you mean Jaipur?") and a link back to Discover. Deeper unknown paths (`/discover/goa/extra`) fall through to the site's not-found page.                         |
| `/flights?to=goa` …   | The service's demo search page (Phase 9, docs/search.md), with the destination prefilled where the demo covers it, a note when it doesn't, and a link back to the destination. Nothing is searched until the visitor submits. |

Both Discover routes are one lazily loaded chunk
(`apps/web/src/features/discover/routes.tsx`). Direct visits and refreshes on
nested routes work in dev and `vite preview`; production hosting must serve
`index.html` for unknown paths (standard SPA fallback).

### URL state

Filters live in the query string so a filtered view can be shared,
bookmarked and survives a refresh:

| Param    | Values                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| `q`      | Free text (trimmed, max 80 characters)                                                                          |
| `mood`   | `beach-escapes`, `mountain-retreats`, `cultural-journeys`, `nature-wellness`, `city-breaks`, `weekend-getaways` |
| `region` | `india`, `southeast-asia`, `east-asia`, `middle-east`                                                           |

Unknown values are ignored. `mood=cultural-cities` (the Phase 4 name) maps to
`cultural-journeys`. Old `?destination=<slug>` links redirect to
`/discover/<slug>`. Toggling a mood or region replaces the history entry and
keeps the scroll position; submitting a search adds an entry, so Back returns
to the previous results. `#collection` on a link scrolls to the results
(React Router's `ScrollRestoration` handles the hash).

On a destination page, `?mode=<service>` (from the homepage travel selector)
lists that service first and marks it "Your choice", but only when it applies:
rail and road are offered for the India samples only, so a choice of trains
for Bali is simply not offered.

## Data

```text
packages/contracts/src/destination.ts   destinationSchema / destinationSummarySchema (Zod), regions, moods
apps/web/src/features/discover/
  data.ts      SAMPLE summaries (12 destinations), moods, regions, editor's picks, trip pairings
  details.ts   long-form copy per destination (intro, highlights); loaded with the Discover chunk only
  search.ts    searchDestinations, filterDestinations, relatedDestinations, suggestForSlug (pure)
  paths.ts     destinationPath, discoverPath, servicePathFor, serviceForPlace
  format.ts    placeLine ("Rajasthan, India", "Indonesia", "Southeast Asia")
```

### Model

`Destination` (shared contract) has `id`, `slug`, `name`, `country`, `region`,
optional `locality`, `description` (cards), `intro` and `highlights` (detail
page), optional `image` (`src`, `alt`, `focalPoint`, `tone`, `kind`, `credit`),
`categories` (moods, at least one), `featured`, `aliases` (extra search terms)
and `sample: true`. Photos must carry a credit; artwork doesn't need one.
`DestinationSummary` is the same without `intro` / `highlights`: lists, cards
and search only need that, so the homepage and header search bundle the
summaries, and the long-form copy downloads with the Discover pages.

Deliberately absent: prices, fares, availability, ratings, reviews, deals.
Those belong to provider-backed inventory contracts in later phases. The UI
library's `priceFrom` / `rating` slots stay unused here.

### Sample set

| Region         | Destinations                                                     |
| -------------- | ---------------------------------------------------------------- |
| India          | Goa, Jaipur, Kerala, Manali, Bengaluru, Hyderabad, Mumbai, Delhi |
| Southeast Asia | Bali, Singapore                                                  |
| East Asia      | Kyoto                                                            |
| Middle East    | Dubai                                                            |

Editorial content rules: describe places in stable, well-known terms (history,
architecture, landscape, food). No safety claims, current conditions, opening
hours, travel times, prices or "best time to visit". The detail page adds:
"Sample editorial content. Check current travel advice and local conditions
before you go."

### Adding a destination

1. Add a summary to `DESTINATIONS` in `data.ts` (unique `id`/`slug`, at least
   one mood, `sample: true`).
2. Add its `intro` and 1–4 `highlights` to `details.ts`.
3. Add an image (see docs/media-assets.md) or leave `image` out: cards and the
   detail page show a branded placeholder, never a broken image.
4. Run `npm test`. `apps/web/test/discover.test.tsx` validates the whole set
   against the contract, checks every summary has details, every image file
   exists, and every slug referenced by `HOMEPAGE_FEATURED`, `DISCOVER_PICKS`
   and `PAIRINGS` exists.

### Replacing the sample data with an API

The functions in `search.ts` take the dataset as an argument. A discovery API
should return `destinationSummarySchema` lists (search/filter server-side with
the same query parameters) and `destinationSchema` for `/discover/:slug`. Swap
the bundled imports for TanStack Query hooks and drop `sample: true`; the
"Sample data" labels key off that.

## Search and filters

- **Search** (`searchDestinations`): case-insensitive, accent-insensitive
  ("Kyōto"), partial. Matches name, country, locality, region name and aliases
  (`bangalore`, `bom`, `kochi`). Ranking: name starts with the query, then any
  word starts with it, then it appears anywhere; ties keep curated order.
- **Mood and region** narrow first, then search orders the rest
  (`filterDestinations`). Region buttons show live counts for the current
  search and mood.
- **Related destinations** (`relatedDestinations`): two points per shared mood,
  one for the same region, top three, only places with something in common. If
  none, the page says so and links to the collection.
- **Empty states**: no matches (buttons to remove each filter, or clear all);
  a region with no sample destinations yet ("More destinations will be added to
  this region later").

The header search and the homepage "Where to?" field use the same dataset and
search function, and go to `/discover/<slug>`.

## Interaction and motion

Uses the Phase 5 library throughout (`Reveal`, `RevealGroup`, `LineReveal`,
`ImageReveal`, `DestinationCard`, `DestinationFeatureCard`, `PageHeader`,
`EmptyState`, `interaction` / `effects` presets).

- Hero: line-by-line headline, image collage opening from inset windows.
- Mood tiles are toggle buttons (`aria-pressed`), with hover lift and image zoom.
- Collection: cards fade and reflow (`AnimatePresence`, `layout="position"`)
  when filters change; the result count is a polite live region.
- Submitting a search, or "Show in the collection" on a region, scrolls the
  results into view (instantly under reduced motion) and moves focus to the
  results heading.
- Phones: the collection shows six cards and a "Show all 12 destinations"
  button (focus moves to the first newly shown card); moods and editor's picks
  are swipeable rows. Larger screens show the full grid, with a wider
  "split" card every fifth result.
- Reduced motion: everything renders in its final state; no content depends on
  an animation (covered by tests).

## Accessibility

- One `h1` per page; sections are `aria-labelledby` their `h2`.
- The hero search is a `role="search"` form with a labelled `searchbox`, a
  clear button and a hint that announces it is sample data.
- Cards have a single link (the destination name) covering the card; tags and
  badges are not part of its name. Travel options are named "Flights to Kyoto"
  and described as "Demo search · booking later".
- Breadcrumb `nav` with `aria-current="page"`.
- Region buttons read "Show in the collection: India" (visible text plus a
  visually hidden region name).

## Tests

`apps/web/test/discover.test.tsx` (31 tests): dataset vs contract; no price
or rating fields; image files exist; search (case, partial, alias, accents,
countries, regions, ranking); mood, region and combined filters; URL parsing;
results wording; related destinations; slug suggestions; travel options; the
page sections; card rendering; hero search into the URL and back; no-results;
mood toggles; region counts and panels; empty region; legacy redirect;
reduced motion; detail pages (deep link, breadcrumb, highlights, mood links,
travel options to the service search pages, related links, pairing); unknown slugs;
deeper unknown paths. Homepage and navigation tests cover the new links.
