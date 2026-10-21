import type { Transition, Variants } from 'motion/react';
import { easing } from '../lib/tokens';
import {
  distance,
  resolveDistance,
  resolveDuration,
  stagger,
  transitions,
  type DistanceToken,
  type DurationToken,
  type StaggerToken,
} from './transitions';

/**
 * Entrance variants. Every preset uses the labels `hidden` → `visible`, so
 * presets compose: a `staggerContainer` parent drives any child preset.
 * Only `opacity`, `transform` and (for image reveals) `clip-path` animate.
 */
export interface EntranceOptions {
  /** Seconds before the entrance starts. */
  delay?: number;
  /** Token name or seconds. */
  duration?: DurationToken | number;
  /** Token name or px (for presets that move). */
  distance?: DistanceToken | number;
}

function enter(base: Transition & { duration: number }, o: EntranceOptions = {}): Transition {
  return {
    ...base,
    duration: resolveDuration(o.duration, base.duration),
    // Only set `delay` when asked. An explicit child delay (even 0) overrides a
    // parent's `staggerChildren` in Motion, which would make every item in a
    // RevealGroup animate at once.
    ...(o.delay !== undefined ? { delay: o.delay } : {}),
  };
}

export function fadeIn(o?: EntranceOptions): Variants {
  return {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: enter(transitions.emphasized, o) },
  };
}

export function fadeUp(o?: EntranceOptions): Variants {
  const y = resolveDistance(o?.distance, distance.md);
  return {
    hidden: { opacity: 0, y },
    visible: { opacity: 1, y: 0, transition: enter(transitions.reveal, o) },
  };
}

export function fadeDown(o?: EntranceOptions): Variants {
  const y = resolveDistance(o?.distance, distance.md);
  return {
    hidden: { opacity: 0, y: -y },
    visible: { opacity: 1, y: 0, transition: enter(transitions.reveal, o) },
  };
}

/**
 * Short slide from the inline-start side, for items inside a panel that is
 * itself entering (drawer rows, menu items). Uses the standard duration.
 */
export function fadeStart(o?: EntranceOptions): Variants {
  const x = resolveDistance(o?.distance, distance.sm);
  return {
    hidden: { opacity: 0, x },
    visible: { opacity: 1, x: 0, transition: enter(transitions.standard, o) },
  };
}

/** Subtle scale from 96 %. */
export function scaleIn(o?: EntranceOptions): Variants {
  return {
    hidden: { opacity: 0, scale: 0.96 },
    visible: { opacity: 1, scale: 1, transition: enter(transitions.emphasized, o) },
  };
}

/** Section-level entrance: a longer, calmer rise than `fadeUp`. */
export function sectionReveal(o?: EntranceOptions): Variants {
  const y = resolveDistance(o?.distance, distance.lg);
  return {
    hidden: { opacity: 0, y },
    visible: { opacity: 1, y: 0, transition: enter(transitions.reveal, o) },
  };
}

/** Masked line rise (pair with an `overflow-hidden` wrapper per line). */
export function lineReveal(o?: EntranceOptions): Variants {
  return {
    hidden: { y: '105%' },
    visible: { y: '0%', transition: enter(transitions.reveal, o) },
  };
}

/** SVG stroke draw (`pathLength` 0 → 1). */
export function drawPath(o?: EntranceOptions): Variants {
  return {
    hidden: { pathLength: 0, opacity: 0 },
    visible: { pathLength: 1, opacity: 1, transition: enter(transitions.cinematic, o) },
  };
}

/** Image reveal: an inset rounded window opens to full bleed while settling from 106 %. */
export function imageReveal(o?: EntranceOptions & { radius?: number }): Variants {
  const r = o?.radius ?? 32;
  return {
    hidden: { clipPath: `inset(7% 5% 9% 5% round ${r}px)`, scale: 1.06 },
    visible: {
      clipPath: 'inset(0% 0% 0% 0% round 0px)',
      scale: 1,
      transition: enter(transitions.cinematic, o),
    },
  };
}

export interface StaggerOptions {
  /** Token name or seconds between children. */
  stagger?: StaggerToken | number;
  /** Seconds before the first child. */
  delayChildren?: number;
}

/** Parent that sequences its children's `hidden` → `visible` entrances. */
export function staggerContainer(o: StaggerOptions = {}): Variants {
  const each = typeof o.stagger === 'number' ? o.stagger : stagger[o.stagger ?? 'base'];
  return {
    hidden: {},
    visible: {
      transition: { staggerChildren: each, delayChildren: o.delayChildren ?? 0 },
    },
  };
}

/** The entrance presets by name (used by `<Reveal preset>` and the showcase). */
export const entrancePresets = {
  fadeIn,
  fadeUp,
  fadeDown,
  fadeStart,
  scaleIn,
  sectionReveal,
} as const;

export type EntrancePreset = keyof typeof entrancePresets;

/**
 * Interaction animations for Motion components (`whileHover` / `whileTap`).
 * Most UI uses the equivalent CSS classes in `interaction` instead; use these
 * when an element is already a Motion component.
 */
export const gestures = {
  press: { scale: 0.98, transition: transitions.fast },
  hoverLift: {
    y: -2,
    transition: { duration: transitions.standard.duration, ease: easing.emphasized },
  },
} as const;
