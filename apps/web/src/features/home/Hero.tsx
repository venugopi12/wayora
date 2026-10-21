import { ArrowDown, ArrowRight } from 'lucide-react';
import { motion, useScroll, useTransform, type MotionValue } from 'motion/react';
import { useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Button, Container, Eyebrow, MediaFrame } from '@wayora/ui';
import {
  DrawPath,
  ImageReveal,
  LineReveal,
  Parallax,
  Reveal,
  entranceProps,
  scaleIn,
  useMotionPreferences,
} from '@wayora/ui/motion';
import { DISCOVER } from '../navigation/config';
import { HERO_LAYERS } from './media';

const HEADLINE = ['Some journeys', 'change everything.'] as const;
const PORTRAIT = '(max-width: 767px)';

/** One parallax layer. Depth 0 = fixed, larger = moves further while scrolling. */
function HeroLayer({
  layer,
  progress,
  children,
}: {
  layer: (typeof HERO_LAYERS)[number];
  progress: MotionValue<number>;
  children?: ReactNode;
}) {
  return (
    <Parallax
      progress={progress}
      offset={layer.depth * 60}
      aria-hidden={layer.alt === '' || undefined}
      className="absolute inset-x-0 -top-[2%] -bottom-[14%] will-change-transform"
    >
      <MediaFrame
        aspect="fill"
        priority
        src={layer.src}
        sources={layer.portraitSrc ? [{ media: PORTRAIT, srcSet: layer.portraitSrc }] : undefined}
        alt={layer.alt}
        focalPoint={layer.focalPoint}
        fallbackColor={layer.tone}
      />
      {children}
    </Parallax>
  );
}

/** A stop on the route: pops in after the line reaches it. */
function RouteStop({
  delay,
  cx,
  cy,
  ...circle
}: {
  delay: number;
  cx: number;
  cy: number;
  r: number;
  fill: string;
  stroke?: string;
  strokeWidth?: number;
}) {
  const { reduce } = useMotionPreferences();
  return (
    <motion.circle
      cx={cx}
      cy={cy}
      {...circle}
      style={{ transformOrigin: `${cx}px ${cy}px` }}
      {...entranceProps(scaleIn({ delay, duration: 'slow' }), { reduce, trigger: 'mount' })}
    />
  );
}

/** The brand route (origin → stopover → destination) traced across the ridges. */
function HeroRoute() {
  return (
    <svg
      viewBox="0 0 2400 1500"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
      className="pointer-events-none absolute inset-0 hidden size-full xl:block"
    >
      <DrawPath
        d="M1240 1030 C1320 930 1420 880 1540 890 S1730 960 1830 900 S1960 770 2060 800"
        trigger="mount"
        delay={0.9}
        duration={1.8}
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.85"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <RouteStop delay={0.9} cx={1240} cy={1030} r={11} fill="#ffffff" />
      <RouteStop
        delay={1.6}
        cx={1540}
        cy={890}
        r={9}
        fill="#171b35"
        stroke="#ffffff"
        strokeWidth={4}
      />
      <RouteStop delay={2.4} cx={2060} cy={800} r={11} fill="#ffffff" />
    </svg>
  );
}

/**
 * Cinematic homepage hero. Full-bleed layered artwork slides under the
 * transparent header; the headline reveals line by line through a mask.
 * All content is in the DOM and interactive from the first frame — motion is
 * presentational only (opacity / transform / clip-path), so there is no
 * layout shift. Parallax runs only on large screens without reduced motion.
 */
export function Hero() {
  const ref = useRef<HTMLElement>(null);
  const { parallax } = useMotionPreferences();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end start'] });
  const copyY = useTransform(scrollYProgress, [0, 1], ['0%', '-18%']);
  const copyOpacity = useTransform(scrollYProgress, [0, 0.7], [1, 0.7]);

  return (
    <section
      ref={ref}
      aria-labelledby="hero-title"
      className="relative isolate -mt-(--header-h) overflow-hidden bg-deep text-ink-inverse focus-ring-inverse"
      style={{ minHeight: 'clamp(40rem, 100svh, 62rem)' }}
    >
      {/* Media: clip-path reveal on load, layered parallax on scroll. */}
      <ImageReveal className="absolute inset-0">
        {HERO_LAYERS.map((layer, i) => (
          <HeroLayer key={layer.src} layer={layer} progress={scrollYProgress}>
            {i === HERO_LAYERS.length - 1 ? <HeroRoute /> : null}
          </HeroLayer>
        ))}
        {/* Scrims: keep the header and copy legible over any image. */}
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-40 bg-linear-to-b from-deep/70 to-transparent"
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-linear-to-t from-deep/95 from-25% via-deep/75 via-55% to-transparent to-90% md:bg-linear-to-tr md:from-deep/95 md:from-15% md:via-deep/65 md:via-45% md:to-transparent md:to-75%"
        />
      </ImageReveal>

      <Container
        size="wide"
        className="relative flex flex-col justify-end pt-32 pb-36 sm:pb-40 lg:pt-40 lg:pb-48"
        style={{ minHeight: 'clamp(40rem, 100svh, 62rem)' }}
      >
        <motion.div
          className="flex max-w-[44rem] flex-col gap-6"
          style={parallax ? { y: copyY, opacity: copyOpacity } : undefined}
        >
          <Reveal trigger="mount" delay={0.05} distance="sm">
            <Eyebrow tone="inverse">Seven ways to travel, one journey</Eyebrow>
          </Reveal>

          <LineReveal id="hero-title" className="text-display" lines={HEADLINE} delay={0.15} />

          <Reveal
            as="p"
            trigger="mount"
            delay={0.45}
            className="max-w-[34rem] text-body-lg text-ink-inverse-secondary"
          >
            Find your next escape and discover new places. Wayora is bringing flights, stays,
            trains, buses, metro, cabs and holidays together, one service at a time.
          </Reveal>

          <Reveal trigger="mount" delay={0.58} className="flex flex-col gap-3 pt-2 sm:flex-row">
            <Button asChild size="lg" variant="inverse">
              <a href="#journeys">
                Explore journeys
                <ArrowDown aria-hidden="true" />
              </a>
            </Button>
            <Button asChild size="lg" variant="outline-inverse">
              <Link to={DISCOVER.path}>
                Discover destinations
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          </Reveal>
        </motion.div>
      </Container>
    </section>
  );
}
