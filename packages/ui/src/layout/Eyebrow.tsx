import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export interface EyebrowProps extends HTMLAttributes<HTMLParagraphElement> {
  /** `inverse` on deep or photographic backgrounds. */
  tone?: 'default' | 'inverse';
}

/**
 * Short kicker above a title, drawn with a brand hairline ("Featured
 * destinations"). `PageHeader` renders it through its `eyebrow` prop; use this
 * directly when a section composes its own title block (hero, CTA bands).
 */
export function Eyebrow({ tone = 'default', className, children, ...rest }: EyebrowProps) {
  const inverse = tone === 'inverse';
  return (
    <p
      className={cn(
        'flex items-center gap-3 text-label',
        inverse ? 'text-brand-200' : 'text-brand-ink',
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cn('h-px w-8 shrink-0', inverse ? 'bg-brand-200' : 'bg-brand')}
      />
      {children}
    </p>
  );
}
