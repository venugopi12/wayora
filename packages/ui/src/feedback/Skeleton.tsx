import { cn } from '../lib/cn';
import { effects } from '../motion/presets';

export interface SkeletonProps {
  shape?: 'rect' | 'text' | 'circle';
  /** For `text`: number of lines; the last is shortened. */
  lines?: number;
  /**
   * `pulse` (default) gently fades; `sheen` sweeps a highlight across;
   * `none` is static. Both effects stop under reduced motion.
   */
  effect?: 'pulse' | 'sheen' | 'none';
  className?: string;
}

/**
 * Placeholder for content that is loading. Decorative: announce loading on
 * the container (`aria-busy`) or with a Spinner/BrandLoader label instead.
 */
export function Skeleton({
  shape = 'rect',
  lines = 3,
  effect = 'pulse',
  className,
}: SkeletonProps) {
  const block = cn(
    'bg-line',
    effect === 'pulse' && 'motion-safe:animate-shimmer',
    effect === 'sheen' && effects.shimmer,
  );
  if (shape === 'text') {
    return (
      <span className={cn('flex w-full flex-col gap-2', className)} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <span
            key={i}
            className={cn(
              block,
              'h-3 rounded-xs',
              i === lines - 1 && lines > 1 ? 'w-3/5' : 'w-full',
            )}
          />
        ))}
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(block, 'block', shape === 'circle' ? 'rounded-full' : 'rounded-md', className)}
    />
  );
}
