import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Eyebrow } from './Eyebrow';

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons or a link aligned to the end on wide screens, below the text on mobile. */
  actions?: ReactNode;
  /** Breadcrumbs or a back link, shown above the title. */
  leading?: ReactNode;
  /** Short kicker above the title, drawn with a brand hairline ("Featured destinations"). */
  eyebrow?: ReactNode;
  /** Small contextual element beside the title, e.g. a Badge. */
  meta?: ReactNode;
  /** `h1` by default; use `h2` for a section heading on a page that already has an h1. */
  headingLevel?: 'h1' | 'h2';
  /**
   * `page`: title block at the top of a page (default).
   * `section`: editorial section intro — the title is set one step larger.
   */
  size?: 'page' | 'section';
  /** `inverse` for deep or photographic backgrounds. */
  tone?: 'default' | 'inverse';
  align?: 'start' | 'center';
  /** Id for the heading, so a `<section aria-labelledby>` can name the region. */
  id?: string;
  className?: string;
}

/**
 * Title block for a page or a major section: optional eyebrow, heading,
 * description and actions. The heading level is chosen by the caller so the
 * document outline stays correct; visual size is independent of level.
 */
export function PageHeader({
  title,
  description,
  actions,
  leading,
  eyebrow,
  meta,
  headingLevel: Heading = 'h1',
  size = 'page',
  tone = 'default',
  align = 'start',
  id,
  className,
}: PageHeaderProps) {
  const inverse = tone === 'inverse';
  const section = size === 'section';
  const titleClass = section || Heading === 'h1' ? 'text-heading-1' : 'text-heading-2';
  return (
    <header
      className={cn(
        'flex flex-col gap-6 md:flex-row md:items-end md:justify-between',
        align === 'center' && 'items-center text-center md:flex-col md:items-center',
        className,
      )}
    >
      <div
        className={cn(
          'flex flex-col',
          section ? 'max-w-[40rem] gap-4' : 'max-w-narrow gap-3',
          align === 'center' && 'items-center',
        )}
      >
        {leading}
        {eyebrow ? <Eyebrow tone={tone}>{eyebrow}</Eyebrow> : null}
        {meta ? (
          <div
            className={cn(
              'flex flex-wrap items-center gap-3',
              align === 'center' && 'justify-center',
            )}
          >
            <Heading id={id} className={titleClass}>
              {title}
            </Heading>
            {meta}
          </div>
        ) : (
          <Heading id={id} className={titleClass}>
            {title}
          </Heading>
        )}
        {description ? (
          <p
            className={cn(
              'max-w-prose text-body-lg',
              inverse ? 'text-ink-inverse-secondary' : 'text-ink-secondary',
            )}
          >
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-3">{actions}</div> : null}
    </header>
  );
}
