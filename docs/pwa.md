# Mobile experience and installable app (Phase 30)

Wayora can be installed from the browser as an app, keeps working for
public pages people already opened when the connection drops, can send
browser push notifications, and has phone-first navigation. It is the same
React web app; nothing about booking, payment or account security changes.

> **What this does not do.** Bookings, payments, cancellations, refunds and
> supplier reservations are never made, saved or queued offline: without a
> connection they're refused at once with "nothing was sent". Personal data
> (trips, bookings, payments, account, notifications) is never stored for
> offline use. Push notifications are sent only when the server has VAPID keys
> configured (it doesn't by default) and only to devices where the person
> turned them on.

## Contents

- [Before this phase](#before-this-phase)
- [Architecture](#architecture)
- [Manifest](#manifest) and [icons](#icons)
- [Service worker](#service-worker): [caching](#caching), [updates](#updates), [kill switch](#kill-switch)
- [Offline](#offline)
- [Shared devices](#shared-devices)
- [Install](#install)
- [Push notifications](#push)
- [Navigation](#navigation) and [safe areas](#safe-areas)
- [Search results](#search-results) and [checkout](#checkout)
- [Performance](#performance) (measurements)
- [Accessibility](#accessibility)
- [Configuration](#configuration) and [deployment](#deployment)
- [Browser compatibility](#browser-compatibility)
- [Tests](#tests)
- [Limitations](#limitations)

## Before this phase

No manifest, service worker, app icons (only `favicon.svg`) or install
support. The site was already responsive: an audit at 320, 360, 390, 430
and 768 px wide found no horizontal scrolling and no axe violations
(WCAG 2.2 AA rules included) on 15 pages, a slide-in menu on phones,
filters in a side sheet on search results, idempotent booking and payment
requests with duplicate-click protection, and `Cache-Control: no-store` on
every personal API response. Small touch targets were limited to inline
footer, breadcrumb and legal links (17–22 px tall).

## Architecture

| Part                     | Where                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| Manifest, precache rules | `apps/web/config/pwa.ts` (used by `vite.config.ts`)                                             |
| Service worker           | `apps/web/src/sw.ts`, built by `vite-plugin-pwa` (injectManifest) with Workbox 7 modules        |
| What may be cached       | `apps/web/src/pwa/cache-policy.ts` (pure, unit-tested)                                          |
| Registration and updates | `apps/web/src/pwa/register.ts` (workbox-window, loaded on demand)                               |
| Install offer            | `apps/web/src/pwa/install.ts`, `PwaNotices.tsx`                                                 |
| Connection state         | `apps/web/src/pwa/online.ts`, `ConnectivityBanner`, `OfflineDataNote`                           |
| Push (browser side)      | `apps/web/src/pwa/push.ts`, `push-payload.ts`; the panel on `/notifications`                    |
| Push (server side)       | API `notifications` module (subscriptions, queueing); worker `notifications/push.ts` (delivery) |
| Offline page             | `apps/web/public/offline.html`, `offline.js`                                                    |
| Phone navigation bar     | `apps/web/src/features/navigation/MobileTabBar.tsx`                                             |

`vite-plugin-pwa` 2.0 (maintained, supports Vite 8) builds the worker and
the manifest; the worker's code is ours, so every caching rule is explicit.
It's a build-time dependency only; the app loads `workbox-window` lazily
when registering.

## Manifest

`/manifest.webmanifest` (linked from every page, including prerendered ones):

| Field                             | Value                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `id`, `start_url`, `scope`        | `/`                                                                                                       |
| `name` / `short_name`             | "Wayora: flights, hotels, trains, buses and holidays" / "Wayora"                                          |
| `display`                         | `standalone` (`display_override`: standalone, minimal-ui)                                                 |
| `theme_color`, `background_color` | `#faf9f6` (the header and page colour, so the status bar blends in; the icon carries the brand `#5463B1`) |
| `icons`                           | 192 and 512 px (`any`), 512 px `maskable`                                                                 |
| `shortcuts`                       | Search flights, Search hotels, My trips                                                                   |
| `lang`, `dir`, `categories`       | `en-IN`, `ltr`, `travel`                                                                                  |

`index.html` adds `viewport-fit=cover` (for safe areas; zoom is not
restricted), `apple-touch-icon`, `mobile-web-app-capable` and the iOS title.

### Icons

Generated from Wayora's mark (the favicon drawing) by
`apps/web/scripts/generate-app-icons.mjs` into `public/icons/`:
`icon-192.png`, `icon-512.png`, `maskable-512.png` (mark inside the central
80% safe zone), `apple-touch-icon.png` (180 px, full-bleed) and
`badge-96.png` (white mark for Android's status bar). Re-run after changing
the mark:

```bash
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs node apps/web/scripts/generate-app-icons.mjs
```

## Service worker

Production builds only. `main.tsx` registers `/sw.js` after the page's
`load` event (so it never competes with start-up) on secure origins with
service-worker support; development never registers one. If registration
fails (blocked, unsupported, a broken deploy), the app works the same
without it.

### Caching

| Requests                                                                                                                    | Strategy                                                   | Cache (`-v1`)       | Limits                           |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------- | -------------------------------- |
| App shell: the start-up JavaScript and CSS, icons, offline page                                                             | Precache (revisioned; old precaches removed on activation) | Workbox precache    | ~1.1 MB raw, 28 files (measured) |
| Other `/assets/*` (hashed route chunks, fonts)                                                                              | Cache first                                                | `wayora-assets`     | 150 entries, 30 days             |
| `/media/*`, `/icons/*`, favicon                                                                                             | Stale-while-revalidate                                     | `wayora-media`      | 80 entries, 30 days              |
| Public pages (the [indexable allow list](seo.md#indexing-policy))                                                           | Network first (4 s), saved copy when offline               | `wayora-pages`      | 40 pages, 14 days                |
| Public API reads: published content lists and entries, popular destinations, catalogue                                      | Network first (4 s), `credentials: omit`                   | `wayora-public-api` | 60 entries, 7 days               |
| Private pages (trips, checkout, payments, account, admin, sign-in…)                                                         | Network only; offline page when offline                    | none                | —                                |
| Every other API request (sessions, bookings, payments, notifications, rewards, support, planner, assistant, search, admin…) | Not handled by the worker                                  | none                | —                                |
| Any `POST`, `PATCH`, `PUT`, `DELETE`                                                                                        | Not handled by the worker (never queued)                   | none                | —                                |

A response is stored only if it's a `200`, not opaque, has no `Set-Cookie`,
and its `Cache-Control` has neither `no-store` nor `private`; public API
answers must also say `public` (the API sends `public, max-age=60` for them).
Search is not cached: answers are `no-store` and demo prices are per search.
Cache names carry `CACHE_VERSION`; bumping it (or any cache this worker
doesn't know) gets the old caches deleted when the new worker activates.

### Updates

A new deploy changes `sw.js`; browsers check it on navigation, and the app
also checks hourly and when the tab returns. The new worker installs in the
background and **waits**; the page shows "A new version of Wayora is ready ·
Reload". Only when the person chooses does it take over (`SKIP_WAITING`) and
the page reloads, so an open tab never runs old and new code together. The
very first install takes control at once (nothing to mix with). Hosts must
serve `sw.js` with `Cache-Control: no-cache` ([deployment](#deployment)).

### Kill switch

Build with `VITE_PWA=off` and deploy. The app stops registering a worker,
and the new `sw.js` (vite-plugin-pwa's self-destroying worker) is picked up
by every browser that had the old one on its next visit: it unregisters
itself, deletes its caches and reloads open Wayora tabs once. Use it if a
worker ever misbehaves in production. (Checked: the build produces that
worker; it wasn't exercised in a browser.)

## Offline

- **Connection bar** under the header while offline: "You're offline. Pages
  saved on this device may be out of date. Searching, booking, payments and
  account changes need a connection, and nothing is sent until you're back
  online." Then "Back online." for a few seconds.
- **Saved public pages** (home, destinations, themes, guides, help, service
  pages people opened) open offline from the pages cache; their public API
  answers come from the public API cache. Guides start from the copy built
  into the page.
- **Anything else** offline: `offline.html` (what works, what doesn't, "Try
  again", reloads by itself when the connection returns).
- **Personal data already on screen** (My trips, a booking, a payment status)
  gets "You're offline. … as loaded at 10:42; it may have changed since."
  Reads pause while offline and refresh on reconnecting (React Query).
- **Changes are never queued.** The API client refuses any non-`GET`
  request while the browser is offline (`OFFLINE`: "You're offline, so
  nothing was sent"), and React Query's mutations run immediately
  (`networkMode: 'always'`) instead of pausing and firing on reconnect. The
  booking "Confirm" and payment "Pay" buttons are disabled offline with an
  explanation, and their error messages say nothing was sent. Booking and
  payment requests keep their idempotency keys, so a retry after a real
  network failure can't create a second booking or payment.

## Shared devices

Personal API answers are `no-store` and never cached by the worker. On
sign-out (or when the session ends), the app drops account data from memory
(as before) and now also:

- removes this browser's **push subscription** (in the browser and on the
  server) before signing out; the server also stops pushing to a session
  once it's signed out or expired;
- asks the worker to delete the saved **pages and public API** caches;
- forgets **recent searches** typed on this device.

A push subscription is one browser profile: if someone else signs in and
turns push on, it moves to their account.

## Install

`src/pwa/install.ts` decides what to offer; nothing is offered when the
browser can't install or the app is already running installed
(`display-mode: standalone`, or `navigator.standalone` on iOS):

| Browser                                                     | Offer                                       |
| ----------------------------------------------------------- | ------------------------------------------- |
| Chrome, Edge, Samsung Internet (fire `beforeinstallprompt`) | "Install" button → the browser's own dialog |
| Safari on iPhone/iPad                                       | Steps: Share → Add to Home Screen           |
| Safari 17+ on Mac                                           | Steps: File → Add to Dock                   |
| Firefox, others                                             | Nothing (no button that does nothing)       |

Where: "Install the app" in the phone menu, and a small dismissible card on
My trips ("Keep your trips one tap away"). The dialog explains the benefits.
Dismissing (the card's "Not now", or "Cancel" in the browser's dialog) hides
the card for 30 days in this browser; the menu entry stays.

## Push

Real Web Push (RFC 8030) with VAPID (RFC 8292) and `aes128gcm` encryption
(RFC 8291), through the `web-push` library in the worker. Browsers' own push
services (Google FCM, Mozilla, Apple) carry the messages; they see only
ciphertext.

**Turned on per device**, from **Notifications → Notifications on this
device**: the panel explains what's sent; the browser's permission question
appears only after pressing "Turn on for this device". Never on page load.
It handles: server not set up, browser without push, iPhone/iPad Safari
outside the installed app (iOS 16.4+ supports push only for home-screen
apps), permission blocked, on, off.

**Topics** (all on by default, per account): booking updates (saved,
confirmed, cancelled, expired, failed; trip changes), payment updates
(succeeded, failed, refunded), travel reminders, support replies, rewards.
Payment "processing", plan activity and staff queue alerts stay in-app only.

**Server side:**

- `push_subscriptions` (endpoint, the browser's public key and auth secret,
  user, **session**, failure count, last success). Saved with
  `POST /api/v1/notifications/push/subscriptions`, removed with
  `DELETE` (only the owner's).
- When a notification is created, a `PUSH` row is queued in the same outbox
  as email (`notification_deliveries`, one per notification and channel) if
  the topic is on and the user has a device whose session is still signed
  in.
- The worker's `PushDispatcher` leases `PUSH` rows (the email dispatcher only
  takes `EMAIL` rows), sends to each signed-in device, and records the
  outcome: `SENT` if any device accepted it; retry with backoff (up to 5
  attempts) only when every device failed temporarily (`429`, `5xx`,
  network); `FAILED` otherwise; `NOT_CONFIGURED` without VAPID keys. A
  device the push service reports gone (`404`/`410`) is deleted.
- **Duplicates:** one row per notification (unique), one notification per
  event (dedupe key); the message's `tag` makes the browser replace rather
  than add, and the `Topic` header lets the push service replace an
  undelivered copy.
- **Clicks** open the related page (`/trips/<ref>`, the payment, the support
  request, `/rewards`, otherwise `/notifications`) in an open Wayora window
  or a new one; only paths on this site are accepted.

### Setup

```bash
npx web-push generate-vapid-keys   # once; keep the private key secret
```

| Variable                        | Where                         | Value                                         |
| ------------------------------- | ----------------------------- | --------------------------------------------- |
| `VAPID_PUBLIC_KEY`              | API and worker                | the public key (same in both)                 |
| `VAPID_PRIVATE_KEY`             | worker only, **secret store** | the private key                               |
| `VAPID_SUBJECT`                 | worker                        | `mailto:ops@your-domain` or an `https://` URL |
| `PUSH_SUBSCRIBE_RATE_LIMIT_MAX` | API                           | turn on/off per user per hour (default 20)    |

The worker refuses to start with only some of them, or with malformed keys.
Rotating the key pair invalidates existing subscriptions (people turn push
on again).

## Navigation

Below `lg` (1024 px), a bar fixed to the bottom edge: **Home · Search · Trips
· Rewards · Account** (or **Sign in**). The current section is marked
(`aria-current="page"`, filled icon background). **Search** opens a bottom
sheet with the seven services and Destinations. The header keeps the menu,
destination search and the notification bell (with its unread count), so
nothing is duplicated except quick access to Trips and Rewards. The bar:

- reserves its own space (a spacer of `--tab-bar-h` + the home-indicator
  inset after the footer), so it never covers content;
- hides on checkout and payment pages, which have their own actions there;
- slides away (and leaves the tab order) while a text field has focus on a
  touch device, so it doesn't ride on top of the on-screen keyboard;
- has 56 px tall targets.

The phone menu's rows now animate with CSS instead of per-row JavaScript
(see [performance](#performance)).

### Safe areas

`viewport-fit=cover` with `env(safe-area-inset-*)` padding on the bottom bar,
the phone menu and sheets (top/right/bottom), the checkout price bar, and
the offline page. Zoom and text scaling are not restricted.

## Search results

On phones, **Filters (n)** and **Sort by** sit side by side in a row that
sticks under the header while scrolling the results, so both stay in reach
on a long list (on larger screens they stay where they were). Filters keep
living in the URL, so Back, sharing and pagination behave as before. Footer,
breadcrumb and legal links get a larger touch area (about 32 px) without
changing the layout.

## Checkout

Below `lg`, where the price summary sits under the form, a bar at the bottom
edge shows the **total** with a "Price details" link to the full summary. It
is information only (each step's buttons stay in the form), the page keeps
room for it, and it steps aside while typing. Steps, idempotency and
duplicate-click protection are unchanged; the offline behaviour is above.

## Performance

Lab measurements of the production build (`vite preview`, API running) in
Chromium with a Pixel 7 viewport, **4× CPU slowdown** and a **~1.6 Mbit/s,
150 ms** network; median of 5 first-visit loads per page, before (commit
`a60344e`, Phase 29) and after this phase, on the same machine. INP is one
interaction: opening the phone menu. Lab numbers, not field data; real
devices vary. Reproduce with `apps/web/scripts/measure-mobile.mjs`.

| Page            | LCP before → after | CLS before → after | INP (menu) before → after | JS transferred before → after |
| --------------- | ------------------ | ------------------ | ------------------------- | ----------------------------- |
| `/`             | 3.74 s → 3.40 s    | 0.011 → 0.011      | 184 → 208 ms              | 341 → 298 KB                  |
| `/discover/goa` | 4.18 s → 2.05 s    | 0 → 0              | 176 → 232 ms              | 384 → 359 KB                  |
| a guide         | 3.89 s → 2.03 s    | **0.368 → 0.001**  | 176 → 160 ms              | 356 → 326 KB                  |
| `/flights`      | 3.75 s → 3.40 s    | 0.005 → 0.005      | 176 → 168 ms              | 368 → 343 KB                  |
| flight results  | 3.76 s → 3.39 s    | 0.014 → 0.024      | 176 → 224 ms              | 368 → 343 KB                  |

Start-up JavaScript (what every page loads first, gzip): **320 KB → 282 KB**.
FCP stayed at about 1.2 s (the prerendered HTML).

What changed, and why (each found by measuring):

- **Start-up JavaScript −38 KB gzip (−12%)**: `react-hook-form` moved out of
  the always-loaded vendor chunk (only form pages load it), and the home
  page's metadata and its offers block no longer pull in the prerender's
  page builders with the Help Center and planner data. `workbox-window` is
  loaded only when registering the worker, after `load`.
- **LCP**: prerendered pages preload their largest image (destination
  artwork, guide cover, the home hero's back layer — portrait art on phones).
- **CLS on guides (0.368 → 0.001)**: the prerendered HTML carries the
  published entry as JSON and the page starts from it, instead of replacing
  the server-rendered text with a loading skeleton and then the content.
- **Phone menu**: its row animation is now CSS (compositor) instead of eight
  JavaScript-driven animations. The measured INP for opening the menu did
  not improve beyond run-to-run noise (about 160–260 ms at 4× slowdown across
  runs); most of it is rendering the menu dialog itself. No improvement is
  claimed.
- Flight results CLS rose from 0.014 to 0.024 (still well under the 0.1
  "good" threshold); not investigated further.

Not changed: the home page LCP is still the hero illustration painted by
React after the start-up JavaScript (~3.4 s in this lab profile, above the
2.5 s target); rendering the hero in the prerendered HTML is the next step.

## Accessibility

- Bottom bar: a labelled `nav` ("Quick links"), real links with
  `aria-current`, a button with `aria-haspopup="dialog"` for Search; visible
  focus ring; 56 px targets; `inert` while hidden.
- Sheets and dialogs (search, filters, install, menu): focus trapped and
  restored, Escape to close, labelled titles (Radix).
- Notices use `role="status"`; offline-disabled buttons are described by
  their explanation (`aria-describedby`).
- Reduced motion: every animation (sheets, menu rows, bar slide) is reduced
  by the global `prefers-reduced-motion` rule; nothing depends on animation.
- Checked with axe (WCAG 2.2 AA + best practices) in Chromium at 320, 360,
  390, 430 and 768 px.

## Configuration

| Variable                        | Where           | Default           | Notes                                                                 |
| ------------------------------- | --------------- | ----------------- | --------------------------------------------------------------------- |
| `VITE_PWA`                      | web, build time | (on)              | `off` builds the self-destroying worker ([kill switch](#kill-switch)) |
| `VAPID_PUBLIC_KEY`              | API, worker     | (empty: push off) | [Push setup](#setup)                                                  |
| `VAPID_PRIVATE_KEY`             | worker          | (empty)           | **Secret**                                                            |
| `VAPID_SUBJECT`                 | worker          | (empty)           | `mailto:` or `https:`                                                 |
| `PUSH_SUBSCRIBE_RATE_LIMIT_MAX` | API             | 20                | per user per hour                                                     |

## Deployment

- Serve `sw.js` and `manifest.webmanifest` from the site root with
  `Cache-Control: no-cache` (the worker must be re-checked on every
  navigation); `manifest.webmanifest` as `application/manifest+json`.
- Keep `/assets/*` immutable and long-cached (unchanged); `offline.html`,
  `offline.js` and `/icons/*` are ordinary static files.
- The CSP already allows `worker-src 'self'` and `manifest-src 'self'`.
- HTTPS is required for service workers and push (localhost is exempt for
  testing).
- Apply the migration `20261109000000_push_subscriptions` before deploying
  the API.
- nginx (add to [deployment.md](deployment.md#web-hosting-rules)):

  ```nginx
  location = /sw.js { add_header Cache-Control "no-cache"; try_files $uri =404; }
  location = /manifest.webmanifest {
    default_type application/manifest+json;
    add_header Cache-Control "no-cache";
    try_files $uri =404;
  }
  ```

## Browser compatibility

What the code expects of each browser (from the browsers' documented
support; only Chromium was actually run in this phase):

| Feature                                    | Chrome/Edge | Samsung Internet | Firefox             | Safari iOS/iPadOS                       | Safari macOS                 |
| ------------------------------------------ | ----------- | ---------------- | ------------------- | --------------------------------------- | ---------------------------- |
| Service worker, offline pages              | yes         | yes              | yes                 | yes                                     | yes                          |
| `beforeinstallprompt` (our Install button) | yes         | yes              | no: nothing offered | no: manual steps shown                  | no: manual steps shown (17+) |
| Push                                       | yes         | yes              | yes                 | 16.4+, home-screen app only (we say so) | 16+                          |

Verified here: Chromium (Playwright) — installability (no errors from Chromium's own check),
worker registration, precache, offline pages, the update flow and the
mobile layouts. Safari, Firefox and real phones were not tested.

## Tests

| Where                                          | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/test/pwa.test.ts`                    | Manifest fields, icon files and sizes, viewport, offline page; precache limited to the start-up shell; cache policy (writes never handled, personal API never cached, public reads/pages/assets/media, server headers respected, versioned names); offline refusal of changes with no request sent; mutations not paused; install method per browser and 30-day dismissal; push payload parsing and click targets; push availability; shared-device sign-out cleanup                                                                                                                                                                                               |
| `apps/web/test/mobile.test.tsx`                | Bottom bar links, active state, search sheet, hidden on checkout/payment, safe-area spacer; offline and back-online notices; confirm disabled offline with nothing sent or queued; "as loaded at" on a booking; install card (prompt, dismissal, iOS steps); update prompt; push panel (not configured, permission only on click, saved subscription, refusal)                                                                                                                                                                                                                                                                                                     |
| `apps/web/test/admin.test.tsx`, others         | Unchanged behaviour (full suite)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/api/test/integration/push.test.ts`       | Push off without keys; subscription saved per session, idempotent; validation, auth, CSRF; shared browser takeover; owner-only removal; PUSH queued only with an active session and the topic on, once per event; removed with the session                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/worker/test/push.test.ts`                | The real Web Push request (VAPID JWT, aes128gcm, TTL/Topic/Urgency) decrypted as a browser would; status classification; links; VAPID config validation; the push outbox against PostgreSQL (sent once, gone devices removed, retry and give-up, revoked sessions skipped, channels kept apart)                                                                                                                                                                                                                                                                                                                                                                    |
| Browser (production build, run for this phase) | Playwright/Chromium with a persistent profile: manifest served and parsed without errors, no installability errors, worker registered and controlling, precache filled; signed in, no personal page or API answer in any cache (84 entries checked); offline (site and API servers stopped): saved destination and guide open, My trips and an unvisited page show the offline page, which reloads itself when back online; update: notice shown, new worker waits, takes over only after Reload; sign-out deletes saved pages. Layout and axe (WCAG 2.2 AA + best practices) on 18 pages at 320, 360, 390, 430 and 768 px: no horizontal scrolling, no violations |

## Limitations

- Push delivery through real push services (FCM, Mozilla, Apple) wasn't
  verified: headless Chromium got no answer from its push service (subscribe
  timed out), and no real device was available. The protocol request itself
  (VAPID signature, encryption, headers) is verified by decrypting it.
- Installability was checked in Chromium (manifest and worker meet its
  criteria); Safari and Firefox weren't tested.
- Push needs the session the subscription was made in to stay signed in
  (sessions end after 7 idle days or 30 days); after that, the person turns
  push on again after signing in.
- Offline covers public pages already opened and their public data; search,
  booking, payment, account and admin need a connection.
- Lab performance numbers, not field data; real devices vary.
