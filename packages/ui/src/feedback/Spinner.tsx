import { cn } from '../lib/cn';

export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  /** Accessible label. Pass "" when a parent already announces the busy state. */
  label?: string;
  className?: string;
}

const sizes = { sm: 'size-4', md: 'size-5', lg: 'size-8' } as const;

/** Inline activity indicator for buttons and small regions. */
export function Spinner({ size = 'md', label = 'Loading', className }: SpinnerProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={cn('animate-spin', sizes[size], className)}
      role={label ? 'status' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
