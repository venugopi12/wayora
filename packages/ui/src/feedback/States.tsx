import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** The next step, usually one Button. */
  action?: ReactNode;
  /** `inline` for inside cards and panels, `page` for whole regions. */
  size?: 'inline' | 'page';
  className?: string;
}

/** Shown when there is nothing to display yet. Tell people what to do next. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  size = 'inline',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center text-center',
        size === 'page' ? 'gap-4 py-16' : 'gap-3 py-10',
        className,
      )}
    >
      {icon ? (
        <span
          className="grid size-12 place-items-center rounded-full bg-brand-soft text-brand-ink [&_svg]:size-6"
          aria-hidden="true"
        >
          {icon}
        </span>
      ) : null}
      <div className="flex max-w-sm flex-col gap-1.5">
        <p className={size === 'page' ? 'text-heading-3' : 'text-title'}>{title}</p>
        {description ? <p className="text-body-sm text-ink-secondary">{description}</p> : null}
      </div>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export interface ErrorStateProps {
  title: ReactNode;
  /** What went wrong and how to fix it. */
  description: ReactNode;
  /** Usually a "Try again" Button. */
  action?: ReactNode;
  /** Support reference, e.g. the API request ID. */
  reference?: string;
  className?: string;
}

/** A failed region or request, with a recovery action. Announced as an alert. */
export function ErrorState({ title, description, action, reference, className }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-start gap-4 rounded-lg border border-danger/25 bg-danger-soft p-5 sm:flex-row sm:items-center',
        className,
      )}
    >
      <AlertTriangle className="size-5 shrink-0 text-danger" aria-hidden="true" />
      <div className="flex-1">
        <p className="text-label text-ink">{title}</p>
        <div className="mt-1 text-body-sm text-ink-secondary">{description}</div>
        {reference ? (
          <p className="mt-1 text-caption text-ink-secondary">
            Reference <span className="numeric font-mono">{reference}</span>
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
