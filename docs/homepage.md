# Homepage (Phase 4)

The homepage is a short narrative built entirely from the design system
(`@wayora/ui`), the navigation config (`features/navigation/config.ts`) and one
media manifest. Code lives in `apps/web/src/features/home/`; the route is
`apps/web/src/routes/HomeRoute.tsx`.

| #   | Section               | Component                 | Purpose                                                   |
| --- | --------------------- | ------------------------- | --------------------------------------------------------- |
| 1   | Hero                  | `Hero.tsx`                | Identity: full-bleed layered artwork, headline, two CTAs  |
| 2   | Travel selector       | `TravelSelector.tsx`      | Entry point: seven service tabs + "Where to?"             |
| 3   | Explore by mood       | `MoodSection.tsx`         | Four of Discover's six moods, each linking to its results |
| 4   | Featured destinations | `DestinationsSection.tsx` | Kerala, Goa, Jaipur, Manali in a bento layout             |
| 5   | The Wayora experience | `ExperienceSection.tsx`   | What's being built, as three short chapters               |
| 6   | Closing CTA           | `ClosingCta.tsx`          | Night scene that flows into the footer                    |

Moods and destinations: `HOME_MOODS` and `FEATURED_DESTINATIONS` in
`content.ts`, chosen from the shared Discover data (`features/discover/data.ts`:
`HOMEPAGE_MOODS`, `HOMEPAGE_FEATURED`). Hero and closing-CTA images:
`media.ts` (see docs/media-assets.md).

## Honesty rules (content)

- **No live inventory.** Moods and destinations are static demonstration
  content: no prices, ratings, reviews, deals or availability. A test fails
  if currency amounts or rating language appear on the page.
- **Every action has a real destination.** CTAs go to `#journeys` (the
  selector), `/discover` or a service's search page (a demo search since
  Phase 9; see docs/search.md). Since Phase 6,
  moods open `/discover?mood=<slug>#collection`, featured destinations and the
  travel selector open `/discover/<slug>` (`?mode=<service>` lists the chosen
  service first), and the content comes from `features/discover/data.ts`
  (see docs/discover.md). Booking still opens later, and every page says so
  plainly.
- **Status comes from the catalog.** Selector tabs show "Coming in a later
  phase" until the catalog API marks a service `beta`/`live`; then the badge
  changes automatically.
- **Sample data is labelled.** The "Where to?" field and header search show
  a "Sample data" badge and a hint that nothing can be booked yet.

## Header integration

`/` sets `handle: { headerOverlay: true }` in `app/routes.tsx`. `MarketingLayout`
passes that to the one `SiteHeader`, which then:

- starts transparent with white controls (`tone="inverse"`) while the hero is
  behind it, using the NavigationMenu CSS variables (`--nav-fg` …) and the
  `ghost-inverse` / `inverse` button variants;
- switches to the standard solid surface once the page scrolls ~80 px (one
  IntersectionObserver sentinel, no scroll listener);
- never changes height. The hero uses `-mt-16 lg:-mt-18` to slide under it.

Stacking uses the token layers: header `--z-sticky` (100), selector
`--z-raised` (10), dropdowns `--z-dropdown` (200), drawer `--z-overlay`/`--z-modal`.
Any other route can opt into the overlay with the same handle.

## Motion

All motion uses Motion (`motion/react`) with the token durations and easings
from `@wayora/ui`, and animates only `opacity`, `transform` and (once, in the
hero) `clip-path`. Content is in the DOM and clickable from the first frame.

| Where                 | Effect                                                   | Notes                                                                              |
| --------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Hero media            | `clip-path` inset → full + scale 1.06 → 1                | `cinematic` 1.2 s, once                                                            |
| Hero headline         | Masked line reveal (y 105% → 0), 0.1 s stagger           | Lines are `overflow-hidden` masks; a hidden space keeps the accessible name intact |
| Hero lead, CTAs       | Fade + rise, 0.45 s / 0.58 s delay                       |                                                                                    |
| Hero route            | `pathLength` draw, stops pop in                          | xl+ only (kept clear of the copy)                                                  |
| Hero layers           | Scroll parallax, depth 0.08 / 0.16 / 0.28                | **lg+ only, motion allowed**                                                       |
| Hero copy             | Rises and fades to 0.7 as the hero leaves                | lg+ only                                                                           |
| Section intros, cards | Fade + rise on enter, once                               | `whileInView`, `once: true`                                                        |
| Destination images    | ±5 % parallax inside the tile                            | lg+ only                                                                           |
| Experience            | Sticky visual cross-fades as chapters cross mid-viewport | lg+ only; normal scrolling, no pinning                                             |
| Closing CTA           | Brand route draws once                                   |                                                                                    |

Since Phase 5 every effect above comes from `@wayora/ui/motion` (`ImageReveal`,
`LineReveal`, `Reveal`, `RevealGroup`, `DrawPath`, `Parallax`); section intros
are `PageHeader size="section"`, destination tiles are
`DestinationFeatureCard` and the hero/CTA secondary buttons use the
`outline-inverse` variant. See [ui-library.md](ui-library.md).

`useMotionPreferences()` (`@wayora/ui/motion`) decides the budget:
`reduce` follows `<MotionConfig reducedMotion="user">` (the OS setting), and
`parallax` is true only on screens ≥ 1024 px with motion allowed. With reduced
motion every component renders its final state immediately (`initial={false}`)
and the global CSS rule removes transitions. Motion values and observers are
owned by Motion and cleaned up on unmount; there are no manual scroll listeners.

## Responsive behaviour

One set of components, tuned with breakpoints:

- **Hero:** portrait artwork below 768 px (`<picture>` art direction);
  `min-height: clamp(40rem, 100svh, 62rem)`; copy anchored low with a scrim.
- **Selector:** tabs scroll horizontally inside the panel on narrow screens
  (no page overflow); the panel stacks: service, field, actions.
- **Moods:** swipeable row with the next card peeking (< 768 px), 2 columns
  (md), 4 staggered columns (lg).
- **Destinations:** single column (4:5 tiles) → 4:3 (sm) → 12-column bento
  (lg: Kerala lead, Goa and Jaipur stacked, Manali panorama).
- **Experience:** stacked chapters with inline visuals; sticky story from lg.

## Verified (Phase 4)

Checked in Chromium (Playwright) at 360, 390, 768, 1024, 1280 and 1440 px: no
horizontal overflow, no broken images, clean console, cumulative layout shift
≤ 0.0005, hero images eager and the other 9 lazy. Text over artwork was measured
against the brightest background pixel behind it: 6:1 to 13:1 (WCAG AA needs
4.5:1). Navigation regressions (mega menu, search, drawer, scroll state) were
re-run on top of the hero. See the Phase 4 report for the full list.
