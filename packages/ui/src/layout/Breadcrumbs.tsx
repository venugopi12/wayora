import { ChevronRight } from 'lucide-react';
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface BreadcrumbItem {
  label: string;
  /**
   * Link element for an ancestor page, e.g. <Link to="/discover" />. Omit for
   * the current page (always the last item) or for a level with no page of
   * its own (rendered as plain text, never a guessed URL).
   */
  link?: ReactElement;
}

export interface BreadcrumbsProps {
  items: readonly BreadcrumbItem[];
  /** `inverse` on deep or photographic backgrounds. */
  tone?: 'default' | 'inverse';
  className?: string;
}

/**
 * Breadcrumb trail (WAI-ARIA breadcrumb pattern): a `nav` named "Breadcrumb"
 * with an ordered list; the last item is the current page (`aria-current`).
 * Separators are decorative. Long trails wrap; a long current-page label is
 * truncated visually but stays whole for assistive technology.
 */
export function Breadcrumbs({ items, tone = 'default', className }: BreadcrumbsProps) {
  if (items.length === 0) return null;
  const inverse = tone === 'inverse';
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol
        className={cn(
          'flex flex-wrap items-center gap-x-1.5 gap-y-1 text-body-sm',
          inverse ? 'text-ink-inverse-secondary' : 'text-ink-secondary',
        )}
      >
        {items.map((item, i) => {
          const current = i === items.length - 1;
          let content: ReactNode;
          if (current) {
            content = (
              <span
                aria-current="page"
                className={cn(
                  'block max-w-[24ch] truncate font-semibold sm:max-w-[40ch]',
                  inverse ? 'text-ink-inverse' : 'text-ink',
                )}
              >
                {item.label}
              </span>
            );
          } else if (isValidElement(item.link)) {
            content = cloneElement(
              item.link as ReactElement<{ className?: string; children?: ReactNode }>,
              {
                className: cn(
                  'touch-target rounded-xs underline-offset-4 hover:underline',
                  inverse ? 'hover:text-ink-inverse' : 'hover:text-ink',
                ),
                children: item.label,
              },
            );
          } else {
            content = <span>{item.label}</span>;
          }
          return (
            <li key={`${item.label}-${i}`} className="flex min-w-0 items-center gap-1.5">
              {i > 0 ? <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" /> : null}
              {content}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
