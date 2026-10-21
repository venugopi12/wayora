import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'inverse';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: 'sm' | 'md';
  /** Leading status dot. */
  dot?: boolean;
  icon?: ReactNode;
}

const tones: Record<BadgeTone, { box: string; dot: string }> = {
  neutral: { box: 'bg-sunken text-ink-secondary ring-line', dot: 'bg-ink-subtle' },
  brand: { box: 'bg-brand-soft text-brand-ink ring-brand-200', dot: 'bg-brand' },
  success: { box: 'bg-success-soft text-success-ink ring-success/20', dot: 'bg-success' },
  warning: { box: 'bg-warning-soft text-warning-ink ring-warning/25', dot: 'bg-warning' },
  danger: { box: 'bg-danger-soft text-danger-ink ring-danger/20', dot: 'bg-danger' },
  inverse: { box: 'bg-white/10 text-ink-inverse ring-white/20', dot: 'bg-brand-300' },
};

/** Short status or category label. Not interactive. */
export function Badge({
  tone = 'neutral',
  size = 'md',
  dot,
  icon,
  className,
  children,
  ...rest
}: BadgeProps) {
  const t = tones[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full font-semibold whitespace-nowrap ring-1 ring-inset [&_svg]:size-3.5',
        size === 'sm' ? 'px-2 py-0.5 text-caption' : 'px-2.5 py-1 text-caption',
        t.box,
        className,
      )}
      {...rest}
    >
      {dot ? <span className={cn('size-1.5 rounded-full', t.dot)} aria-hidden="true" /> : null}
      {icon}
      {children}
    </span>
  );
}
