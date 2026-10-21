import { X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { IconButton } from '../components/Button';
import { cn } from '../lib/cn';
import { overlayMotion } from '../motion/presets';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps {
  /** Required: names the dialog for assistive technology. */
  title: ReactNode;
  description?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Action row; put the primary action last. */
  footer?: ReactNode;
  /** Hide the corner close button (Escape still closes). */
  hideClose?: boolean;
  className?: string;
  children?: ReactNode;
}

const sizes = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' } as const;

/**
 * Modal dialog content. Focus is trapped and restored, Escape and the
 * overlay close it, and background content is inert.
 *
 *   <Dialog>
 *     <DialogTrigger asChild><Button>Open</Button></DialogTrigger>
 *     <DialogContent title="Change dates" footer={…}>…</DialogContent>
 *   </Dialog>
 */
export function DialogContent({
  title,
  description,
  size = 'md',
  footer,
  hideClose = false,
  className,
  children,
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          'fixed inset-0 z-(--z-overlay) bg-scrim backdrop-blur-[2px]',
          overlayMotion.backdrop,
        )}
      />
      <DialogPrimitive.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-(--z-modal) flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col',
          'rounded-xl bg-card shadow-lg focus:outline-none',
          overlayMotion.dialog,
          sizes[size],
          className,
        )}
        {...(description ? {} : { 'aria-describedby': undefined })}
      >
        <div className="flex items-start justify-between gap-4 px-6 pt-6">
          <div className="flex flex-col gap-1.5">
            <DialogPrimitive.Title className="text-heading-3">{title}</DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="text-body-sm text-ink-secondary">
                {description}
              </DialogPrimitive.Description>
            ) : null}
          </div>
          {hideClose ? null : (
            <DialogPrimitive.Close asChild>
              <IconButton label="Close" icon={<X />} size="sm" className="-mt-1 -mr-2" />
            </DialogPrimitive.Close>
          )}
        </div>
        {children ? (
          <div className="overflow-y-auto px-6 pt-4 pb-2 text-body text-ink-secondary">
            {children}
          </div>
        ) : null}
        {footer ? (
          <div className="mt-2 flex flex-col-reverse gap-3 border-t border-line px-6 py-4 sm:flex-row sm:justify-end">
            {footer}
          </div>
        ) : (
          <div className="pb-6" />
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
