import { render, screen } from '@testing-library/react';
import { MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../src';
import {
  DrawPath,
  ImageReveal,
  LineReveal,
  Parallax,
  Reveal,
  RevealGroup,
  RevealItem,
  distance,
  duration,
  easing,
  entrancePresets,
  entranceProps,
  fadeDown,
  fadeIn,
  fadeStart,
  fadeUp,
  lineReveal,
  overlayMotion,
  scaleIn,
  sectionReveal,
  stagger,
  staggerContainer,
  transitions,
  useMediaQuery,
  useMotionPreferences,
} from '../src/motion';

/*
 * Motion is not timed in these tests. We assert the *configuration* each
 * preset produces and the first rendered frame, which is deterministic:
 * with reduced motion it must already be the final state.
 */

const reduced = ({ children }: { children: ReactNode }) => (
  <MotionConfig reducedMotion="always">{children}</MotionConfig>
);
const full = ({ children }: { children: ReactNode }) => (
  <MotionConfig reducedMotion="never">{children}</MotionConfig>
);

describe('motion tokens and transitions', () => {
  it('builds named transitions from the duration and easing tokens', () => {
    expect(transitions.fast).toEqual({ duration: duration.fast, ease: easing.standard });
    expect(transitions.reveal).toEqual({ duration: duration.reveal, ease: easing.emphasized });
    expect(transitions.exit).toEqual({ duration: duration.fast, ease: easing.exit });
    expect(transitions.instant).toEqual({ duration: 0 });
  });
});

describe('entrance presets', () => {
  it('all use the hidden → visible labels so they compose with staggerContainer', () => {
    for (const make of Object.values(entrancePresets)) {
      const v = make();
      expect(Object.keys(v).sort()).toEqual(['hidden', 'visible']);
      expect(v.hidden).toHaveProperty('opacity', 0);
      expect(v.visible).toHaveProperty('opacity', 1);
    }
  });

  it('only animate opacity and transforms', () => {
    const allowed = new Set(['opacity', 'x', 'y', 'scale', 'transition']);
    for (const make of Object.values(entrancePresets)) {
      for (const state of Object.values(make()))
        for (const key of Object.keys(state as object)) expect(allowed).toContain(key);
    }
  });

  it('accept token names or raw values for duration, distance and delay', () => {
    const tokens = fadeUp({ duration: 'slow', distance: 'lg', delay: 0.2 });
    expect(tokens.hidden).toMatchObject({ y: distance.lg });
    expect(tokens.visible).toMatchObject({
      transition: { duration: duration.slow, delay: 0.2, ease: easing.emphasized },
    });
    const raw = fadeDown({ duration: 1, distance: 4 });
    expect(raw.hidden).toMatchObject({ y: -4 });
    expect(raw.visible).toMatchObject({ transition: { duration: 1 } });
    expect(sectionReveal().hidden).toMatchObject({ y: distance.lg });
  });

  it('leave delay unset by default so a parent stagger can sequence them', () => {
    // Motion lets an explicit child `delay` (even 0) override `staggerChildren`.
    for (const preset of [
      fadeIn,
      fadeUp,
      fadeDown,
      fadeStart,
      scaleIn,
      sectionReveal,
      lineReveal,
    ]) {
      const visible = preset().visible as { transition: Record<string, unknown> };
      expect(visible.transition).not.toHaveProperty('delay');
    }
  });

  it('staggerContainer sequences children', () => {
    expect(staggerContainer().visible).toEqual({
      transition: { staggerChildren: stagger.base, delayChildren: 0 },
    });
    expect(staggerContainer({ stagger: 'tight', delayChildren: 0.3 }).visible).toEqual({
      transition: { staggerChildren: stagger.tight, delayChildren: 0.3 },
    });
  });
});

describe('entranceProps (reduced-motion policy)', () => {
  const v = fadeUp();
  it('renders the final state immediately when motion is reduced', () => {
    expect(entranceProps(v, { reduce: true })).toEqual({
      variants: v,
      initial: false,
      animate: 'visible',
    });
  });

  it('animates on mount or once on entering the viewport', () => {
    expect(entranceProps(v, { trigger: 'mount' })).toMatchObject({
      initial: 'hidden',
      animate: 'visible',
    });
    expect(entranceProps(v)).toMatchObject({
      initial: 'hidden',
      whileInView: 'visible',
      viewport: { once: true, margin: '0px 0px -60px 0px' },
    });
    expect(entranceProps(v, { viewport: { once: false, amount: 0.5 } }).viewport).toMatchObject({
      once: false,
      amount: 0.5,
    });
  });
});

describe('motion components', () => {
  it('Reveal renders content in its final state under reduced motion', () => {
    render(
      <Reveal as="p" preset="fadeUp">
        Visible text
      </Reveal>,
      { wrapper: reduced },
    );
    const el = screen.getByText('Visible text');
    expect(el.tagName).toBe('P');
    expect(el.style.opacity).not.toBe('0');
    expect(el.style.transform).toBe('none');
  });

  it('Reveal starts hidden (but in the DOM) when motion is allowed', () => {
    render(<Reveal trigger="mount">Entering</Reveal>, { wrapper: full });
    const el = screen.getByText('Entering');
    expect(el).toBeInTheDocument();
    expect(el.style.opacity).toBe('0');
  });

  it('RevealGroup passes the reduced state to its items', () => {
    render(
      <RevealGroup as="ul" aria-label="Stops">
        <RevealItem as="li">One</RevealItem>
        <RevealItem as="li" preset="scaleIn">
          Two
        </RevealItem>
      </RevealGroup>,
      { wrapper: reduced },
    );
    expect(screen.getByRole('list', { name: 'Stops' })).toBeInTheDocument();
    for (const item of screen.getAllByRole('listitem')) expect(item.style.opacity).not.toBe('0');
  });

  it('LineReveal keeps a natural accessible name across masked lines', () => {
    render(<LineReveal id="t" lines={['Some journeys', 'change everything.']} />, {
      wrapper: full,
    });
    expect(
      screen.getByRole('heading', { level: 1, name: 'Some journeys change everything.' }),
    ).toHaveAttribute('id', 't');
  });

  it('DrawPath and ImageReveal render final states under reduced motion', () => {
    const { container } = render(
      <>
        <svg aria-hidden="true">
          <DrawPath d="M0 0 L10 10" stroke="currentColor" />
        </svg>
        <ImageReveal data-testid="img-reveal">
          <span>media</span>
        </ImageReveal>
      </>,
      { wrapper: reduced },
    );
    expect(container.querySelector('path')).toHaveAttribute('d', 'M0 0 L10 10');
    expect(screen.getByTestId('img-reveal').style.clipPath).not.toContain('7%');
  });

  it('Parallax is a static wrapper unless parallax is allowed', () => {
    render(
      <Parallax data-testid="layer" offset={10}>
        <span>layer</span>
      </Parallax>,
      { wrapper: full },
    );
    // jsdom has no large-screen media query match, so parallax is off.
    expect(screen.getByTestId('layer').style.transform).toBe('');
  });
});

describe('useMotionPreferences', () => {
  function Probe() {
    const { reduce, parallax } = useMotionPreferences();
    const wide = useMediaQuery('(min-width: 1024px)');
    return <output>{`${reduce}/${parallax}/${wide}`}</output>;
  }

  it('follows MotionConfig reducedMotion', () => {
    const { unmount } = render(<Probe />, { wrapper: reduced });
    expect(screen.getByRole('status')).toHaveTextContent('true/false/false');
    unmount();
    render(<Probe />, { wrapper: full });
    expect(screen.getByRole('status')).toHaveTextContent('false/false/false');
  });

  it('is safe to render on the server (no browser APIs needed)', () => {
    const html = renderToString(
      <MotionConfig reducedMotion="never">
        <Probe />
        <Reveal>Server content</Reveal>
        <Parallax>Layer</Parallax>
      </MotionConfig>,
    );
    expect(html).toContain('false/false/false');
    expect(html).toContain('Server content');
  });
});

describe('overlay motion presets', () => {
  it('Dialog content uses the shared dialog and backdrop presets', () => {
    render(
      <Dialog open>
        <DialogContent title="Trip details">Body</DialogContent>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Trip details' });
    for (const cls of overlayMotion.dialog.split(' ')) expect(dialog).toHaveClass(cls);
  });

  it('DropdownMenu content uses the shared dropdown preset', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    for (const cls of overlayMotion.dropdown.split(' '))
      expect(screen.getByRole('menu')).toHaveClass(cls);
  });
});
