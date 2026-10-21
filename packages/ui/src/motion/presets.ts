/**
 * CSS class presets for interaction, overlay and effect motion.
 *
 * These are plain Tailwind class strings (no JavaScript, no Motion import), so
 * any component can use them and they cost nothing at runtime. They read the
 * duration/easing tokens from theme.css, and the global
 * `prefers-reduced-motion` rule in base.css shortens every transition and
 * keyframe animation to ~0 ms, so they are reduced-motion safe by default.
 *
 * Keep each value a complete literal string: Tailwind finds classes by
 * scanning source text.
 */

/** Interaction feedback. Hover effects that need a parent use Tailwind's `group`. */
export const interaction = {
  /** Button-like press feedback. */
  press:
    'transition-[transform,background-color,border-color,color,box-shadow] duration-(--duration-fast) ease-standard active:scale-[0.98]',
  /** Card hover lift (pair with a stretched link so the whole card is the target). */
  hoverLift:
    'transition-[transform,box-shadow,border-color] duration-(--duration-base) ease-emphasized hover:-translate-y-0.5 hover:shadow-md',
  /** Trailing icon (arrow) nudges forward when its `group` is hovered or focused. */
  iconNudge:
    'transition-transform duration-(--duration-base) ease-emphasized group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5',
  /** Disclosure chevron rotates when its trigger is open (Radix `data-state`). */
  iconRotate:
    'transition-transform duration-(--duration-base) ease-emphasized group-data-[state=open]:rotate-180',
} as const;

/**
 * Enter/exit animations for Radix overlays, keyed on `data-state`. Radix keeps
 * the element mounted until the exit animation ends, and restores focus to the
 * trigger on close, so no JavaScript motion is needed.
 */
export const overlayMotion = {
  /** Menus, popovers and select lists: scale from the trigger, fade out. */
  dropdown: 'data-[state=open]:animate-scale-in data-[state=closed]:animate-fade-out',
  /** Mega-menu viewport: scales in and out. */
  panel: 'data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out',
  /** Modal dialog content. */
  dialog: 'data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out',
  /** Backdrop behind dialogs and drawers. */
  backdrop: 'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out',
  /** Side drawer (mobile navigation). */
  drawer: 'data-[state=open]:animate-sheet-in data-[state=closed]:animate-sheet-out',
  /** Tooltip (Radix uses delayed-open / instant-open). */
  tooltip:
    'data-[state=delayed-open]:animate-fade-in data-[state=instant-open]:animate-fade-in data-[state=closed]:animate-fade-out',
  /** Toast notifications. */
  toast: 'data-[state=open]:animate-toast-in data-[state=closed]:animate-fade-out',
} as const;

/** Optional, restrained effects. Opt in per element; none animate continuously except `shimmer` (loading only). */
export const effects = {
  /** Slow image zoom inside a `group` card. Put on the <img> (MediaFrame `imgClassName`). */
  hoverZoom:
    'transition-transform duration-(--duration-reveal) ease-emphasized group-hover:scale-[1.04]',
  /** Brand-tinted border and soft glow when a card (a `group`) is hovered or holds focus. */
  cardHighlight:
    'transition-[border-color,box-shadow] duration-(--duration-base) ease-standard hover:border-brand-200 hover:shadow-[0_0_0_4px_var(--color-brand-soft)] has-[:focus-visible]:border-brand',
  /** Underline that draws from the left on hover/focus (inline links). */
  underline:
    'bg-[linear-gradient(currentColor,currentColor)] bg-[length:0%_1px] bg-left-bottom bg-no-repeat pb-0.5 transition-[background-size] duration-(--duration-base) ease-emphasized hover:bg-[length:100%_1px] focus-visible:bg-[length:100%_1px]',
  /** Soft brand gradient wash for an accent surface (static). */
  gradientAccent: 'bg-[radial-gradient(120%_80%_at_0%_0%,var(--color-brand-soft),transparent_60%)]',
  /** Loading sheen for skeletons (stops under reduced motion). */
  shimmer:
    'relative overflow-hidden after:absolute after:inset-0 after:-translate-x-full after:bg-linear-to-r after:from-transparent after:via-white/60 after:to-transparent after:motion-safe:animate-sheen',
} as const;

export type InteractionPreset = keyof typeof interaction;
export type OverlayMotionPreset = keyof typeof overlayMotion;
export type EffectPreset = keyof typeof effects;
