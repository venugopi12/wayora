import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { Toast as ToastPrimitive } from 'radix-ui';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { overlayMotion } from '../motion/presets';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Milliseconds before auto-dismiss. Errors default to staying longer. */
  duration?: number;
  /** One optional action; `altText` explains it for screen-reader users. */
  action?: { label: string; altText: string; onClick: () => void };
}

interface ToastRecord extends ToastOptions {
  id: number;
  open: boolean;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const icons = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
} as const;
const iconTone = {
  info: 'text-brand-300',
  success: 'text-success-on-deep',
  warning: 'text-warning-on-deep',
  danger: 'text-danger-on-deep',
} as const;

let nextId = 1;

/**
 * Provides `useToast()`. Mount once near the app root. Toasts are announced
 * politely (assertively for `danger`), pause on hover/focus, and can be
 * swiped away or dismissed with the close button. F8 focuses the region.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.map((t) => (t.id === id ? { ...t, open: false } : t)));
    // Remove after the exit animation.
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), 300);
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    const id = nextId++;
    setToasts((all) => [...all.slice(-2), { ...options, id, open: true }]);
    return id;
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      <ToastPrimitive.Provider swipeDirection="right" label="Notifications">
        {children}
        {toasts.map((t) => {
          const tone = t.tone ?? 'info';
          const Icon = icons[tone];
          return (
            <ToastPrimitive.Root
              key={t.id}
              open={t.open}
              onOpenChange={(open) => (open ? undefined : dismiss(t.id))}
              duration={t.duration ?? (tone === 'danger' ? 8000 : 5000)}
              type={tone === 'danger' ? 'foreground' : 'background'}
              className={cn(
                'flex w-full items-start gap-3 rounded-lg bg-deep p-4 text-ink-inverse shadow-lg focus-ring-inverse',
                overlayMotion.toast,
                'data-[swipe=move]:translate-x-(--radix-toast-swipe-move-x) data-[swipe=cancel]:translate-x-0 data-[swipe=end]:animate-fade-out',
              )}
            >
              <Icon className={cn('mt-0.5 size-5 shrink-0', iconTone[tone])} aria-hidden="true" />
              <div className="flex flex-1 flex-col gap-1">
                <ToastPrimitive.Title className="text-label">{t.title}</ToastPrimitive.Title>
                {t.description ? (
                  <ToastPrimitive.Description className="text-body-sm text-ink-inverse-secondary">
                    {t.description}
                  </ToastPrimitive.Description>
                ) : null}
                {t.action ? (
                  <ToastPrimitive.Action
                    altText={t.action.altText}
                    onClick={t.action.onClick}
                    className="mt-1 self-start rounded-sm text-label text-brand-200 underline-offset-4 hover:underline"
                  >
                    {t.action.label}
                  </ToastPrimitive.Action>
                ) : null}
              </div>
              <ToastPrimitive.Close
                aria-label="Dismiss notification"
                className="-m-1 grid size-8 place-items-center rounded-sm text-ink-inverse-secondary hover:bg-white/10 hover:text-ink-inverse"
              >
                <X className="size-4" aria-hidden="true" />
              </ToastPrimitive.Close>
            </ToastPrimitive.Root>
          );
        })}
        <ToastPrimitive.Viewport className="fixed right-0 bottom-0 z-(--z-toast) m-0 flex w-full max-w-sm list-none flex-col gap-3 p-4 outline-none sm:p-6" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

/** Shows transient confirmation of something the person just did. */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
