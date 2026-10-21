import type { SVGProps } from 'react';
import { cn } from '../lib/cn';

export type BrandMarkTone = 'brand' | 'deep' | 'inverse' | 'mono';

export interface BrandMarkProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Rendered size in px. Below 20px a simplified mark (filled stopover) is used. */
  size?: number;
  /**
   * brand   – white route on Wayora indigo (default)
   * deep    – lavender route on deep navy
   * inverse – indigo route on a white tile, for dark backgrounds
   * mono    – no tile; the route uses currentColor
   */
  tone?: BrandMarkTone;
  /** Accessible name. Omit when the mark sits next to the wordmark text (decorative). */
  title?: string;
}

const tones: Record<BrandMarkTone, { tile: string | null; route: string; hole: string }> = {
  brand: { tile: 'var(--color-brand)', route: '#ffffff', hole: 'var(--color-brand)' },
  deep: { tile: 'var(--color-deep)', route: 'var(--color-brand-100)', hole: 'var(--color-deep)' },
  inverse: { tile: '#ffffff', route: 'var(--color-brand)', hole: '#ffffff' },
  mono: { tile: null, route: 'currentColor', hole: 'transparent' },
};

/** Route geometry shared by the mark and the loader: two arcs joining three stops. */
export const BRAND_ROUTE_PATH =
  'M8 11.5C8 18.8 9.9 22.5 12 22.5s4-3.7 4-11c0 7.3 1.9 11 4 11s4-3.7 4-11';

/**
 * The Wayora mark: a journey from origin to destination via a stopover, drawn
 * as two arcs that also read as a lowercase "w".
 */
export function BrandMark({
  size = 32,
  tone = 'brand',
  title,
  className,
  ...rest
}: BrandMarkProps) {
  const t = tones[tone];
  const simplified = size < 20;
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      className={cn('shrink-0', className)}
      {...rest}
    >
      {t.tile ? <rect width="32" height="32" rx="9" fill={t.tile} /> : null}
      <path
        d={BRAND_ROUTE_PATH}
        fill="none"
        stroke={t.route}
        strokeWidth={simplified ? 2.6 : 2.1}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="10.5" r={simplified ? 2.7 : 2.35} fill={t.route} />
      {simplified ? (
        <circle cx="16" cy="10.5" r="2.2" fill={t.route} />
      ) : (
        <circle cx="16" cy="10.5" r="1.85" fill={t.hole} stroke={t.route} strokeWidth="1.5" />
      )}
      <circle cx="24" cy="10.5" r={simplified ? 2.7 : 2.35} fill={t.route} />
    </svg>
  );
}
