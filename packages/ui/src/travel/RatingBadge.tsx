import { Star } from 'lucide-react';
import { cn } from '../lib/cn';
import { plural } from '../lib/format';

export interface RatingBadgeProps {
  score: number;
  /** Rating scale maximum: 10 (guest score) or 5 (stars). */
  outOf?: 5 | 10;
  reviewCount?: number;
  /** Override the verbal label derived from the score. */
  label?: string;
  size?: 'sm' | 'md';
  className?: string;
}

/** Verbal label shared by both scales (normalised to /10). */
export function ratingLabel(score: number, outOf: 5 | 10 = 10): string {
  const s = outOf === 5 ? score * 2 : score;
  if (s >= 9) return 'Exceptional';
  if (s >= 8) return 'Excellent';
  if (s >= 7) return 'Very good';
  if (s >= 6) return 'Good';
  return 'Fair';
}

/** Guest score with a verbal label, announced as a single sentence. */
export function RatingBadge({
  score,
  outOf = 10,
  reviewCount,
  label,
  size = 'md',
  className,
}: RatingBadgeProps) {
  const text = label ?? ratingLabel(score, outOf);
  const value = score.toFixed(1);
  const reviews = reviewCount !== undefined ? plural(reviewCount, 'review') : undefined;
  const spoken = `Rated ${value} out of ${outOf}, ${text}${reviews ? `, ${reviews}` : ''}`;

  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <span className="sr-only">{spoken}</span>
      <span
        aria-hidden="true"
        className={cn(
          'numeric inline-flex items-center gap-1 rounded-sm bg-deep font-bold text-ink-inverse',
          size === 'sm' ? 'px-1.5 py-0.5 text-caption' : 'px-2 py-1 text-label',
        )}
      >
        {outOf === 5 ? <Star className="size-3 fill-current" aria-hidden="true" /> : null}
        {value}
      </span>
      <span aria-hidden="true" className="flex flex-col leading-tight">
        <span
          className={cn('font-semibold text-ink', size === 'sm' ? 'text-caption' : 'text-body-sm')}
        >
          {text}
        </span>
        {reviews && size === 'md' ? (
          <span className="numeric text-caption text-ink-secondary">{reviews}</span>
        ) : null}
      </span>
    </span>
  );
}
