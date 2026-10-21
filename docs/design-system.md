# Wayora design system

Everything visual lives in **`packages/ui`** (`@wayora/ui`): tokens, brand assets
and accessible React components. Apps compose these; they do not restyle them.

- Live reference: run `npm run dev:web` and open **http://localhost:5173/design-system**
  (development only; see [Showcase](#showcase)).
- Source of truth for tokens: `packages/ui/src/styles/theme.css`.

## Brand principles

| Principle                  | In practice                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Calm confidence**        | Warm off-white pages, one indigo accent, deep navy for emphasis. No loud gradients, no saturated backgrounds.                     |
| **Journeys, not vehicles** | The visual motif is the route (stops joined by a line), not airplanes. Transport icons appear only where they identify a service. |
| **Honest by default**      | Preview features look like previews: no hover lift, no links, a clear "Coming in a later phase" badge. Prices are exact.          |
| **Editorial clarity**      | Large, tightly tracked headings; generous whitespace; one primary action per view.                                                |
| **Accessible is premium**  | AA contrast on every token pairing, visible focus, 44px touch targets, reduced-motion support.                                    |

### Brand mark

Two arcs join three stops (origin, stopover, destination) and read as a
lowercase **w**. Components: `BrandMark`, `Wordmark`, `BrandLoader`.

| Use                                    | Component                                                           |
| -------------------------------------- | ------------------------------------------------------------------- |
| Header, mobile nav                     | `<Wordmark />`, `<Wordmark size="sm" />`                            |
| Footer / dark surfaces                 | `<Wordmark surface="dark" />`                                       |
| Icon-only (app icon, favicon, avatars) | `<BrandMark size={32} />`; tones `brand`, `deep`, `inverse`, `mono` |
| Page or first-load loading             | `<BrandLoader label="Loading trips" />`                             |

- Below 20px the stopover becomes a filled dot for legibility (automatic). The favicon (`apps/web/public/favicon.svg`) uses this variant.
- Clear space: at least half the mark's width on every side. Don't recolour, rotate, outline or add effects.
- The mark is decorative next to the logotype; pass `title` when it stands alone.

## Tokens

Tailwind CSS v4 turns every `@theme` variable into both a CSS custom property
and a utility class. Tailwind's default colours, type sizes, radii and shadows
are **cleared**, so only Wayora tokens exist; a typo'd or off-brand class
simply produces no style.

`@theme static` emits every variable even if unused, so `var(--color-brand-700)`
always resolves in inline styles and SVG.

### Colour

Use **roles** first; fall back to the `brand-50…950` scale only when no role fits.

| Role                 | Token / utility                        | Value            | Use                                           |
| -------------------- | -------------------------------------- | ---------------- | --------------------------------------------- |
| Brand                | `brand`                                | #5463B1          | Primary actions, links, focus ring            |
| Brand hover / active | `brand-hover`, `brand-active`          | #4654A0, #3A4587 | Interaction states                            |
| Brand soft           | `brand-soft`                           | #EEF0FF          | Selected and tinted surfaces                  |
| Brand ink            | `brand-ink`                            | #3A4587          | Brand-coloured text on light/soft backgrounds |
| Deep                 | `deep`                                 | #171B35          | Hero, footer, tooltips, toasts                |
| Page                 | `page`                                 | #FAF9F6          | App background                                |
| Card                 | `card`                                 | #FFFFFF          | Cards, inputs, dialogs                        |
| Sunken               | `sunken`                               | #F3F2EE          | Inset bands, wells                            |
| Ink                  | `ink`                                  | #202238          | Primary text                                  |
| Ink secondary        | `ink-secondary`                        | #676B81          | Supporting text                               |
| Ink subtle           | `ink-subtle`                           | #8A8EA3          | Placeholders and disabled text only           |
| Ink inverse          | `ink-inverse`, `ink-inverse-secondary` | #FFFFFF, #C3C7E4 | Text on deep                                  |
| Line                 | `line`, `line-strong`                  | #E6E7EF, #D3D5E1 | Dividers, card borders                        |
| Control line         | `line-control`                         | #8A8EA3          | Form-control outlines                         |
| Success              | `success`, `-soft`, `-ink`, `-on-deep` | #188568 …        | Confirmed, available                          |
| Warning              | `warning`, `-soft`, `-ink`, `-on-deep` | #B7791F …        | Needs attention                               |
| Danger               | `danger`, `-soft`, `-ink`, `-on-deep`  | #C43D4B …        | Errors, destructive actions                   |

**Adjustments from the original brief, for WCAG:**

- Secondary text `#70748A` → **`#676B81`**: the original is 4.39:1 on the warm page colour (below AA 4.5:1); the adjusted value passes on every surface.
- Warning `#B7791F` is 3.6:1 on white, so it's used for icons and borders; text uses **`warning-ink` #855610**. Same pattern for success and danger (`*-ink`).
- Form-control borders use **`line-control`** (3.2:1) to meet WCAG 1.4.11 non-text contrast; `line` (#E6E7EF) is for decorative dividers.

`packages/ui/test/tokens.test.ts` parses `theme.css` and asserts the brief's
colours and the contrast of 27 foreground/background pairings. Adding a new
pairing to a component? Add it to that test.

### Typography

**Plus Jakarta Sans** (variable, self-hosted via `@fontsource-variable/plus-jakarta-sans`).
Each step sets size, line height, tracking and weight together.

| Utility                           | Size                       | Use                                  |
| --------------------------------- | -------------------------- | ------------------------------------ |
| `text-display`                    | clamp(2.75rem → 5rem)      | One hero headline per page           |
| `text-heading-1`                  | clamp(2.25rem → 3.5rem)    | Page title (h1)                      |
| `text-heading-2`                  | clamp(1.75rem → 2.5rem)    | Section heading                      |
| `text-heading-3`                  | clamp(1.375rem → 1.75rem)  | Card and dialog titles               |
| `text-title`                      | 1.125rem / 600             | Small titles, list headers           |
| `text-body-lg`                    | clamp(1.0625rem → 1.25rem) | Lead paragraphs                      |
| `text-body`                       | 1rem                       | Default text                         |
| `text-body-sm`                    | 0.875rem                   | Supporting text, hints               |
| `text-label`                      | 0.875rem / 600             | Labels, buttons                      |
| `text-caption`                    | 0.75rem / 500              | Metadata                             |
| `text-numeric-lg`, `text-numeric` | — / 700                    | Prices, times; always with `numeric` |

`numeric` applies tabular, lining figures so digits align in prices, times and
tables. Headings get `text-wrap: balance` and paragraphs `pretty` from the base layer.

### Space, layout, shape, depth

| Group       | Tokens                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| Spacing     | 4px base: `p-4` = 16px. Fluid layout steps: `px-gutter` (16→32px), `py-section` (64→128px), `py-section-sm` (40→72px)      |
| Containers  | `max-w-prose` 40rem, `max-w-narrow` 56rem, `max-w-page` 76rem, `max-w-wide` 88rem                                          |
| Breakpoints | Tailwind defaults: `sm` 640, `md` 768, `lg` 1024, `xl` 1280, `2xl` 1536 (mirrored in `breakpoints`)                        |
| Radii       | `rounded-xs` 6, `sm` 8, `md` 12 (controls), `lg` 16, `xl` 24 (cards), `2xl` 32 (hero panels), `full`                       |
| Shadows     | `shadow-xs` resting, `sm` raised, `md` hover/menus, `lg` dialogs/toasts; navy-tinted                                       |
| Z-index     | `z-(--z-sticky)` 100, `--z-dropdown` 200, `--z-overlay`/`--z-modal` 300/310, `--z-toast` 400, `--z-tooltip` 500            |
| Focus       | `--focus-ring-width` 2px, `--focus-ring-offset` 2px, `--focus-ring-color` brand. Use `focus-ring-inverse` on deep surfaces |

Never hard-code hex values, pixel font sizes or ad-hoc shadows in app code.

## Components

Import everything from `@wayora/ui`:

```tsx
import { Button, Field, Input, ServiceCategoryCard } from '@wayora/ui';
```

### Foundation

| Component                         | Key props                                                                                                                                                                                                             | Notes                                                                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                          | `variant` primary · secondary · outline · ghost · destructive, and for deep surfaces inverse · outline-inverse · ghost-inverse; `size` sm · md · lg; `loading`; `leadingIcon`, `trailingIcon`; `fullWidth`; `asChild` | Defaults to `type="button"`. `loading` disables and sets `aria-busy`. `asChild` renders a router `Link` with button styles (icons go inside the child). |
| `IconButton`                      | `label` (required), `icon`, `variant`, `size`                                                                                                                                                                         | `label` is the accessible name.                                                                                                                         |
| `Field`                           | `label`, `hint`, `error`, `required`, `hideLabel`                                                                                                                                                                     | Wraps **one** `Input`, `Textarea` or `Select`, wiring id, `aria-describedby`, `aria-invalid`, `required`.                                               |
| `Input`                           | `leading`, `trailing`, `size` md · lg, plus native props                                                                                                                                                              | Forward ref → works with React Hook Form `register()`.                                                                                                  |
| `Textarea`, `Select`              | `Select`: `options`, `placeholder`                                                                                                                                                                                    | Select is native on purpose (platform picker on mobile, full keyboard and screen-reader support).                                                       |
| `Checkbox`, `Radio`, `RadioGroup` | `label`, `description`; group `legend`, `hint`, `error`, `inline`                                                                                                                                                     | Native inputs; `RadioGroup` is a fieldset/legend and supplies the shared `name`.                                                                        |
| `Label`                           | `required`, `visuallyHidden`                                                                                                                                                                                          | For custom controls outside `Field`.                                                                                                                    |
| `Badge`                           | `tone` neutral · brand · success · warning · danger · inverse; `dot`; `size`                                                                                                                                          | Not interactive.                                                                                                                                        |
| `Avatar`                          | `name`, `src`, `size`                                                                                                                                                                                                 | Initials fallback; full name stays accessible.                                                                                                          |
| `Divider`                         | `orientation`, `label`, `decorative`                                                                                                                                                                                  |                                                                                                                                                         |
| `Tooltip`                         | `content`, `side`                                                                                                                                                                                                     | Needs `TooltipProvider` at the root. Supplementary text only; never the only place information lives.                                                   |

### Layout

| Component                                                                                                       | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Container`                                                                                                     | Centres content at a token width with the fluid gutter.                                                                                                                                                                                                                                                                                                                                                                                  |
| `Section`                                                                                                       | Full-width band with fluid vertical rhythm, `tone`, and a built-in `Container`. Give it `aria-labelledby`.                                                                                                                                                                                                                                                                                                                               |
| `Stack`                                                                                                         | Flex column/row with token `gap`; `rowFrom="md"` for mobile-first stacking.                                                                                                                                                                                                                                                                                                                                                              |
| `Grid`                                                                                                          | `columns={{ base: 1, md: 2, lg: 4 }}` or fluid `minItemWidth="16rem"`.                                                                                                                                                                                                                                                                                                                                                                   |
| `PageHeader`                                                                                                    | Title (h1/h2), description, actions, leading (breadcrumbs), meta (badge).                                                                                                                                                                                                                                                                                                                                                                |
| `Surface`                                                                                                       | Lowest-level coloured box: `tone` page · card · sunken · brand · deep.                                                                                                                                                                                                                                                                                                                                                                   |
| `Card`                                                                                                          | Bordered surface. `interactive` adds hover elevation; use it **only** when the card contains a `stretched-link` covering it.                                                                                                                                                                                                                                                                                                             |
| `NavigationMenu` + `NavigationMenuItem`, `NavigationMenuLink`, `NavigationMenuTrigger`, `NavigationMenuContent` | Header navigation with mega-menu panels (Radix NavigationMenu). Click or hover to open; a click on a hover-opened panel keeps it open (no flicker); Escape returns focus to the trigger; outside click and link selection close it. `NavigationMenuLink variant="top" active` draws the active-page indicator and sets `aria-current`; `NavigationMenuTrigger sectionActive` highlights a trigger whose panel contains the current page. |
| `SkipLink`, `NavList`, `NavItem`, `MobileNav`                                                                   | Navigation primitives. `NavItem active` sets `aria-current="page"`. `MobileNav` is a focus-trapped sheet (Radix Dialog). Phase 3 builds the navbar from these.                                                                                                                                                                                                                                                                           |

### Feedback and overlays

| Component                                                                | Notes                                                                                                                                                |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Spinner`                                                                | Inside controls and small regions.                                                                                                                   |
| `Skeleton`                                                               | `shape` rect · text · circle. Decorative: put `aria-busy` on the container.                                                                          |
| `BrandLoader`                                                            | Page-level and first-load loading.                                                                                                                   |
| `EmptyState`                                                             | Icon, title, description, one next action.                                                                                                           |
| `ErrorState`                                                             | `role="alert"`, what failed, how to fix, optional `reference` (request ID).                                                                          |
| `Alert`                                                                  | `tone` info · success · warning · danger. `role` defaults to `alert` for danger/warning, `status` otherwise, `none` for static content.              |
| `Dialog` + `DialogTrigger`, `DialogContent`, `DialogClose`               | `title` required; optional `description`, `footer` (primary action last). Focus trap, Escape, focus return.                                          |
| `DropdownMenu` + `…Trigger`, `…Content`, `…Item`, `…Label`, `…Separator` | Actions only; use `Select` for form values. Arrow keys, typeahead, Escape.                                                                           |
| `ToastProvider` + `useToast()`                                           | `toast({ title, description, tone, action })`. Polite announcements (assertive for danger), pause on hover, swipe to dismiss, F8 focuses the region. |

### Travel

| Component               | Interface                                                                                                               | Notes                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PriceDisplay`          | `amountMinor` (string/number/bigint), `currency`, `prefix`, `suffix`, `originalAmountMinor`, `size`, `locale`           | Exact formatting from integer minor units (BigInt → decimal string → `Intl`), matching the API's `moneySchema`. Screen readers get one sentence. |
| `RatingBadge`           | `score`, `outOf` 10 · 5, `reviewCount`, `label`                                                                         | Verbal label (Exceptional … Fair) derived from the score.                                                                                        |
| `DestinationCard`       | `name`, `region`, `image`, `aspect`, `priceFrom`, `rating`, `tags`, `link`                                              | See [Imagery](#imagery).                                                                                                                         |
| `ServiceCategoryCard`   | `icon`, `name`, `tagline`, `description`, `availability` planned · beta · live, `link`, `featured`                      | `planned` ignores `link` and renders a calm, non-interactive preview with a "Coming in a later phase" badge.                                     |
| `TravellerCountDisplay` | `adults`, `children`, `infants`, `rooms`, `travelClass`, `variant` full · compact                                       | "2 adults, 1 child, 1 room".                                                                                                                     |
| `JourneySummary`        | `mode` flight · train · bus · metro · cab, `origin`, `destination`, `durationMinutes`, `stops`, `operator`, `dayOffset` | Works for any point-to-point leg; one spoken summary for screen readers.                                                                         |

Links inside cards are passed as elements (`link={<Link to="/goa" />}`), so
components stay router-agnostic. The card clones the element, sets the title as
its text and makes it a `stretched-link`: one focus stop, whole card clickable.

## Icons

- **Lucide React** only. Stroke **1.75**; sizes **16 / 20 / 24px** (`size-4/5/6`).
- Decorative icons get `aria-hidden`; meaning goes in text or the control's label.
- Service icons are mapped in `apps/web/src/features/catalog/category-icons.ts`.

## Imagery

`DestinationCard` defines the treatment:

- Fixed aspect ratios: `landscape` 16:10 (default), `portrait` 4:5, `square`.
- `object-cover` with an optional `focalPoint` (`object-position`) for art direction.
- `loading="lazy"`, `decoding="async"`, and a default `sizes` for a 1/2/3-column grid; pass `srcSet` for responsive files.
- `alt` is required in the `image` type; describe the scene.
- No licensed photography exists yet, so the card shows a branded placeholder (lavender wash, route motif, initial). Adding photos later requires no component changes.
- Never hot-link remote images; store licensed assets locally or on the CDN chosen in a later phase.

## Motion

| Use                            | Duration                | Easing            |
| ------------------------------ | ----------------------- | ----------------- |
| Hover, press, colour changes   | `--duration-fast` 160ms | `ease-standard`   |
| Overlays entering, small moves | `--duration-base` 240ms | `ease-emphasized` |
| Section and card entrances     | `--duration-slow` 400ms | `ease-emphasized` |
| Dismissals                     | 120–200ms               | `ease-exit`       |

JS mirrors: `duration` (instant, fast, base, slow, reveal 0.8 s, cinematic 1.2 s)
and `easing` from `@wayora/ui` (a test keeps them in sync with CSS). Presets,
reveal components and the reduced-motion hook live in `@wayora/ui/motion`; see
[ui-library.md](ui-library.md).

Rules:

- One orchestrated moment per page at most (the home hero route draws once). Entrance animations run once (`viewport={{ once: true }}`).
- Animate `opacity` and `transform` only. Never delay interaction or block input.
- Hover elevation (`Card interactive`) only on things that are clickable.
- Buttons give press feedback (`interaction.press`).
- **Reduced motion:** `MotionConfig reducedMotion="user"` at the app root, a global CSS rule that collapses transitions and animations, and the motion library (`Reveal`, `entranceProps`, …) rendering final states (`initial={false}`) so content is visible immediately. Policy: [ui-library.md](ui-library.md#reduced-motion-policy).

## Accessibility requirements

Every shared component must:

1. Use semantic HTML first (button, a, label, fieldset, nav, dialog via Radix).
2. Have an accessible name (visible label, `label` prop or `aria-label`).
3. Show the global focus ring (`:focus-visible`), including on deep surfaces (`focus-ring-inverse`).
4. Be fully keyboard operable (Tab, Enter/Space, arrows where native, Escape for overlays).
5. Meet 44×44px touch targets for primary controls (size md+).
6. Pass the contrast test for any new token pairing.
7. Connect errors and hints with `aria-describedby`; mark invalid fields with `aria-invalid`.
8. Respect reduced motion.

Pages must have one `h1`, landmark regions (`header`, `nav` with a label, `main#main`, `footer`), and the skip link.

## Adding a shared component

1. Check the showcase and this document: extend an existing component before adding a new one.
2. Create it in `packages/ui/src/<components|layout|feedback|travel>/Name.tsx`:
   - typed props, `className` passthrough, `forwardRef` for anything focusable or form-related;
   - token utilities only;
   - use Radix (from `radix-ui`) for complex interaction patterns (popover, combobox, tabs) instead of hand-rolling focus management.
3. Export it from `packages/ui/src/index.ts`.
4. Add tests in `packages/ui/test/` covering rendering, accessible name/role, keyboard and disabled/loading states.
5. Add a specimen to the showcase (`apps/web/src/features/design-system/`).
6. Document props and usage here.
7. Run `npm run check` and `npm run build`.

## Consuming the design system (feature teams)

- Import components from `@wayora/ui`; do not copy their markup or restyle with overriding classes. If a variant is missing, add it to the component.
- Use `className` for layout (margins, grid placement, width), not for colours or typography that change the component's identity.
- Feature-specific compositions (a flight result row, a hotel gallery) live in `apps/web/src/features/<domain>/` and are built from these components; promote them to `packages/ui` when a second feature needs them.
- Money from the API arrives as `{ amountMinor, currency }`: pass it straight to `PriceDisplay`.
- Wrap the app once with `TooltipProvider` and `ToastProvider` (already done in `apps/web/src/app/App.tsx`).

## Package mechanics

`@wayora/ui` is an internal, source-only package: its `exports` point at
`src/index.ts`, and Vite/Vitest compile it as part of the app (instant HMR, no
build step). The web app's stylesheet imports `@wayora/ui/theme.css` and
`@wayora/ui/base.css` and adds `@source` for `packages/ui/src` so Tailwind
generates the classes components use.

## Showcase

`/design-system` is registered only when `import.meta.env.DEV` is true
(`apps/web/src/app/routes.tsx`). In production builds the constant is `false`,
so the route and its lazy chunk are removed by the bundler. `npm run build`
then runs `apps/web/scripts/assert-no-dev-routes.mjs`, which fails the build if
the showcase's marker string appears in any output file. Tests assert that the
route renders with dev routes on and is a 404 with them off. The page shows
only tokens and components, never environment values or diagnostics.

## Navigation (Phase 3)

The site header lives in `apps/web/src/components/layout/SiteHeader.tsx` and
composes feature components from `apps/web/src/features/navigation/`:

| Component                | Role                                                                                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`              | Typed, single source of truth: service names (from the catalog contract), paths, Lucide icons, one-line summaries, which links collapse into "More" below `xl`. Desktop, mega menu, drawer, footer and search pages all read it. |
| `DesktopNavigation`      | `lg+`: Discover, Flights, Hotels, Trains, Buses (moves into "More" between `lg` and `xl`), More.                                                                                                                                 |
| `TravelMegaMenu`         | "More" panel: Metro, Cabs, Holiday packages (+ Buses below `xl`), each badged from the catalog ("Demo" while `beta`), and a featured deep-navy panel linking to Discover.                                                        |
| `DestinationSearch`      | Popover combobox over the **sample** destination dataset (`features/discover/data.ts`, labelled "Sample data"). Arrow keys, Home/End, Enter, Escape; `/` opens it. Selecting goes to `/discover/<slug>`. No API calls.           |
| `CurrencySelector`       | Display-currency preference (INR default) in React context for the current visit. Changes the label only; prices are never converted.                                                                                            |
| `AccountAction`          | Links to `/sign-in`, an honest "accounts are on the way" page.                                                                                                                                                                   |
| `MobileNavigationDrawer` | `<lg`: right-hand sheet with all seven services, Discover, currency and sign-in; 56px rows, scroll lock, focus return.                                                                                                           |

Header behaviour: sticky; borderless on the page background at the top, solid
surface + hairline + `shadow-xs` once scrolled (one IntersectionObserver on a
sentinel, no scroll listener). Height is constant (64px, 72px from `lg`).

Routes for every navigation destination exist: `/flights`, `/hotels`,
`/trains`, `/buses`, `/metro`, `/cabs`, `/holidays` render the demo search
pages (`apps/web/src/features/search/`, Phase 9; the earlier `ComingSoon`
component was retired with them). Booking flows will add nested routes under
each service in `apps/web/src/app/routes.tsx`; set the service's
`availability` in the catalog contract when it opens and the menu badges
follow automatically ("Soon" for `planned`, "Demo" for `beta`, none for `live`).

## Homepage (Phase 4)

The cinematic homepage composes these components; see [homepage.md](homepage.md)
for sections, motion budget and content rules, and [media-assets.md](media-assets.md)
for the image manifest and how to replace artwork with licensed photography.

Additions to the system in Phase 4:

- `MediaFrame` and `Tabs` (above), `Button` variant `ghost-inverse`,
  `MobileNav triggerVariant`.
- `NavigationMenu` top-level items read optional CSS variables
  (`--nav-fg`, `--nav-fg-active`, `--nav-hover-bg`, `--nav-hover-fg`,
  `--nav-indicator`), so a container can theme them (the header over the hero)
  without overriding classes.
- Motion budget hook `useMotionPreferences()`: parallax only on large screens
  with motion allowed; reduced motion renders final states. (Moved into
  `@wayora/ui/motion` in Phase 5.)

## Phase 5: UI and motion library

The component catalogue, motion presets, reduced-motion policy and how to add
components are documented in [ui-library.md](ui-library.md). Phase 5 changes:
`Button` gains `outline` and `outline-inverse` and renames `danger` to
`destructive`; `PageHeader` gains `eyebrow`, `size="section"`, `tone` and
`align`; new `DestinationImage` and `DestinationFeatureCard`;
`Skeleton effect`; shared `interaction` / `overlayMotion` / `effects` class
presets; the `@wayora/ui/motion` entry point.
