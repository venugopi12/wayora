# Layouts, footer and page structure (Phase 7)

How every page gets its chrome (header, footer), its width and rhythm, and
its breadcrumbs, and how future product areas plug in.

## Route tree

```text
RootLayout                      components/layout/RootLayout.tsx
│  scroll restoration (incl. #hash targets), route-change announcer,
│  last-resort errorElement (no chrome)
├─ AuthLayout                   components/layout/AuthLayout.tsx (Phase 8)
│  │  logo + back link, <main>, small legal links; artwork panel from lg
│  └─ RedirectIfSignedIn  →  /login, /register
└─ MarketingLayout              components/layout/MarketingLayout.tsx
   │  skip link → SiteHeader → <main id="main"> → SiteFooter
   └─ (pathless)  errorElement: RouteErrorBoundary  ← page errors keep header + footer
      ├─ /                     HomeRoute              handle.headerOverlay
      ├─ /discover             DiscoverRoute          handle.crumb "Discover"
      ├─ /discover/:slug       DestinationRoute       handle.crumb = destination name
      ├─ /about, /help         info chunk             handle.crumb
      ├─ /legal/privacy, /legal/terms                 handle.crumb (drafts)
      ├─ /status, /flights … /holidays (demo search and results), /sign-in (→ /login)
      ├─ /offers/:serviceType/:resultId  offer details (Phase 10; own breadcrumbs)
      ├─ RequireAuth  →  /profile, /profile/travellers
      ├─ /design-system        dev builds only
      └─ *                     NotFoundRoute
```

App-wide providers (React Query, Motion's reduced-motion config, tooltips,
toasts, display currency) wrap the router in `app/App.tsx`, so every layout
shares them.

- **One header, one `main`, one footer.** Only `MarketingLayout` renders them;
  pages never do. Tests assert this for every route (`test/layout.test.tsx`).
- **Errors stay in the layout.** A page that throws, or whose code chunk fails
  to load, shows "This page didn't load" between the normal header and footer.
  Only a failure of the layout itself falls back to the bare root boundary.
- **Loading.** On a direct visit to a lazily loaded page, the router shows
  `<MarketingLayout footer={false}><PageLoader /></MarketingLayout>`; the footer
  appears with the page so nothing shifts.
- **Route announcer.** After client-side navigation, a polite live region reads
  the new `document.title` (pages set it with `useDocumentTitle`).

### Route handles

`handle` on a route object (typed as `RouteHandle` in
`components/layout/route-handle.tsx`) carries layout options:

| Key             | Effect                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `headerOverlay` | The header floats, transparent, over a full-bleed dark hero (homepage).                                                                                 |
| `crumb`         | Breadcrumb label for this level: a string, or `(params) => string \| undefined`. Returning `undefined` (e.g. unknown destination slug) drops the trail. |

### Future layouts (pattern, not built yet)

Booking checkout and admin screens should not inherit the marketing footer. Add
each as a sibling of `MarketingLayout` under `RootLayout`, as `AuthLayout` is:

```tsx
{
  element: <FocusedLayout />,           // e.g. logo + exit link + <main>, no footer
  children: [{ errorElement: <RouteErrorBoundary />, children: [/* checkout steps */] }],
}
```

Keep one `<main id="main">` and a skip link in every layout. `AuthLayout`
(sign-in and registration) is the first; account pages (`/profile…`) stay in
`MarketingLayout` so the site navigation and account menu remain available.

## Containers and spacing

Use the tokens; don't hand-pick widths or gaps per page.

| Container (`<Container size>`) | Max width | Use                                                                           |
| ------------------------------ | --------- | ----------------------------------------------------------------------------- |
| `wide`                         | 88rem     | Marketing sections, header and footer (homepage, Discover, destination pages) |
| `page` (default)               | 76rem     | Content pages with an aside (`ContentPage`: about, help, legal)               |
| `narrow`                       | 56rem     | Message pages: not-found, errors, destination not-found                       |
| `prose`                        | 65ch      | A single column of reading text (`Prose` applies this measure itself)         |

Every container adds the fluid side gutter (`px-gutter`, 16–32 px), so nothing
touches the screen edge. Full-bleed bands (heroes, dark CTA sections) are
`<section>` elements with a background and a `Container` inside.

| Token / utility               | Value                   | Use                                                            |
| ----------------------------- | ----------------------- | -------------------------------------------------------------- |
| `py-section`                  | 64–128 px (fluid)       | Major editorial sections                                       |
| `py-section-sm`               | 40–72 px (fluid)        | Compact sections, content and message pages, footer top        |
| `mt-section-head`             | 48 px, 64 px from `lg`  | Between a section's title block (`PageHeader`) and its content |
| `h-(--header-h)`              | 64 px, 72 px from `lg`  | Header height                                                  |
| `-mt-(--header-h)`            | minus the header height | A hero that slides under the overlay header                    |
| `scroll-mt-(--header-offset)` | header height + 24 px   | Anything linked with `#id`, so it isn't hidden by the header   |

Shared building blocks (`@wayora/ui`): `Container`, `Section`, `PageHeader`
(title blocks, h1 or h2), `Eyebrow` (kicker line, when a section composes its
own title block), `Breadcrumbs`, `Prose` (long-form text), `Accordion`.

App-level: `ContentPage` (`components/layout/ContentPage.tsx`) composes
breadcrumbs, a page title, an optional notice, a `Prose` body, optional
non-prose content (`after`) and an aside. Use it for any new informational
page.

## Breadcrumbs

`Breadcrumbs` (`@wayora/ui`) renders `nav[aria-label="Breadcrumb"] > ol`; the
last item is the current page (`aria-current="page"`, never a link); separators
are `aria-hidden`; long current-page labels truncate visually.

Data comes from the route table, not from page markup: `useRouteBreadcrumbs()`
returns Home plus every matched route with a `handle.crumb`, with real routed
paths as links. Levels without a page (there is no `/legal`) simply don't
declare a crumb, so no URL is guessed.

Shown on: destination pages (Home › Discover › Kyoto) and the info/legal pages
(Home › Privacy policy). Not shown on the homepage, Discover itself, service
pages or error pages.

## Footer

`SiteFooter` (`components/layout/SiteFooter.tsx`), rendered once by
`MarketingLayout`. Links come from one typed config,
`features/navigation/footer.ts`:

| Group              | Links                                                                       |
| ------------------ | --------------------------------------------------------------------------- |
| Explore            | Discover destinations, Flights, Hotels, Trains, Buses                       |
| More travel        | Metro, Cabs, Holiday packages, Travel inspiration (`/discover#inspiration`) |
| Company            | About Wayora, Help and support, Platform status                             |
| Legal (bottom bar) | Privacy policy, Terms and conditions (both drafts)                          |

Bottom bar: © year (computed when rendered), "Booking isn't available yet",
legal links, the dev-only design-system link (development builds), and the
shared display-currency selector (the same component and state as the header).

- **Desktop / tablet (≥ 768 px):** brand block plus three columns; on large
  screens the brand takes 5/12 and the links 7/12.
- **Phones:** the three groups become an accordion (`type="multiple"`, all
  closed), so the footer stays short. The accordion code (Radix, ~5 kB gzip)
  loads lazily on phones only; until it arrives, identical closed rows hold
  its place, so nothing shifts. Triggers are buttons inside `h2`
  headings with `aria-expanded`; Enter/Space toggle, arrow keys and Home/End
  move between them. Links in open groups are 44 px rows.
- **Social links:** `SOCIAL_LINKS` is empty, so nothing renders. Add official
  profiles there only when they exist.
- **Motion:** colour transitions on links, an underline that draws in, and a
  fade when an accordion group opens; all collapse under reduced motion.

## Content that needs review before launch

| Item                                        | Status                                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/legal/privacy`                            | **Draft placeholder.** Describes what the preview does today (account data, sessions, the session cookie, scroll positions in session storage, no trackers; API request logs; rate limiting) and lists what a policy must cover. Needs a policy written and reviewed by legal counsel. |
| `/legal/terms`                              | **Draft placeholder.** States nothing creates a contract; lists what terms must cover. Needs terms written and reviewed by legal counsel.                                                                                                                                              |
| Cookie policy                               | Not created. The only cookie is the strictly necessary session cookie (Phase 8), described in the privacy draft. Review whether a separate notice is needed before launch, and add one with any analytics or stored preferences.                                                       |
| Log retention                               | Not defined. The privacy draft says so; decide before launch.                                                                                                                                                                                                                          |
| Contact page / support channel              | Not created: no contact details exist and none were invented. Help says a contact will be added before booking opens.                                                                                                                                                                  |
| `/about`, `/help`                           | Factual descriptions of the current product. Review copy and update as services launch.                                                                                                                                                                                                |
| Social links, company address, legal entity | None configured. Add only real, official details.                                                                                                                                                                                                                                      |

The facts stated on these pages were checked against the code in Phase 7 and
again in Phase 8 (`apps/api/src/middleware/http-logger.ts`, `rate-limit.ts`,
`modules/auth/*`; the web app writes no browser storage itself, and React
Router's scroll restoration keeps scroll positions in `sessionStorage`).
Re-check them whenever logging, storage or third-party scripts change.
