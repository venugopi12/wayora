import { useReducedMotionConfig } from 'motion/react';
import { useCallback, useSyncExternalStore } from 'react';
import { breakpoints } from '../lib/tokens';

/**
 * Live `matchMedia` result. Returns `false` during server rendering and where
 * `matchMedia` doesn't exist, so callers render the static layout first.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () =>
      typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false,
    () => false,
  );
}

const LARGE = `(min-width: ${breakpoints.lg}px)`;

export interface MotionPreferences {
  /** The person asked for reduced motion: render final states, no entrances or scroll effects. */
  reduce: boolean;
  /** Scroll-linked depth effects are allowed (large screen and motion allowed). */
  parallax: boolean;
}

/**
 * Wayora's reduced-motion policy, in one hook.
 *
 * - `reduce` follows `<MotionConfig reducedMotion>`; the app sets `"user"`, so
 *   it mirrors the OS `prefers-reduced-motion` setting (and tests can force it
 *   with `"always"`).
 * - `parallax` is true only on screens ≥ 1024 px with motion allowed.
 *
 * With `reduce`, components render their final state immediately
 * (`initial={false}`); CSS transitions are shortened by the global rule in
 * base.css. Content never depends on an animation to become visible.
 */
export function useMotionPreferences(): MotionPreferences {
  const reduce = useReducedMotionConfig() ?? false;
  const large = useMediaQuery(LARGE);
  return { reduce, parallax: large && !reduce };
}
