import type { MotionProps, Variants, ViewportOptions } from 'motion/react';

const DEFAULT_MARGIN: ViewportOptions['margin'] = '0px 0px -60px 0px';

export type EntranceProps = Pick<
  MotionProps,
  'variants' | 'initial' | 'animate' | 'whileInView' | 'viewport'
>;

export type RevealTrigger = 'mount' | 'inView';

export interface RevealViewport {
  /** Fraction of the element that must be visible (0–1). Default: any part. */
  amount?: number;
  /** IntersectionObserver root margin. Default `"0px 0px -60px 0px"` (just inside the fold). */
  margin?: ViewportOptions['margin'];
  /** Animate only the first time it enters. Default true. */
  once?: boolean;
}

/**
 * Motion props for an entrance, applying the reduced-motion policy:
 *
 * - `reduce`  → `initial: false`: the element (and any variant children)
 *   renders in its final `visible` state with no animation.
 * - `mount`   → animates `hidden` → `visible` on mount.
 * - `inView`  → animates when it scrolls into view (once by default). Where
 *   IntersectionObserver is missing, Motion treats the element as in view, so
 *   content is never left hidden.
 *
 * Use with any `motion.*` element: `<motion.p {...entranceProps(fadeUp(), { reduce })} />`.
 */
export function entranceProps(
  variants: Variants,
  {
    reduce = false,
    trigger = 'inView',
    viewport,
  }: { reduce?: boolean; trigger?: RevealTrigger; viewport?: RevealViewport } = {},
): EntranceProps {
  if (reduce) return { variants, initial: false, animate: 'visible' };
  if (trigger === 'mount') return { variants, initial: 'hidden', animate: 'visible' };
  return {
    variants,
    initial: 'hidden',
    whileInView: 'visible',
    viewport: {
      once: viewport?.once ?? true,
      amount: viewport?.amount,
      margin: viewport?.margin ?? DEFAULT_MARGIN,
    },
  };
}
