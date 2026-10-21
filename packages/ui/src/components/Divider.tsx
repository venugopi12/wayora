import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface DividerProps {
  orientation?: 'horizontal' | 'vertical';
  /** Optional centred text, e.g. "or". Horizontal only. */
  label?: ReactNode;
  /** Decorative dividers are hidden from assistive technology. */
  decorative?: boolean;
  className?: string;
}

export function Divider({
  orientation = 'horizontal',
  label,
  decorative = true,
  className,
}: DividerProps) {
  const a11y = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'separator', 'aria-orientation': orientation };

  if (orientation === 'vertical') {
    return <span {...a11y} className={cn('inline-block w-px self-stretch bg-line', className)} />;
  }
  if (label) {
    return (
      <div
        {...a11y}
        className={cn('flex items-center gap-4 text-caption text-ink-secondary', className)}
      >
        <span className="h-px flex-1 bg-line" />
        {label}
        <span className="h-px flex-1 bg-line" />
      </div>
    );
  }
  return <hr {...a11y} className={cn('h-px border-0 bg-line', className)} />;
}
