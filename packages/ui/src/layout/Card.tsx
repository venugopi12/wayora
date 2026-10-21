import { forwardRef } from 'react';
import { cn } from '../lib/cn';
import { Surface, type SurfaceProps } from './Surface';
import { interaction } from '../motion/presets';

export interface CardProps extends Omit<SurfaceProps, 'bordered'> {
  /**
   * Adds hover elevation. Use only when the whole card is a link or button
   * (pair with a `stretched-link` inside), so the affordance is truthful.
   */
  interactive?: boolean;
  elevation?: 'none' | 'sm' | 'md';
}

/** Bordered white container for grouped content. */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { interactive = false, elevation = 'sm', tone = 'card', radius = 'xl', className, ...rest },
  ref,
) {
  return (
    <Surface
      ref={ref}
      tone={tone}
      radius={radius}
      bordered
      className={cn(
        'relative',
        elevation === 'sm' && 'shadow-xs',
        elevation === 'md' && 'shadow-sm',
        interactive && interaction.hoverLift,
        interactive &&
          'hover:border-brand-200 has-[:focus-visible]:border-brand has-[:focus-visible]:shadow-md',
        className,
      )}
      {...rest}
    />
  );
});
