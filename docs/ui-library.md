# UI and motion library (Phase 5)

`packages/ui` is Wayora's only design system. It has two public entry points:

| Import                                        | Contains                                                                                                    | Runtime deps                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `@wayora/ui`                                  | Tokens, brand, components, travel components, CSS class presets (`interaction`, `overlayMotion`, `effects`) | React, Radix (`radix-ui`), Lucide |
| `@wayora/ui/motion`                           | Motion tokens, transitions, variants, reveal components, `useMotionPreferences`                             | adds `motion` (peer dependency)   |
| `@wayora/ui/theme.css`, `@wayora/ui/base.css` | Tailwind theme tokens and base styles                                                                       | —                                 |

These are the only supported import paths. Never import from
`@wayora/ui/src/...`; a test (`packages/ui/test/exports.test.ts`) fails if the
entry points change, if Motion leaks into the core entry or if the package
imports application or backend code.

The package is consumed as TypeScript source (no build step). `apps/web`
depends on it as a workspace package and its Tailwind entry scans it with
`@source '../../../../packages/ui/src'`, so class names used inside the
package are generated.

```tsx
import { Button, DestinationCard, PageHeader } from '@wayora/ui';
import { Reveal, RevealGroup, RevealItem, useMotionPreferences } from '@wayora/ui/motion';
```

Brand, colour, type and spacing tokens are described in
[design-system.md](design-system.md). The live catalogue is the dev-only
`/design-system` route (`npm run dev:web`, then open `/design-system`); it is
not registered in production builds and `scripts/assert-no-dev-routes.mjs`
fails the build if it leaks.

## Components

All components are typed, forward native props where it makes sense, use the
tokens, show the global focus ring and are keyboard operable. Overlays are
built on Radix primitives (focus trap, Escape, focus return, ARIA wiring).

### Core

| Component                                                                  | Props worth knowing                                                                                                                                                                                                               | Use                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                                                                   | `variant`: `primary` · `secondary` · `outline` · `ghost` · `destructive`; on deep surfaces `inverse` · `outline-inverse` · `ghost-inverse`. `size` sm · md · lg, `loading`, `leadingIcon`, `trailingIcon`, `fullWidth`, `asChild` | One `primary` per view. `destructive` for irreversible actions, labelled with the consequence. `asChild` gives a router `Link` button styles. Disabled buttons are natively `disabled`; disabled links use `aria-disabled`. |
| `IconButton`                                                               | `label` (required; becomes the accessible name), `icon`, `variant`, `size`                                                                                                                                                        | Icon-only actions.                                                                                                                                                                                                          |
| `Card`, `Surface`                                                          | `tone`, `radius`, `padding`, `elevation`, `interactive`                                                                                                                                                                           | `interactive` adds the hover lift; only for cards that are a single link (pair with `stretched-link`).                                                                                                                      |
| `Badge`                                                                    | `tone`, `size`, `dot`                                                                                                                                                                                                             | Status labels; not interactive.                                                                                                                                                                                             |
| `Field` + `Input` / `Textarea` / `Select`                                  | `label`, `hint`, `error`, `required`                                                                                                                                                                                              | `Field` wires the label, `aria-describedby` and `aria-invalid`. `Select` is native.                                                                                                                                         |
| `Label`, `Checkbox`, `Radio`, `RadioGroup`                                 | `label`, `description`, `legend`                                                                                                                                                                                                  | Native inputs with custom styling.                                                                                                                                                                                          |
| `Skeleton`                                                                 | `shape`, `lines`, `effect`: `pulse` (default) · `sheen` · `none`                                                                                                                                                                  | Decorative; announce loading on the container.                                                                                                                                                                              |
| `Spinner`, `BrandLoader`                                                   | `label`                                                                                                                                                                                                                           | Inline / page loading.                                                                                                                                                                                                      |
| `EmptyState`, `ErrorState`, `Alert`                                        | `title`, `description`, `action`, `tone`; `EmptyState` `titleAs` (`p` default, or `h1`–`h3` when the state is the page)                                                                                                           |                                                                                                                                                                                                                             |
| `Dialog` (`DialogTrigger`, `DialogContent`, `DialogClose`)                 | `title` (required), `description`, `size`                                                                                                                                                                                         | Modal; Escape and backdrop close; focus returns to the trigger.                                                                                                                                                             |
| `Sheet` (`SheetTrigger`, `SheetContent`, `SheetClose`)                     | `title` (required), `description`, `footer`, `closeLabel`                                                                                                                                                                         | Modal panel from the right edge (e.g. filters on phones); focus trapped and returned to the trigger; Escape, backdrop and close button dismiss it.                                                                          |
| `Tooltip`                                                                  | `content`, `side`                                                                                                                                                                                                                 | Supplementary only — never the only label.                                                                                                                                                                                  |
| `DropdownMenu` (+ `Item`, `Label`, `Separator`, `RadioGroup`, `RadioItem`) |                                                                                                                                                                                                                                   | Menus of actions or choices.                                                                                                                                                                                                |
| `Popover`                                                                  |                                                                                                                                                                                                                                   | Non-modal panels (header search).                                                                                                                                                                                           |
| `Section`, `Container`, `Stack`, `Grid`                                    | `tone`, `spacing`, `container`, `size`                                                                                                                                                                                            | Layout.                                                                                                                                                                                                                     |
| `PageHeader`                                                               | `title`, `description`, `actions`, `eyebrow`, `meta`, `leading`, `headingLevel` h1 · h2, `size` page · section, `tone` default · inverse, `align`, `id`                                                                           | Page titles and section intros. Heading level is chosen by the caller (correct outline); size is independent of level.                                                                                                      |
| `MediaFrame`                                                               | `src`, `alt`, `aspect`, `focalPoint`, `sources`, `priority`, `fallbackColor`                                                                                                                                                      | Any responsive image.                                                                                                                                                                                                       |
| `Tabs`, `NavigationMenu`, `MobileNav`, `NavList`, `SkipLink`               |                                                                                                                                                                                                                                   | Navigation.                                                                                                                                                                                                                 |
| `Eyebrow`                                                                  | `tone` default · inverse                                                                                                                                                                                                          | Kicker line above a title, with the brand hairline. `PageHeader` uses it for `eyebrow`; use it directly in hero and CTA title blocks.                                                                                       |
| `Breadcrumbs`                                                              | `items` (`{ label, link? }[]`), `tone`                                                                                                                                                                                            | Breadcrumb trail: `nav` named Breadcrumb, ordered list, last item `aria-current="page"` and never a link; items without a link are plain text. Feed it route data (see layouts.md).                                         |
| `Prose`                                                                    | HTML children                                                                                                                                                                                                                     | Readable long-form text: 65-character measure, heading rhythm, list markers, underlined links.                                                                                                                              |
| `Accordion`, `AccordionItem`, `AccordionTrigger`, `AccordionContent`       | `type` single · multiple, `headingLevel`, `tone`                                                                                                                                                                                  | WAI-ARIA accordion (Radix): trigger buttons inside headings, `aria-expanded`, arrow keys/Home/End between headers; content fades in (opacity only). Footer groups on phones, FAQ on Help.                                   |

### Travel

| Component                | Use                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DestinationImage`       | Destination visual: fixed ratio (no layout shift), focal-point crop, portrait crop below 768 px, lazy by default, branded placeholder when no licensed image exists, optional hover zoom. Takes a `DestinationImageSource` (`src`, `alt`, `portraitSrc`, `focalPoint`, `tone`, `srcSet`, `sizes`).                                                                                                                                                                                                                          |
| `DestinationCard`        | Grids and results: image above a white body, with optional `description`, `tags` (+ `tagsLabel`, default "Highlights"), `rating`, `priceFrom`. `featured` adds an editorial badge (`true` = "Featured", or your own wording such as "Editor's pick"); `layout="split"` puts the image beside the text from `sm` (used for the wide cards in Discover's collection). Focal point comes from `image.focalPoint`. Pass `link` (a router `Link` element) and the name becomes the only link, with a hit area covering the card. |
| `DestinationFeatureCard` | Editorial tiles (homepage featured destinations): full-bleed image with text on a scrim. The name is the only link; `description` becomes its accessible description; `cta` is a visual, `aria-hidden` affordance. Size with `aspect` or `className`; `renderMedia` wraps the image layer (e.g. in `Parallax`). Deliberately has no price or rating slots. It is a separate component (not a variant) so pages that only show editorial tiles don't bundle the price and rating code (~1.5 kB gzip).                        |
| `ServiceCategoryCard`    | A travel service; `availability="planned"` renders a non-interactive preview even if a link is passed.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `PriceDisplay`           | Money from integer minor units (`amountMinor`), formatted exactly.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `RatingBadge`            | Score + word label + review count in one accessible sentence.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `JourneySummary`         | Origin → destination with times, duration and stops.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `TravellerCountDisplay`  | "2 adults, 1 child, 1 room" (full or compact).                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

**Honesty rule:** `priceFrom` and `rating` are only for real, sourced data.
The homepage and Discover show editorial sample content, so they have none.
`featured` is an editorial label, never a popularity, availability or deal
claim.

```tsx
<DestinationFeatureCard
  aspect="portrait"
  name="Kerala"
  region="South India"
  description="Backwaters, tea hills and slow mornings by the water."
  image={{
    src: '/media/artwork/destination-kerala.svg',
    alt: 'Houseboat on a palm-lined backwater',
    focalPoint: '50% 60%',
  }}
  cta="Explore Kerala"
  link={<Link to="/discover/kerala" />}
  renderMedia={(media) => (
    <Parallax offset={5} className="absolute inset-x-0 -top-[6%] -bottom-[6%]">
      {media}
    </Parallax>
  )}
/>
```

## Motion

Motion is built on the installed `motion` 12.43.0 (`motion/react`). Every
duration, easing and transition comes from tokens; components never hand-write
`{ duration: 0.8, ease: [...] }`.

### Tokens

| `duration`  | s    | CSS                    | Use                          |
| ----------- | ---- | ---------------------- | ---------------------------- |
| `instant`   | 0.1  | `--duration-instant`   | Micro state changes          |
| `fast`      | 0.16 | `--duration-fast`      | Hover, press, colour         |
| `base`      | 0.24 | `--duration-base`      | Menus, toggles, small moves  |
| `slow`      | 0.4  | `--duration-slow`      | Dialogs, cards, cross-fades  |
| `reveal`    | 0.8  | `--duration-reveal`    | Entrances and scroll reveals |
| `cinematic` | 1.2  | `--duration-cinematic` | One hero moment per page     |

`easing`: `standard` (UI changes), `emphasized` (things arriving),
`exit` (things leaving). `distance`: `sm` 8 · `md` 18 · `lg` 32 px.
`stagger`: `tight` 0.06 · `base` 0.1 · `loose` 0.14 s.

`transitions`: `fast`, `standard`, `emphasized`, `reveal`, `cinematic`,
`exit`, and `instant` (the reduced-motion alternative, duration 0).

### Presets

Entrance variants (all use the labels `hidden` → `visible`, so any of them
works as a child of `staggerContainer`):

| Preset                                         | Effect                                                | Default timing |
| ---------------------------------------------- | ----------------------------------------------------- | -------------- |
| `fadeIn`                                       | opacity                                               | `emphasized`   |
| `fadeUp` / `fadeDown`                          | opacity + y (`md`)                                    | `reveal`       |
| `fadeStart`                                    | opacity + x (`sm`) — items inside an entering panel   | `standard`     |
| `scaleIn`                                      | opacity + scale 0.96 → 1                              | `emphasized`   |
| `sectionReveal`                                | opacity + y (`lg`)                                    | `reveal`       |
| `staggerContainer({ stagger, delayChildren })` | sequences children                                    | `base`         |
| `lineReveal`                                   | masked line rise (headlines)                          | `reveal`       |
| `drawPath`                                     | SVG `pathLength` 0 → 1                                | `cinematic`    |
| `imageReveal`                                  | `clip-path` inset window → full bleed, scale 1.06 → 1 | `cinematic`    |

Each takes `{ delay, duration, distance }` — token names or raw values.
`gestures.press` / `gestures.hoverLift` are `whileTap` / `whileHover` targets
for elements that are already Motion components.

CSS class presets (no JavaScript, exported from both entry points):

| `interaction.*` |                                                              |
| --------------- | ------------------------------------------------------------ |
| `press`         | Button press (`active:scale-[0.98]`) — built into `Button`   |
| `hoverLift`     | Card hover lift — built into `Card interactive`              |
| `iconNudge`     | Trailing arrow nudges when its `group` is hovered or focused |
| `iconRotate`    | Chevron rotates when a Radix trigger is open                 |

| `overlayMotion.*`    | Used by                                   |
| -------------------- | ----------------------------------------- |
| `dropdown`           | `DropdownMenu`, `Popover`                 |
| `panel`              | `NavigationMenu` viewport (mega menu)     |
| `dialog`, `backdrop` | `Dialog`, `MobileNav`, `Sheet` (backdrop) |
| `drawer`             | `MobileNav` sheet, `Sheet`                |
| `tooltip`, `toast`   | `Tooltip`, `Toast`                        |

Overlays animate with CSS on Radix's `data-state`; Radix keeps the element
mounted for the exit animation and returns focus to the trigger, so no
JavaScript motion is involved.

Optional `effects.*` (opt in per element): `hoverZoom` (slow image zoom in a
`group`), `cardHighlight`, `underline` (draws on hover/focus),
`gradientAccent` (static), `shimmer` (skeleton sheen; loading only).
Deliberately absent: continuous animation on cards, flashing gradients,
cursor followers, scroll-jacking, full-page blur, decorative floating shapes.

### Components

```tsx
<Reveal preset="fadeUp" delay={0.2}>…</Reveal>                 // once, on entering the viewport
<Reveal as="p" trigger="mount" distance="sm">…</Reveal>        // on mount
<RevealGroup as="ul" stagger="tight">                          // one observer for the list
  {items.map((i) => <RevealItem as="li" key={i.id}>…</RevealItem>)}
</RevealGroup>
<LineReveal id="hero-title" lines={['Some journeys', 'change everything.']} />
<svg aria-hidden="true"><DrawPath d={path} stroke="currentColor" /></svg>
<ImageReveal className="absolute inset-0">…media…</ImageReveal>
<Parallax offset={5} className="absolute inset-x-0 -inset-y-[6%]">…media…</Parallax>
```

`entranceProps(variants, { reduce, trigger, viewport })` returns the same props
for any `motion.*` element when a wrapper component doesn't fit (the hero's
route stops use it).

### Reduced-motion policy

1. The app root sets `<MotionConfig reducedMotion="user">`, so Motion follows
   the OS `prefers-reduced-motion` setting.
2. `useMotionPreferences()` returns `{ reduce, parallax }`. `reduce` reads the
   MotionConfig (tests force it with `reducedMotion="always"`); `parallax` is
   true only on screens ≥ 1024 px with motion allowed.
3. With `reduce`, every library component renders its **final state** on the
   first frame (`initial={false}`): no opacity 0, no offsets, no clip.
4. `Parallax` is a static wrapper unless `parallax` is true.
5. `base.css` shortens all CSS transitions and keyframe animations to ~0 ms
   under `prefers-reduced-motion`, which covers the class presets and Radix
   overlays; the skeleton sheen is `motion-safe` only.
6. Content never depends on animation to appear: everything is in the DOM and
   interactive from the first frame; only `opacity`, `transform` and (one hero
   reveal) `clip-path` animate. If IntersectionObserver is unavailable, Motion
   treats elements as in view.
7. Focus is never moved by animation; dialogs and the drawer keep Radix's focus
   trap and focus return.

### Performance

- Transform and opacity only (the experience-section progress dots animate the
  width of three 6 px dots — a deliberate, negligible exception).
- `whileInView` with `once: true`; Motion owns observers and scroll listeners
  and cleans them up on unmount. Use `RevealGroup` for lists instead of one
  observer per item.
- `useMediaQuery` uses `useSyncExternalStore` with a stable subscription and a
  server snapshot of `false`, so components render during SSR and tests.
- The core entry point has no Motion import; pages that only need components
  don't pay for it.

## Accessibility requirements

Every component must: use semantic HTML (or a Radix primitive for complex
widgets); have an accessible name (icon-only buttons take `label`); show the
focus ring, including `focus-ring-inverse` on deep surfaces; be keyboard
operable; keep 44 px targets at size md+; pass the token contrast test; wire
hints and errors with `aria-describedby`; leave heading levels to the caller;
and follow the reduced-motion policy above.

## Adding a component

1. Check the catalogue first; extend an existing component with a prop or
   variant before adding a new one. Don't wrap a single element without adding
   behaviour.
2. Put it in the matching folder (`components/`, `layout/`, `feedback/`,
   `travel/`, `brand/`, or `motion/` if it needs the Motion runtime).
3. Use tokens and the class presets; compose classes with `cn` (it only joins
   strings — avoid passing conflicting utilities).
4. Export it from `src/index.ts` (or `src/motion/index.ts`) with its props type.
5. Add a test in `packages/ui/test` (render, name, keyboard, states) and a
   specimen on `/design-system`.
6. Document it in this file.

## Verification

`npm run test -w @wayora/ui` runs the package on its own (jsdom). Motion is not
timed in tests: tests assert preset configuration and the first rendered frame
(final state under reduced motion, hidden-but-present with motion allowed).
