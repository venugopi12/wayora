import { Slot } from 'radix-ui';
import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export type SurfaceTone = 'page' | 'card' | 'sunken' | 'brand' | 'deep';

export const surfaceTones: Record<SurfaceTone, string> = {
  page: 'bg-page text-ink',
  card: 'bg-card text-ink',
  sunken: 'bg-sunken text-ink',
  brand: 'bg-brand-soft text-ink',
  deep: 'bg-deep text-ink-inverse focus-ring-inverse',
};

export const paddings = {
  none: '',
  sm: 'p-4',
  md: 'p-5 sm:p-6',
  lg: 'p-6 sm:p-8',
} as const;

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  tone?: SurfaceTone;
  padding?: keyof typeof paddings;
  radius?: 'none' | 'md' | 'lg' | 'xl' | '2xl';
  bordered?: boolean;
  asChild?: boolean;
}

const radii = {
  none: '',
  md: 'rounded-md',
  lg: 'rounded-lg',
  xl: 'rounded-xl',
  '2xl': 'rounded-2xl',
} as const;

/**
 * A coloured, padded region. The lowest-level box: it sets background, text
 * colour (and focus ring colour on dark tones). Card builds on it.
 */
export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(function Surface(
  { tone = 'card', padding = 'md', radius = 'lg', bordered = false, asChild, className, ...rest },
  ref,
) {
  const Comp = asChild ? Slot.Root : 'div';
  return (
    <Comp
      ref={ref}
      className={cn(
        surfaceTones[tone],
        paddings[padding],
        radii[radius],
        bordered && (tone === 'deep' ? 'border border-line-inverse' : 'border border-line'),
        className,
      )}
      {...rest}
    />
  );
});
