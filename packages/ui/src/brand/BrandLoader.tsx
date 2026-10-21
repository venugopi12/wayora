import { cn } from '../lib/cn';
import { BRAND_ROUTE_PATH } from './BrandMark';

export interface BrandLoaderProps {
  size?: number;
  /** Announced to assistive technology. */
  label?: string;
  className?: string;
}

/**
 * Branded loading indicator: the route travels between the three stops.
 * Use for full-page or first-load states; use Spinner inside controls.
 * With reduced motion the route is shown static.
 */
export function BrandLoader({ size = 48, label = 'Loading', className }: BrandLoaderProps) {
  return (
    <span role="status" className={cn('inline-flex flex-col items-center gap-3', className)}>
      <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false">
        <path
          d={BRAND_ROUTE_PATH}
          fill="none"
          stroke="var(--color-brand-200)"
          strokeWidth="2.1"
          strokeLinecap="round"
        />
        <path
          d={BRAND_ROUTE_PATH}
          fill="none"
          stroke="var(--color-brand)"
          strokeWidth="2.1"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray="28 72"
          className="motion-safe:animate-route"
        />
        <circle cx="8" cy="10.5" r="2.35" fill="var(--color-brand)" />
        <circle
          cx="16"
          cy="10.5"
          r="1.85"
          fill="var(--color-page)"
          stroke="var(--color-brand)"
          strokeWidth="1.5"
        />
        <circle cx="24" cy="10.5" r="2.35" fill="var(--color-brand)" />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
