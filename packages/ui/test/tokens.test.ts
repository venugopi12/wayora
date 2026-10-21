// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { duration } from '../src/lib/tokens';

const css = readFileSync(
  fileURLToPath(new URL('../src/styles/theme.css', import.meta.url)),
  'utf8',
);

function token(name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  if (!match?.[1]) throw new Error(`Token --${name} not found as a hex colour`);
  return match[1].toLowerCase();
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('brand tokens', () => {
  it('keeps the brief’s brand colours', () => {
    expect(token('color-brand')).toBe('#5463b1');
    expect(token('color-deep')).toBe('#171b35');
    expect(token('color-brand-soft')).toBe('#eef0ff');
    expect(token('color-page')).toBe('#faf9f6');
    expect(token('color-card')).toBe('#ffffff');
    expect(token('color-ink')).toBe('#202238');
    expect(token('color-line')).toBe('#e6e7ef');
    expect(token('color-success')).toBe('#188568');
    expect(token('color-warning')).toBe('#b7791f');
    expect(token('color-danger')).toBe('#c43d4b');
  });
});

describe('WCAG contrast of token pairings used by components', () => {
  // [foreground, background, minimum ratio]
  const pairs: Array<[string, string, number]> = [
    // Body text (AA 4.5:1)
    ['color-ink', 'color-page', 4.5],
    ['color-ink', 'color-card', 4.5],
    ['color-ink', 'color-sunken', 4.5],
    ['color-ink-secondary', 'color-page', 4.5],
    ['color-ink-secondary', 'color-card', 4.5],
    ['color-ink-secondary', 'color-sunken', 4.5],
    ['color-ink-secondary', 'color-brand-soft', 4.5],
    ['color-ink-inverse', 'color-brand', 4.5],
    ['color-ink-inverse', 'color-brand-hover', 4.5],
    ['color-ink-inverse', 'color-deep', 4.5],
    ['color-ink-inverse-secondary', 'color-deep', 4.5],
    ['color-ink-inverse', 'color-danger', 4.5],
    ['color-brand', 'color-card', 4.5],
    ['color-brand', 'color-page', 4.5],
    ['color-brand-ink', 'color-brand-soft', 4.5],
    ['color-success-ink', 'color-success-soft', 4.5],
    ['color-warning-ink', 'color-warning-soft', 4.5],
    ['color-danger-ink', 'color-danger-soft', 4.5],
    ['color-danger-ink', 'color-card', 4.5],
    ['color-success-on-deep', 'color-deep', 4.5],
    ['color-warning-on-deep', 'color-deep', 4.5],
    ['color-danger-on-deep', 'color-deep', 4.5],
    // Non-text UI: control borders, focus ring, status icons (3:1)
    ['color-line-control', 'color-card', 3],
    ['color-brand', 'color-page', 3],
    ['color-success', 'color-card', 3],
    ['color-warning', 'color-card', 3],
    ['color-danger', 'color-card', 3],
  ];

  it.each(pairs)('%s on %s ≥ %s:1', (fg, bg, min) => {
    expect(contrast(token(fg), token(bg))).toBeGreaterThanOrEqual(min);
  });
});

describe('motion tokens', () => {
  it('keeps JS durations in sync with CSS', () => {
    for (const [name, seconds] of Object.entries(duration)) {
      const match = css.match(new RegExp(`--duration-${name}:\\s*(\\d+)ms`));
      expect(Number(match?.[1]) / 1000, name).toBe(seconds);
    }
  });
});
