# SEO, content management and destination discovery (Phase 29)

Wayora's public pages (home, Discover, destinations, themes, guides, the Help
Center, the service search pages, offers and about) are built so search
engines and social networks can read them without running JavaScript. Staff
write guides, articles, tips, FAQs, collections and landing pages in the admin
dashboard. Destination pages gain "things to see and do", linked guides and
FAQs. A small, cookieless page-view count powers "Most viewed" on Discover.

> **What this phase does not claim.** Nothing here has been submitted to a
> search engine. Indexing, rankings and rich-result eligibility are decided
> by the search engines and haven't been verified ([Search Console
> setup](#search-console-setup) says how to check them once the site is live).
> No popularity figures, ratings, prices, opening hours or availability are
> invented: "Most viewed" stays hidden until real counts exist, and destination
> pages show only the curated sample data the app already had.

## Contents

- [Before this phase](#before-this-phase)
- [Rendering](#rendering) (why prerendering)
- [URLs](#urls) and [hosting rules](#hosting-rules)
- [Metadata](#metadata) and [indexing policy](#indexing-policy)
- [Structured data](#structured-data)
- [Sitemap](#sitemap) and [robots.txt](#robotstxt)
- [Destination pages](#destination-pages), [themes](#themes) and [Discover](#discover)
- [Content model](#content-model)
- [CMS workflow](#cms) (admin)
- [Content pages](#content-pages)
- [Images](#images) and [social sharing](#social-sharing)
- [Analytics](#analytics) (privacy)
- [Internal linking](#internal-linking)
- [Accessibility](#accessibility)
- [API](#api)
- [Database](#database) and [rollback](#rollback)
- [Configuration](#configuration) and [deployment](#deployment)
- [Search Console setup](#search-console-setup)
- [Tests](#tests)
- [Limitations](#limitations)

## Before this phase

The web app was a client-rendered Vite SPA. Every URL served the same
`index.html` with one generic title and description; `useDocumentTitle` set
`document.title` after the app ran. There was no canonical link, robots
directive, Open Graph or Twitter card, structured data, sitemap or
robots.txt, and the HTML a crawler received had an empty `<div id="root">`.
Destination pages, help articles and service pages existed only after
JavaScript ran.

## Rendering

**Choice: build-time prerendering of the public, indexable pages**, keeping
the SPA for everything else. `npm run build` (in `apps/web`) runs `vite build`
and then `scripts/prerender.ts`, which writes, for each public page,
`dist/<path>/index.html`: the built app shell with that page's head tags
(title, description, robots, canonical, Open Graph, Twitter, JSON-LD) and a
semantic text version of the page inside `#root` (heading, breadcrumbs,
content, links, footer). When the JavaScript loads, React's `createRoot`
replaces that markup with the interactive page, which applies the same
metadata (`SeoProvider`).

Why this, not server rendering or a framework migration:

- The public pages are built from data the build already has (the bundled
  destination dataset, help articles, themes, the planner catalogue) plus the
  published CMS content, which the build reads from the API. Nothing on them
  is per-visitor.
- It needs no Node server in front of the static host, no hydration
  refactor of ~30 feature modules, and no change to the private, signed-in
  app, which shouldn't be indexed anyway.
- Head tags and page bodies come from the same pure builders
  (`apps/web/src/features/seo/pages.ts`) that the React pages use, so the
  prerendered HTML and the running app agree.

Costs: newly published CMS content appears in the prerendered HTML and the
sitemap after the next web build (it's visible in the app immediately, see
[hosting rules](#hosting-rules)); and the prerendered body is a simpler
version of the page than the interactive one (same text and links, no
widgets).

Files the build writes besides the pages:

| File          | What                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------- |
| `app.html`    | The app shell with `noindex, nofollow`, for client-side routes (signed-in pages, admin…)    |
| `404.html`    | The shell with a not-found page (`noindex`), for unknown URLs in fully prerendered sections |
| `sitemap.xml` | The sitemap, or a sitemap index plus `sitemap-N.xml` past 45,000 URLs                       |
| `robots.txt`  | See [robots.txt](#robotstxt)                                                                |

The build fails (non-zero exit) when `VITE_SITE_URL` is missing or unsafe,
when `PRERENDER_CONTENT_URL` is set but unreachable or returns data that
doesn't match the contract, or when two pages would share a path. Without
`PRERENDER_CONTENT_URL` it warns and builds without CMS content.

## URLs

| Path                                            | Page                                             | Source                           |
| ----------------------------------------------- | ------------------------------------------------ | -------------------------------- |
| `/`                                             | Home                                             | static                           |
| `/discover`                                     | Discover                                         | static + popular counts + CMS    |
| `/discover/:slug`                               | Destination (12, the sample dataset)             | dataset, planner catalogue, CMS  |
| `/discover/themes`                              | Theme index                                      | static                           |
| `/discover/themes/:theme`                       | Theme (6 published)                              | dataset                          |
| `/guides`                                       | Guides, articles and tips (only once one exists) | CMS                              |
| `/guides/:slug`                                 | A guide, article or tip                          | CMS                              |
| `/collections/:slug`                            | A collection                                     | CMS                              |
| `/explore/:slug`                                | A landing page                                   | CMS                              |
| `/help`, `/help/topics/:c`, `/help/articles/:s` | Help Center                                      | `packages/contracts/src/help.ts` |
| `/flights` … `/holidays`                        | The seven service search pages (without a query) | static                           |
| `/promotions`, `/about`                         | Offers, about                                    | static                           |

Slugs are lower-case words joined by hyphens (`^[a-z0-9]+(-[a-z0-9]+)*$`,
3–80 characters). All CMS types share one slug namespace, so a guide and a
collection can't both be `goa`. A slug is permanent once the entry has been
published (enforced by the API and a database trigger), so a public URL never
changes or comes back with different content. There are no trailing-slash
variants: canonical paths have none.

### Hosting rules

`apps/web/src/features/seo/hosting.ts` decides what the static host serves
for a path that has no prerendered file:

- **Fully prerendered sections** (`/discover/:x`, `/discover/themes/:x`,
  `/help/topics/:x`, `/help/articles/:x`): every valid page exists at build
  time, so anything else answers **HTTP 404** with `404.html` (the app then
  shows its own not-found state with suggestions).
- **Everything else** (CMS sections, signed-in pages, admin, offers): serve
  `app.html` with status 200. The app renders the route; for an unknown or
  unpublished CMS slug it shows the not-found page and sets
  `noindex`. These sections can't answer 404 from the host, because content
  published after the last build is real and must load.

`vite preview` implements exactly these rules (`prerenderedHostingPlugin` in
`apps/web/vite.config.ts`), so the production build can be checked locally;
[deployment.md](deployment.md#web-hosting-rules) has an nginx example.

## Metadata

Each page's metadata is a `PageMeta` (`features/seo/meta.ts`): title,
description, canonical path, robots, optional image, Open Graph type,
publish and modified dates, JSON-LD blocks. `headTags()` turns it into tags;
the prerender writes them as HTML and `SeoProvider` (in `RootLayout`) applies
them to `document.head` on every navigation, removing the previous page's
(every managed tag carries `data-seo`).

- **Title**: `<page> | Wayora` (the home page is `Wayora`). CMS entries can
  set an SEO title (≤ 60 characters) instead of their title.
- **Description**: the page's own (≤ 160 characters, clipped on a word
  boundary); CMS entries can set a meta description (50–160 characters to
  publish).
- **Canonical**: the absolute URL of the page's path (no query string). Pages
  that aren't indexable have none.
- **Open Graph / Twitter**: only on indexable pages (`og:site_name`, `og:type`
  `website` or `article`, `og:title`, `og:description`, `og:url`, `og:image`
  with width, height and alt, `og:locale` `en_IN`, `twitter:card`
  `summary_large_image`, title, description, image and alt; articles add
  `article:published_time` and `article:modified_time`).
- Pages that call `usePageMeta`: home, Discover, destinations, themes, guides
  and other CMS pages, Help Center pages, service search pages, offers,
  about. Other pages (signed-in, admin, legal drafts, status) get the
  [policy](#indexing-policy) robots value, a canonical only if indexable, the
  default description, and keep the title they set with `useDocumentTitle`.
- No private information is ever in metadata: account pages aren't
  described, and content bylines are the staff member's first name and
  initial ("Asha R."), never an email.

### Indexing policy

`features/seo/policy.ts` is an **allow list** (`INDEXABLE_PATTERNS`): only the
paths in the [URL table](#urls) can be indexed.

| Page                                                                                                                                                                                                                            | robots                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| An indexable path without a query string                                                                                                                                                                                        | `index, follow`                                  |
| An indexable path with a query string (`/discover?mood=…`, `/flights?to=goa`, `/help?q=…`)                                                                                                                                      | `noindex, follow` (canonical points to the path) |
| Not-found pages, an empty `/guides`                                                                                                                                                                                             | `noindex, follow`                                |
| Everything else: `/admin…`, `/profile…`, `/trips…`, `/book/…`, `/plans…`, `/assistant…`, `/rewards`, `/support…`, `/reviews…`, `/notifications`, `/login`, `/register`, `/offers/…`, `/legal/*` (drafts), `/status`, `app.html` | `noindex, nofollow`                              |

## Structured data

JSON-LD (`features/seo/jsonld.ts`), all with `@context: https://schema.org`:

| Page                       | Types                                                                                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home                       | `Organization` (name, URL, logo), `WebSite`                                                                                                                                                                    |
| Every other page           | `BreadcrumbList` (matches the visible breadcrumb)                                                                                                                                                              |
| Destination                | `TouristDestination`: name, description, URL, image, country, `includesAttraction` (the catalogue items that are places: sightseeing, culture, nature, beach) as `TouristAttraction` with name and description |
| Guide, article, tip        | `Article`: headline, description, image, author (`Person`, the staff byline) and publisher (`Organization`), `datePublished`, `dateModified`, `mainEntityOfPage`, `about` (linked destinations)                |
| Collection, landing, theme | `CollectionPage` with an `ItemList` of the destinations                                                                                                                                                        |

Deliberately absent: `aggregateRating`, `Review`, `Offer`, prices, opening
hours, `SearchAction` (there's no site search URL for destinations), and
**`FAQPage`**: Google shows FAQ rich results only for well-known government
and health sites, so marking up Wayora's FAQs would promise nothing. FAQs are
still plain, crawlable questions and answers on destination pages. A test
checks that no page's JSON-LD mentions prices, offers, reviews, ratings,
opening hours or FAQPage.

JSON-LD is embedded with `<` escaped (`<`), so content can't close the
script element.

## Sitemap

`features/seo/sitemap.ts`, written by the prerender:

- Every prerendered page (only indexable ones), once, without query strings,
  sorted with `/` first.
- **lastmod only when it's known and true**: CMS pages use the content's last
  change; the guides index the newest guide; destination pages the newest
  guide or FAQ linked to them (when there is one); Help pages the date the
  article was last checked (`reviewed`). Static pages have no lastmod rather
  than a made-up build date.
- Drafts, archived entries and FAQs (no page of their own) are never listed;
  the feed only returns published entries.
- Past 45,000 URLs (`MAX_URLS_PER_SITEMAP`) it writes a sitemap index
  (`sitemap.xml`) and `sitemap-1.xml`, `sitemap-2.xml` … (each index entry
  carries the newest lastmod in that file).

## robots.txt

```text
User-agent: *
Allow: /
Disallow: /admin
Disallow: /profile
Disallow: /trips
Disallow: /book/
Disallow: /notifications
Disallow: /plans
Disallow: /assistant
Disallow: /rewards
Disallow: /support
Disallow: /reviews
Disallow: /login
Disallow: /register
Disallow: /sign-in
Disallow: /offers/

Sitemap: https://<VITE_SITE_URL>/sitemap.xml
```

Assets (`/assets/`, `/media/`, fonts) and every public section are allowed, so
crawlers can render pages. robots.txt is advice: private pages are protected
by their session check and also send `noindex`. `/support` and `/reviews` are
the signed-in pages; the public help and reviews content lives under `/help`
and on destination and offer pages.

## Destination pages

`/discover/:slug` now also has:

- **Things to see and do**: up to 8 items from the curated planner catalogue
  (`packages/contracts/src/planner-catalog.ts`, moved there from the API so
  the web app and the trip planner use one list): name, category, area,
  short description and a planning estimate of time. The section says it's
  sample planning data and to check opening hours and entry rules locally. No
  opening hours, prices or availability are shown.
- **Guides to {place}** and **Questions about {place}**: published CMS
  guides, articles, tips and FAQs linked to the destination. Hidden when
  there are none.
- A **Share** button, and page-view and travel-search click counts
  ([analytics](#analytics)).

Not added: "best time to visit" (the dataset has no verified seasonal data),
destinations outside the sample dataset (for example Vijayawada or Ooty —
they'd have no data behind them), prices, ratings or deals. Unknown slugs
answer 404 with suggestions.

Offer pages (`/offers/…`) link to the destination page when the offer's city
is one of the Discover destinations ("About Goa: things to see and do…").

## Themes

`apps/web/src/features/discover/themes.ts`: editorial groupings over the
dataset's travel moods and regions, at `/discover/themes/:theme`:

| Theme                         | Rule                       |
| ----------------------------- | -------------------------- |
| `beach-destinations`          | mood "Beach escapes"       |
| `heritage`                    | mood "Cultural journeys"   |
| `nature-and-wellness`         | mood "Nature and wellness" |
| `city-breaks`                 | mood "City breaks"         |
| `weekend-getaways`            | mood "Weekend getaways"    |
| `international`               | region outside India       |
| `hill-stations` (unpublished) | mood "Mountain retreats"   |

A theme is published only with at least two destinations
(`PUBLISHED_THEMES`), so there are no thin pages: today only Manali is a
mountain retreat, so `hill-stations` has no page, no link and no sitemap
entry until a second destination is added. There's **no adventure theme**:
the dataset has no adventure mood, and no destination has more than one
adventure activity in the catalogue, so such a page would be a claim the data
doesn't support. Each theme page says it's an editorial grouping in no
particular order, not a ranking.

## Discover

`/discover` keeps its existing sections and adds, each labelled with what
it's based on:

| Section                   | Basis                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Most viewed on Wayora** | Data: destination page views in the last 30 days. Shown only when at least 3 destinations had at least 20 views each; says it's a count of page views, not a rating. |
| Latest guides             | Editorial: the 3 newest published guides, articles or tips.                                                                                                          |
| Collections               | Editorial: published collections.                                                                                                                                    |
| Browse by theme           | Editorial groupings.                                                                                                                                                 |
| Editor's picks (existing) | Editorial: unchanged.                                                                                                                                                |

There's **no "Trending"** section: trending means growth, and there isn't
enough history to measure it honestly.

## Content model

`packages/contracts/src/content.ts`; table `content_entries`.

| Type         | Public page          | Used for                                                  | To publish                                                  |
| ------------ | -------------------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| `guide`      | `/guides/:slug`      | Destination guides                                        | ≥ 300 words, introduction ≥ 40 characters, meta description |
| `article`    | `/guides/:slug`      | Travel articles                                           | ≥ 300 words, …                                              |
| `tip`        | `/guides/:slug`      | Short practical tips                                      | ≥ 80 words, …                                               |
| `faq`        | none                 | A question (title) and answer (body) on destination pages | ≥ 20 words, ≥ 1 destination                                 |
| `collection` | `/collections/:slug` | Destinations and guides grouped around an idea            | ≥ 2 destinations or related entries                         |
| `landing`    | `/explore/:slug`     | A campaign or topic page                                  | ≥ 100 words, ≥ 1 destination                                |

Fields: type (fixed after creation), slug, title (5–120), introduction
(≤ 400), body (≤ 80 blocks), cover image (a media key + alt text, or none),
SEO title (≤ 60), meta description (≤ 160), destinations (≤ 12 slugs from the
dataset), related entries (≤ 6 slugs of published entries that have pages),
author and editor (staff users), revision, timestamps (created, updated,
first published, published, archived).

**Bodies are structured blocks, never HTML**: `heading` (level 2 or 3),
`paragraph`, `list` (bullets or numbered), `tip`, `provider` (a rule set by an
airline, hotel, operator or government, shown as "Set by the provider, not
Wayora"), `image` (a media key, alt text, optional caption). Text is stored
and rendered as text (`plainText`/`plainLine` validation also rejects control
characters), so there's no markup to sanitize and nothing to inject; React
renders it as text nodes and the prerender escapes it. A level-3 heading
needs a level-2 heading before it, so the outline stays valid. Reading time
is the word count over 200 words a minute, rounded up (guides, articles and
tips only).

Publishing checks (`publishProblems` in contracts, plus the server's
`serverProblems`: destinations must exist, related entries must be published
and have pages, an entry can't relate to itself) are listed in the editor as
"Not ready to publish".

## CMS

In the admin dashboard, **Content** (`/admin/content`), reusing the existing
staff accounts, sessions and roles (no separate CMS login):

| Permission              | Support | Admin | Allows                                           |
| ----------------------- | ------- | ----- | ------------------------------------------------ |
| `admin.content.read`    | ✓       | ✓     | List, view, preview, revisions, page-view counts |
| `admin.content.edit`    | –       | ✓     | Create drafts, edit                              |
| `admin.content.publish` | –       | ✓     | Publish, archive, restore                        |

- **List**: filters (status, type, title or slug), editor, last update and
  views in the last 30 days; below it, the page-view totals panel.
- **Create**: type, title (the slug follows the title until edited), body
  blocks (add, move up or down, remove), cover image from the media library,
  destinations, related entries, SEO title and meta description with
  character counts. Saved as a private **draft**.
- **Edit**: every save needs the current revision (two editors can't
  overwrite each other: a stale save gets 409) and writes a new revision row.
  Editing a published entry keeps it published only if it still passes the
  publishing checks.
- **Preview**: the saved version rendered with the public page component;
  admin pages are `noindex, nofollow`.
- **Publish**: only when there are no problems. **Archive**: takes the page
  down (404) unless a published entry still links to it (unlink it first).
  **Restore**: back to draft.
- **Revisions**: every saved version, with status, editor and time. Entries
  and revisions are never deleted (database triggers).
- **Audit**: `content.created`, `content.updated`, `content.published`,
  `content.archived`, `content.restored`, with the staff member, entry and
  revision.

## Content pages

`apps/web/src/features/content/`: `/guides`, `/guides/:slug`,
`/collections/:slug`, `/explore/:slug`. Each page has breadcrumbs, one `h1`,
the type, introduction, byline ("By Asha R., Wayora team"), published and
updated dates (`<time>`), reading time, cover image, the body, linked
destinations (cards) and related reading; loading skeletons, an error state
with retry, and a not-found page (`noindex`). Guides, articles and tips are
`<article>` elements; tips and provider notes are labelled notes
(`role="note"`).

## Images

- Only Wayora's own artwork: the 12 destination illustrations
  (`/media/artwork/destination-*.svg`, 1600 × 1200) are the CMS media library
  (`MEDIA_KEYS`). Editors can't enter an image URL, so no external or
  unlicensed image becomes permanent content.
- Every image has width and height (no layout shift), alt text (required in
  the editor, 5–200 characters), and `loading="lazy"` except the page's main
  image. Destination cards keep their responsive `sizes`.
- **Social images**: 1200 × 630 JPEGs in `apps/web/public/media/og/`
  (`destination-<slug>.jpg`, `default.jpg`, and `logo.png` for the
  `Organization` logo), generated from the same artwork by
  `scripts/generate-og-images.mjs` (Playwright screenshots; run it again when
  the artwork changes: `PLAYWRIGHT_MODULE=<path to playwright> node
scripts/generate-og-images.mjs`). Social crawlers don't render SVG, hence
  JPEGs.

## Social sharing

Indexable pages carry Open Graph and Twitter tags (see [metadata](#metadata)).
Destination and content pages have a **Share** button: the system share sheet
(`navigator.share`) where available, otherwise it copies the canonical URL and
says "Link copied". Nothing about the visitor is added to shared links.

## Analytics

First-party, cookieless **daily totals**, table `content_daily_counts`
(`day`, `event`, `key`, `count`). There's no user, session, cookie, IP
address, user agent or referrer in it.

| Event                      | Key                       | When                                      |
| -------------------------- | ------------------------- | ----------------------------------------- |
| `destination_view`         | destination slug          | A destination page opens                  |
| `content_view`             | content slug              | A guide, collection or landing page opens |
| `destination_search_click` | `<destination>:<service>` | A travel option on a destination page     |
| `content_link_click`       | content slug (the source) | A link out of a content page              |

- The browser sends `POST /api/v1/analytics/events` with
  `credentials: 'omit'` (no cookie, so not tied to a signed-in account) and
  `keepalive`; failures are ignored.
- **Nothing is sent** when the browser sends Do Not Track or Global Privacy
  Control.
- The server counts only keys that exist (dataset destinations, services,
  published content) and rate-limits events per client address
  (`ANALYTICS_RATE_LIMIT_MAX`, 120 a minute); the address is only the limiter
  key and isn't stored with the count.
- Counts are page loads, not people: refreshes count again, bots that run
  JavaScript may count, and DNT/GPC visitors don't. The admin panel says so.
- Used for: "Most viewed" on Discover, views per entry in the admin list, and
  the admin totals panel (top destinations, top content, searches from
  destination pages). No other analytics, advertising or third-party scripts
  are loaded. The Help Center article "Does Wayora use cookies?" and the
  draft privacy page describe this.

## Internal linking

Header and footer navigation, breadcrumbs on every page (also in the
prerendered HTML), destination → guides, FAQs, related destinations, travel
searches and the planner; guide → destinations and related reading;
collection → destinations and guides; theme → destinations and other themes;
Discover → themes, guides, collections; offer → destination. Links are plain
`<a href>` in the prerendered HTML, so crawlers can follow them.

## Accessibility

One `h1` per page and a valid heading order (enforced for CMS bodies);
landmarks (`header`, `nav`, `main`, `footer`) in both the app and the
prerendered HTML; labelled sections and regions; alt text required for
every content image; `<time>` for dates; the share button announces "Link
copied" through a live region; editor controls are labelled ("Move block 3
up"); FAQs use the accessible accordion; the prerendered HTML has
`lang="en"` from the shell. The production build was checked with axe in a
browser ([tests](#tests)).

## API

| Method and path                                          | Who                     | What                                                                                         |
| -------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| `GET /api/v1/content?type=&destination=&page=&pageSize=` | anyone                  | Published entries (no bodies, except FAQ answers); `type=guides` = guides, articles and tips |
| `GET /api/v1/content/feed`                               | anyone                  | Every published entry with its body (for the web build)                                      |
| `GET /api/v1/content/guides\|collections\|explore/:slug` | anyone                  | One published entry (404 otherwise)                                                          |
| `POST /api/v1/analytics/events`                          | anyone (rate-limited)   | `{event, key}` → 202 `{counted}`                                                             |
| `GET /api/v1/discover/popular`                           | anyone                  | Most-viewed destinations (empty unless enough data)                                          |
| `GET /api/v1/admin/content`, `/stats?days=`, `/:id`      | `admin.content.read`    | List, totals, one entry (fields, problems, revisions, preview, allowed actions)              |
| `POST /api/v1/admin/content`                             | `admin.content.edit`    | Create a draft (duplicate slug: 409)                                                         |
| `PATCH /api/v1/admin/content/:id`                        | `admin.content.edit`    | Edit, with `revision` (stale: 409)                                                           |
| `POST /api/v1/admin/content/:id/status`                  | `admin.content.publish` | `{action: publish\|archive\|restore, revision}`                                              |

Public responses are cacheable for 60 seconds.

## Database

Migration `database/migrations/20261108000000_content` (additive):

- enums `content_type`, `content_status`;
- `content_entries` (unique slug; CHECKs on slug format, body type, cover,
  publish and archive dates; GIN index on destinations);
- `content_revisions` (primary key entry + revision; append-only);
- `content_daily_counts` (primary key day + event + key);
- triggers: entries can't be deleted; revisions can't be changed or deleted;
  type, author and creation time are immutable; every update must raise the
  revision; a published slug and first publication date are permanent.

### Rollback

The migration only adds objects. To roll back the code, deploy the previous
release: the old code ignores these tables. To remove them (losing all
content and counts), after a backup:

```sql
DROP TABLE content_daily_counts, content_revisions, content_entries;
DROP FUNCTION content_prevent_delete, content_append_only, content_entries_guard;
DROP TYPE content_status, content_type;
```

## Configuration

| Variable                   | Where           | Notes                                                                                      |
| -------------------------- | --------------- | ------------------------------------------------------------------------------------------ |
| `VITE_SITE_URL`            | web, build time | **Required for production builds**: the public origin (`https://…`, no path). Public value |
| `PRERENDER_CONTENT_URL`    | web, build time | Optional API origin to read published content from. Not a `VITE_` variable                 |
| `ANALYTICS_RATE_LIMIT_MAX` | API             | Events per client address per minute (default 120)                                         |

## Deployment

1. Deploy the API (with the migration) first, so `/content/feed` exists.
2. Build the web app with the public URLs:

   ```bash
   VITE_API_BASE_URL=https://api.wayora.example \
   VITE_SITE_URL=https://www.wayora.example \
   PRERENDER_CONTENT_URL=https://api.wayora.example \
   npm run build
   ```

3. Configure the static host with the [hosting rules](#hosting-rules)
   ([deployment.md](deployment.md#web-hosting-rules)).
4. **Rebuild the web app after publishing or archiving content** (or on a
   schedule) so the prerendered pages and the sitemap include it. Until then,
   new content still loads in the app at its URL, and an archived page shows
   the app's not-found state, but its prerendered HTML remains until the next
   build.

## Search Console setup

Not done in this phase (it needs the live domain). Once the site is public:

1. Verify the domain in Google Search Console (DNS TXT record) and Bing
   Webmaster Tools.
2. Submit `https://<site>/sitemap.xml`.
3. Use URL Inspection on a destination page and a guide to see the rendered
   HTML and indexing status; use the Rich Results Test on a guide (Article)
   and a destination page (breadcrumbs).
4. Check Coverage for unexpected "Indexed" private paths (there should be
   none) and soft 404s.

## Tests

| Where                                       | What                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/test/content.test.ts`   | Slugs, block validation, reading time, publishing checks, media keys, analytics keys                                                                                                                                                                             |
| `apps/api/test/integration/content.test.ts` | RBAC, drafts invisible, publishing checks, feed and lists, slug rules, revisions and audit, archive and restore, counting real keys only, rate limit, popular threshold, database triggers                                                                       |
| `apps/api/test/admin-unit.test.ts`          | The new permissions per role                                                                                                                                                                                                                                     |
| `apps/web/test/seo.test.ts`                 | Indexing policy, head tags, escaping, structured data validity, prerendered pages (unique, indexable, one h1, breadcrumbs), sitemap (dedupe, no query strings, index split), robots.txt, hosting rules, site URL                                                 |
| `apps/web/test/content.test.tsx`            | Guide page (semantics, metadata, JSON-LD, count), markup shown as text, not-found and empty index noindex, share fallback, DNT/GPC, themes, destination additions, "Most viewed" threshold, admin CMS (support read-only, edit, publish, archive), admin noindex |
| Production build (manual run)               | The built `dist/` inspected (head tags, bodies, sitemap, robots, 404 rules) and checked with axe in Chromium                                                                                                                                                     |

## Limitations

- Prerendered HTML and the sitemap update only when the web app is rebuilt.
- Content published after the last build is served through `app.html`, whose
  raw HTML says `noindex, nofollow` until the app runs and applies the page's
  own robots value. Crawlers that don't render JavaScript (and some that
  defer rendering) won't index it until the next build prerenders it, so
  rebuild after publishing.
- CMS sections can't return HTTP 404 from a static host for unknown slugs (the
  app shows not-found with `noindex`); fully prerendered sections can.
- The prerendered body is a text version of the page, not the interactive
  one; anything the app adds after loading (reviews, popular destinations)
  isn't in it.
- No scheduled publishing, no image uploads (the media library is the 12
  destination illustrations), no translations, no editor locking (stale saves
  are refused instead).
- Page-view counts are approximate (see [analytics](#analytics)); there's no
  "trending".
- Search engine indexing, ranking and rich results are unverified until the
  site is live and checked in Search Console.
