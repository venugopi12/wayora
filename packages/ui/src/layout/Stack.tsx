import type { ElementType, HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export type Gap = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 | 16;

// Literal class strings so Tailwind can detect them.
export const gapClasses: Record<Gap, string> = {
  0: 'gap-0',
  1: 'gap-1',
  2: 'gap-2',
  3: 'gap-3',
  4: 'gap-4',
  5: 'gap-5',
  6: 'gap-6',
  8: 'gap-8',
  10: 'gap-10',
  12: 'gap-12',
  16: 'gap-16',
};

const aligns = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  stretch: 'items-stretch',
  baseline: 'items-baseline',
} as const;
const justifies = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  between: 'justify-between',
} as const;

export interface StackProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  direction?: 'column' | 'row';
  /** Switch from column to row at a breakpoint (mobile-first stacking). */
  rowFrom?: 'sm' | 'md' | 'lg';
  gap?: Gap;
  align?: keyof typeof aligns;
  justify?: keyof typeof justifies;
  wrap?: boolean;
}

const rowFromClasses = { sm: 'sm:flex-row', md: 'md:flex-row', lg: 'lg:flex-row' } as const;

/** One-dimensional layout with token-based gaps. */
export function Stack({
  as: Tag = 'div',
  direction = 'column',
  rowFrom,
  gap = 4,
  align,
  justify,
  wrap,
  className,
  ...rest
}: StackProps) {
  return (
    <Tag
      className={cn(
        'flex',
        direction === 'row' ? 'flex-row' : 'flex-col',
        rowFrom && rowFromClasses[rowFrom],
        gapClasses[gap],
        align && aligns[align],
        justify && justifies[justify],
        wrap && 'flex-wrap',
        className,
      )}
      {...rest}
    />
  );
}
