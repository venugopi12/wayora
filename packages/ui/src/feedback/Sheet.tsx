import { X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { IconButton } from '../components/Button';
import { cn } from '../lib/cn';
import { overlayMotion } from '../motion/presets';

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export interface SheetContentProps {
  /** Required: names the sheet for assistive technology (shown as its heading). */
  title: ReactNode;
  description?: ReactNode;
  /** Sticky action row at the bottom, e.g. "Show 12 results". */
  footer?: ReactNode;
  /** Label of the close button. */
  closeLabel?: string;
  /**
   * `right` (default): a side panel. `bottom`: a sheet rising from the bottom
   * edge, for short lists of actions on phones.
   */
  side?: 'right' | 'bottom';
  className?: string;
  children: ReactNode;
}

/**
 * A panel that slides in from the right edge (e.g. filters on small
 * screens). It is a modal dialog: focus moves into it and is trapped,
 * Escape, the backdrop and the close button dismiss it, the page behind is
 * inert and scroll-locked, and focus returns to the trigger on close. Under
 * reduced motion it appears without the slide (base.css).
 *
 *   <Sheet open={open} onOpenChange={setOpen}>
 *     <SheetTrigger asChild><Button>Filters</Button></SheetTrigger>
 *     <SheetContent title="Filters" footer={…}>…</SheetContent>
 *   </Sheet>
 */
export function SheetContent({
  title,
  description,
  footer,
  closeLabel = 'Close',
  side = 'right',
  className,
  children,
}: SheetContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn('fixed inset-0 z-(--z-overlay) bg-scrim', overlayMotion.backdrop)}
      />
      <DialogPrimitive.Content
        className={cn(
          'fixed z-(--z-modal) flex flex-col bg-page shadow-lg focus:outline-none',
          side === 'right'
            ? `inset-y-0 right-0 w-[min(26rem,92vw)] pt-[env(safe-area-inset-top)] ${overlayMotion.drawer}`
            : `inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl ${overlayMotion.bottomSheet}`,
          className,
        )}
        {...(description ? {} : { 'aria-describedby': undefined })}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="flex flex-col gap-1">
            <DialogPrimitive.Title className="text-heading-3">{title}</DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="text-body-sm text-ink-secondary">
                {description}
              </DialogPrimitive.Description>
            ) : null}
          </div>
          <DialogPrimitive.Close asChild>
            <IconButton label={closeLabel} icon={<X />} size="sm" className="-mr-2" />
          </DialogPrimitive.Close>
        </div>
        <div
          className={cn(
            'flex-1 overflow-y-auto px-5 py-5',
            // Keep the last row clear of the home indicator when there's no footer.
            !footer && 'pb-[max(1.25rem,env(safe-area-inset-bottom))]',
          )}
        >
          {children}
        </div>
        {footer ? (
          <div className="border-t border-line px-5 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
