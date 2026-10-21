import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn';
import { Container, type ContainerSize } from './Container';
import { surfaceTones, type SurfaceTone } from './Surface';

export interface SectionProps extends HTMLAttributes<HTMLElement> {
  tone?: SurfaceTone;
  spacing?: 'sm' | 'md' | 'none';
  /** Wraps children in a Container of this size. Pass `false` to opt out. */
  container?: ContainerSize | false;
  /** Draws a top hairline to separate from a same-tone section above. */
  divided?: boolean;
}

const spacings = { none: '', sm: 'py-section-sm', md: 'py-section' } as const;

/**
 * A full-width page band with fluid vertical rhythm. Give it `aria-labelledby`
 * pointing to its heading so it is exposed as a landmark region.
 */
export function Section({
  tone = 'page',
  spacing = 'md',
  container = 'page',
  divided,
  className,
  children,
  ...rest
}: SectionProps) {
  return (
    <section
      className={cn(
        surfaceTones[tone],
        spacings[spacing],
        divided && 'border-t border-line',
        className,
      )}
      {...rest}
    >
      {container ? <Container size={container}>{children}</Container> : children}
    </section>
  );
}
