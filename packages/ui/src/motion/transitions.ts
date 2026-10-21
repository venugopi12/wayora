import type { Transition } from 'motion/react';
import { duration, easing } from '../lib/tokens';

export { duration, easing };

/** Travel distances (px) for entrances. Small on purpose: motion supports, it doesn't perform. */
export const distance = {
  sm: 8,
  md: 18,
  lg: 32,
} as const;

/** Delay between staggered children (seconds). */
export const stagger = {
  tight: 0.06,
  base: 0.1,
  loose: 0.14,
} as const;

export type DurationToken = keyof typeof duration;
export type DistanceToken = keyof typeof distance;
export type StaggerToken = keyof typeof stagger;

/**
 * Named transitions. Every animation in the app should start from one of these
 * (spread and override `delay` if needed) rather than a hand-written object.
 */
export const transitions = {
  /** Hover, press, small state changes. */
  fast: { duration: duration.fast, ease: easing.standard },
  /** Default UI transition (menus, toggles). */
  standard: { duration: duration.base, ease: easing.standard },
  /** Elements entering with intent (dialogs, cards). */
  emphasized: { duration: duration.slow, ease: easing.emphasized },
  /** Scroll/entrance reveals. */
  reveal: { duration: duration.reveal, ease: easing.emphasized },
  /** One-off hero moments. */
  cinematic: { duration: duration.cinematic, ease: easing.emphasized },
  /** Leaving: shorter and accelerating. */
  exit: { duration: duration.fast, ease: easing.exit },
  /** Reduced-motion alternative: state changes apply instantly. */
  instant: { duration: 0 },
} as const satisfies Record<string, Transition>;

export type TransitionName = keyof typeof transitions;

/** Resolve a token name or a number of seconds. */
export function resolveDuration(value: DurationToken | number | undefined, fallback: number) {
  if (value === undefined) return fallback;
  return typeof value === 'number' ? value : duration[value];
}

/** Resolve a token name or a number of px. */
export function resolveDistance(value: DistanceToken | number | undefined, fallback: number) {
  if (value === undefined) return fallback;
  return typeof value === 'number' ? value : distance[value];
}
