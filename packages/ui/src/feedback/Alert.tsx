import { AlertTriangle, CheckCircle2, Info, XCircle, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

const tones: Record<AlertTone, { box: string; icon: string; Icon: LucideIcon }> = {
  info: { box: 'bg-info-soft border-brand-200', icon: 'text-brand', Icon: Info },
  success: { box: 'bg-success-soft border-success/25', icon: 'text-success', Icon: CheckCircle2 },
  warning: { box: 'bg-warning-soft border-warning/30', icon: 'text-warning', Icon: AlertTriangle },
  danger: { box: 'bg-danger-soft border-danger/25', icon: 'text-danger', Icon: XCircle },
};

export interface AlertProps {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  /**
   * `alert` interrupts screen readers — reserve it for errors and warnings
   * that appear after a user action. Defaults: danger/warning → alert, others → status.
   * Use `none` for static page content.
   */
  role?: 'alert' | 'status' | 'none';
  className?: string;
}

/** Inline, persistent message about a region or the whole page. */
export function Alert({ tone = 'info', title, children, action, role, className }: AlertProps) {
  const t = tones[tone];
  const resolvedRole = role ?? (tone === 'danger' || tone === 'warning' ? 'alert' : 'status');
  return (
    <div
      role={resolvedRole === 'none' ? undefined : resolvedRole}
      className={cn('flex gap-3 rounded-lg border p-4', t.box, className)}
    >
      <t.Icon className={cn('mt-0.5 size-5 shrink-0', t.icon)} aria-hidden="true" />
      <div className="flex flex-1 flex-col gap-1">
        {title ? <p className="text-label text-ink">{title}</p> : null}
        {children ? <div className="text-body-sm text-ink-secondary">{children}</div> : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    </div>
  );
}
