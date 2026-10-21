import {
  motion,
  useScroll,
  useTransform,
  type HTMLMotionProps,
  type MotionValue,
  type SVGMotionProps,
} from 'motion/react';
import { useRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { entranceProps, type RevealTrigger, type RevealViewport } from './entrance';
import { useMotionPreferences } from './reduced-motion';
import { stagger as staggerTokens, type StaggerToken } from './transitions';
import {
  drawPath,
  entrancePresets,
  imageReveal,
  lineReveal,
  staggerContainer,
  type EntranceOptions,
  type EntrancePreset,
} from './variants';

/** Block-level tags a reveal wrapper may render as. */
const tags = {
  div: motion.div,
  section: motion.section,
  header: motion.header,
  article: motion.article,
  figure: motion.figure,
  ul: motion.ul,
  ol: motion.ol,
  li: motion.li,
  p: motion.p,
  span: motion.span,
} as const;

export type RevealElement = keyof typeof tags;

type Animated =
  'initial' | 'animate' | 'whileInView' | 'variants' | 'viewport' | 'transition' | 'exit';

interface RevealBaseProps extends Omit<HTMLMotionProps<'div'>, Animated> {
  /** Element to render. Default `div`. */
  as?: RevealElement;
  /** `inView` (default) animates on scroll into view, once; `mount` animates immediately. */
  trigger?: RevealTrigger;
  viewport?: RevealViewport;
}

export interface RevealProps extends RevealBaseProps, EntranceOptions {
  /** Entrance preset. Default `fadeUp`. */
  preset?: EntrancePreset;
}

/**
 * Entrance wrapper. Renders its children in the DOM from the first frame;
 * only opacity/transform animate. Under reduced motion it renders the final
 * state with no animation.
 *
 * ```tsx
 * <Reveal preset="fadeUp" delay={0.2}>…</Reveal>
 * <Reveal as="p" trigger="mount" distance="sm">…</Reveal>
 * ```
 */
export function Reveal({
  as = 'div',
  preset = 'fadeUp',
  trigger = 'inView',
  viewport,
  delay,
  duration,
  distance,
  ...rest
}: RevealProps) {
  const { reduce } = useMotionPreferences();
  const Tag = tags[as] as typeof motion.div;
  const variants = entrancePresets[preset]({ delay, duration, distance });
  return <Tag {...entranceProps(variants, { reduce, trigger, viewport })} {...rest} />;
}

export interface RevealGroupProps extends RevealBaseProps {
  /** Delay between children: token or seconds. Default `base` (0.1 s). */
  stagger?: StaggerToken | number;
  /** Seconds before the first child starts. */
  delayChildren?: number;
}

/**
 * Staggers its `RevealItem` children. The group owns the trigger (one
 * IntersectionObserver for the whole list) and the children inherit it.
 *
 * ```tsx
 * <RevealGroup as="ul" stagger="tight">
 *   {items.map((i) => <RevealItem as="li" key={i.id}>…</RevealItem>)}
 * </RevealGroup>
 * ```
 */
export function RevealGroup({
  as = 'div',
  trigger = 'inView',
  viewport,
  stagger = 'base',
  delayChildren,
  ...rest
}: RevealGroupProps) {
  const { reduce } = useMotionPreferences();
  const Tag = tags[as] as typeof motion.div;
  const variants = staggerContainer({ stagger, delayChildren });
  return <Tag {...entranceProps(variants, { reduce, trigger, viewport })} {...rest} />;
}

export interface RevealItemProps
  extends Omit<HTMLMotionProps<'div'>, Animated>, Omit<EntranceOptions, 'delay'> {
  as?: RevealElement;
  preset?: EntrancePreset;
}

/** Child of `RevealGroup`: declares its preset; timing comes from the group. */
export function RevealItem({
  as = 'div',
  preset = 'fadeUp',
  duration,
  distance,
  ...rest
}: RevealItemProps) {
  const Tag = tags[as] as typeof motion.div;
  return <Tag variants={entrancePresets[preset]({ duration, distance })} {...rest} />;
}

const headingTags = { h1: 'h1', h2: 'h2', h3: 'h3', p: 'p' } as const;

export interface LineRevealProps extends Omit<ComponentPropsWithoutRef<'h1'>, 'children'> {
  /** Each entry is one visual line. */
  lines: readonly string[];
  as?: keyof typeof headingTags;
  /** Seconds before the first line. */
  delay?: number;
  /** Delay between lines: token or seconds. Default `base`. */
  stagger?: StaggerToken | number;
  trigger?: RevealTrigger;
  lineClassName?: string;
}

/**
 * Headline whose lines rise through a mask. The text is real and complete in
 * the DOM; a visually hidden space between lines keeps the accessible name
 * a normal sentence ("Some journeys change everything.").
 */
export function LineReveal({
  lines,
  as = 'h1',
  delay = 0,
  stagger = 'base',
  trigger = 'mount',
  lineClassName,
  ...rest
}: LineRevealProps) {
  const { reduce } = useMotionPreferences();
  const Heading = headingTags[as];
  const each = typeof stagger === 'number' ? stagger : staggerTokens[stagger];
  return (
    <Heading {...rest}>
      {lines.map((line, i) => (
        <span key={line} className="-mb-[0.1em] block overflow-hidden pb-[0.1em]">
          {i > 0 ? <span className="sr-only"> </span> : null}
          <motion.span
            className={cn('block', lineClassName)}
            {...entranceProps(lineReveal({ delay: delay + i * each }), { reduce, trigger })}
          >
            {line}
          </motion.span>
        </span>
      ))}
    </Heading>
  );
}

export interface DrawPathProps
  extends
    Omit<SVGMotionProps<SVGPathElement>, Animated | 'pathLength'>,
    Omit<EntranceOptions, 'distance'> {
  d: string;
  trigger?: RevealTrigger;
  viewport?: RevealViewport;
}

/** SVG path that draws itself once. Place inside a decorative (`aria-hidden`) <svg>. */
export function DrawPath({
  trigger = 'inView',
  viewport,
  delay,
  duration,
  ...rest
}: DrawPathProps) {
  const { reduce } = useMotionPreferences();
  return (
    <motion.path
      {...entranceProps(drawPath({ delay, duration }), { reduce, trigger, viewport })}
      {...rest}
    />
  );
}

export interface ImageRevealProps extends Omit<HTMLMotionProps<'div'>, Animated>, EntranceOptions {
  trigger?: RevealTrigger;
  viewport?: RevealViewport;
  /** Corner radius (px) of the starting window. */
  radius?: number;
}

/**
 * Media wrapper that opens from an inset rounded window to full size. The
 * image is visible from the first frame (only clipped), so nothing depends on
 * the animation finishing.
 */
export function ImageReveal({
  trigger = 'mount',
  viewport,
  delay,
  duration,
  radius,
  ...rest
}: ImageRevealProps) {
  const { reduce } = useMotionPreferences();
  return (
    <motion.div
      {...entranceProps(imageReveal({ delay, duration, radius }), { reduce, trigger, viewport })}
      {...rest}
    />
  );
}

export interface ParallaxProps extends Omit<HTMLMotionProps<'div'>, Animated | 'style'> {
  /**
   * Travel as a percentage of the element's height. With its own scroll
   * tracking the element moves from `-offset%` to `+offset%` as it crosses the
   * viewport; with `progress` it moves from `0%` to `offset%`.
   */
  offset?: number;
  /** Drive from an existing scroll progress (0 → 1) instead of tracking this element. */
  progress?: MotionValue<number>;
  style?: HTMLMotionProps<'div'>['style'];
  children?: ReactNode;
}

/**
 * Optional scroll parallax for decorative media. Active only when
 * `useMotionPreferences().parallax` is true (≥ 1024 px, motion allowed);
 * otherwise it is a plain, static wrapper. Oversize the media (e.g.
 * `-inset-y-[6%]`) so the edges never show.
 */
export function Parallax({ offset = 5, progress, style, ...rest }: ParallaxProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { parallax } = useMotionPreferences();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] });
  const source = progress ?? scrollYProgress;
  const y = useTransform(
    source,
    [0, 1],
    progress ? ['0%', `${offset}%`] : [`${-offset}%`, `${offset}%`],
  );
  return <motion.div ref={ref} style={parallax ? { ...style, y } : style} {...rest} />;
}
