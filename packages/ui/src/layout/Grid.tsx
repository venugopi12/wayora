import type { CSSProperties, ElementType, HTMLAttributes } from 'react';
import { cn } from '../lib/cn';
import { gapClasses, type Gap } from './Stack';

type Cols = 1 | 2 | 3 | 4 | 5 | 6;

const colClasses = {
  base: {
    1: 'grid-cols-1',
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-4',
    5: 'grid-cols-5',
    6: 'grid-cols-6',
  },
  sm: {
    1: 'sm:grid-cols-1',
    2: 'sm:grid-cols-2',
    3: 'sm:grid-cols-3',
    4: 'sm:grid-cols-4',
    5: 'sm:grid-cols-5',
    6: 'sm:grid-cols-6',
  },
  md: {
    1: 'md:grid-cols-1',
    2: 'md:grid-cols-2',
    3: 'md:grid-cols-3',
    4: 'md:grid-cols-4',
    5: 'md:grid-cols-5',
    6: 'md:grid-cols-6',
  },
  lg: {
    1: 'lg:grid-cols-1',
    2: 'lg:grid-cols-2',
    3: 'lg:grid-cols-3',
    4: 'lg:grid-cols-4',
    5: 'lg:grid-cols-5',
    6: 'lg:grid-cols-6',
  },
  xl: {
    1: 'xl:grid-cols-1',
    2: 'xl:grid-cols-2',
    3: 'xl:grid-cols-3',
    4: 'xl:grid-cols-4',
    5: 'xl:grid-cols-5',
    6: 'xl:grid-cols-6',
  },
} as const;

export interface GridProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  /** Explicit responsive columns, e.g. `{ base: 1, md: 2, lg: 4 }`. */
  columns?: Partial<Record<keyof typeof colClasses, Cols>>;
  /**
   * Fluid alternative to `columns`: fit as many columns as possible with each
   * at least this wide (CSS length, e.g. "16rem"). Never overflows on mobile.
   */
  minItemWidth?: string;
  gap?: Gap;
}

/** Two-dimensional layout for cards and tiles. */
export function Grid({
  as: Tag = 'div',
  columns,
  minItemWidth,
  gap = 6,
  className,
  style,
  ...rest
}: GridProps) {
  const fluid: CSSProperties | undefined = minItemWidth
    ? { gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${minItemWidth}), 1fr))` }
    : undefined;
  const responsive = columns
    ? (Object.keys(columns) as (keyof typeof colClasses)[]).map((bp) => {
        const n = columns[bp];
        return n ? colClasses[bp][n] : undefined;
      })
    : [];
  return (
    <Tag
      className={cn(
        'grid',
        !columns && !minItemWidth && 'grid-cols-1',
        ...responsive,
        gapClasses[gap],
        className,
      )}
      style={{ ...fluid, ...style }}
      {...rest}
    />
  );
}
