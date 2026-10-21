import { cn } from '../lib/cn';
import { BrandMark } from './BrandMark';

export interface WordmarkProps {
  /** sm: dense UI (mobile nav, footer legal), md: header, lg: marketing moments. */
  size?: 'sm' | 'md' | 'lg';
  /** `light` for light surfaces, `dark` for deep-navy surfaces. */
  surface?: 'light' | 'dark';
  /** Hide the logotype and show the mark only (keeps the accessible name). */
  markOnly?: boolean;
  className?: string;
}

const sizes = {
  sm: { mark: 24, text: 'text-[1.125rem]', gap: 'gap-2' },
  md: { mark: 32, text: 'text-[1.4375rem]', gap: 'gap-2.5' },
  lg: { mark: 44, text: 'text-[2rem]', gap: 'gap-3' },
} as const;

/** Mark + lowercase logotype. Announced once as "Wayora". */
export function Wordmark({
  size = 'md',
  surface = 'light',
  markOnly = false,
  className,
}: WordmarkProps) {
  const s = sizes[size];
  return (
    <span className={cn('inline-flex items-center', s.gap, className)}>
      <BrandMark
        size={s.mark}
        tone={surface === 'dark' ? 'inverse' : 'brand'}
        title={markOnly ? 'Wayora' : undefined}
      />
      {markOnly ? null : (
        <span
          className={cn(
            'leading-none font-bold tracking-[-0.045em]',
            s.text,
            surface === 'dark' ? 'text-ink-inverse' : 'text-deep',
          )}
        >
          wayora
        </span>
      )}
    </span>
  );
}
