/**
 * @wayora/ui/motion — Wayora's motion library.
 *
 * Separate entry point so the core `@wayora/ui` components never pull in
 * Motion. Requires the `motion` peer dependency. See docs/ui-library.md.
 */

// Tokens and transitions
export {
  distance,
  duration,
  easing,
  resolveDistance,
  resolveDuration,
  stagger,
  transitions,
  type DistanceToken,
  type DurationToken,
  type StaggerToken,
  type TransitionName,
} from './transitions';

// Variants (entrance, scroll, interaction gestures)
export {
  drawPath,
  entrancePresets,
  fadeDown,
  fadeIn,
  fadeStart,
  fadeUp,
  gestures,
  imageReveal,
  lineReveal,
  scaleIn,
  sectionReveal,
  staggerContainer,
  type EntranceOptions,
  type EntrancePreset,
  type StaggerOptions,
} from './variants';

// CSS class presets (also exported from `@wayora/ui`)
export {
  effects,
  interaction,
  overlayMotion,
  type EffectPreset,
  type InteractionPreset,
  type OverlayMotionPreset,
} from './presets';

// Reduced-motion policy
export { useMediaQuery, useMotionPreferences, type MotionPreferences } from './reduced-motion';
export {
  entranceProps,
  type EntranceProps,
  type RevealTrigger,
  type RevealViewport,
} from './entrance';

// Components
export {
  DrawPath,
  ImageReveal,
  LineReveal,
  Parallax,
  Reveal,
  RevealGroup,
  RevealItem,
  type DrawPathProps,
  type ImageRevealProps,
  type LineRevealProps,
  type ParallaxProps,
  type RevealElement,
  type RevealGroupProps,
  type RevealItemProps,
  type RevealProps,
} from './components';
