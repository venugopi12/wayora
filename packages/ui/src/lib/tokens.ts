/**
 * JavaScript mirrors of tokens that animation code needs as numbers.
 * Keep in sync with theme.css (`--duration-*`, `--ease-*`); a test enforces it.
 */
export const duration = {
  instant: 0.1,
  fast: 0.16,
  base: 0.24,
  slow: 0.4,
  /** Scroll and entrance reveals (section intros, hero copy). */
  reveal: 0.8,
  /** One-off hero moments (media reveal). Use sparingly. */
  cinematic: 1.2,
} as const;

export const easing = {
  standard: [0.2, 0, 0, 1],
  emphasized: [0.22, 1, 0.36, 1],
  exit: [0.4, 0, 1, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

/** Breakpoints in px, mirroring Tailwind's defaults used in theme.css. */
export const breakpoints = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1536,
} as const;

/** Interface icon conventions (Lucide). */
export const iconSize = { sm: 16, md: 20, lg: 24 } as const;
export const ICON_STROKE = 1.75;
