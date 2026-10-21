import { Menu, X } from 'lucide-react';
import { Dialog as DialogPrimitive, Slot } from 'radix-ui';
import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { IconButton, type ButtonVariant } from '../components/Button';
import { cn } from '../lib/cn';
import { overlayMotion } from '../motion/presets';

/** First focusable element on every page: jumps keyboard users to <main>. */
export function SkipLink({
  href = '#main',
  children = 'Skip to content',
}: {
  href?: string;
  children?: ReactNode;
}) {
  return (
    <a
      href={href}
      className="fixed top-3 left-3 z-(--z-toast) -translate-y-[200%] rounded-md bg-deep px-4 py-2.5 text-label text-ink-inverse shadow-md transition-transform duration-(--duration-fast) focus-ring-inverse focus:translate-y-0"
    >
      {children}
    </a>
  );
}

export interface NavListProps {
  /** Accessible name for the <nav> landmark, e.g. "Primary". */
  label: string;
  orientation?: 'horizontal' | 'vertical';
  className?: string;
  children: ReactNode;
}

/** A labelled <nav> with a list of NavItems. */
export function NavList({ label, orientation = 'horizontal', className, children }: NavListProps) {
  return (
    <nav aria-label={label} className={className}>
      <ul
        className={cn(
          'flex',
          orientation === 'horizontal' ? 'items-center gap-1' : 'flex-col gap-1',
        )}
      >
        {children}
      </ul>
    </nav>
  );
}

export interface NavItemProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  /** Marks the current page (sets aria-current="page"). */
  active?: boolean;
  /** Render a router Link as the child: <NavItem asChild><Link to="/" /></NavItem>. */
  asChild?: boolean;
  size?: 'md' | 'lg';
  /** Use on deep-navy surfaces. */
  inverse?: boolean;
}

/** A navigation link inside NavList. Renders its own <li>. */
export const NavItem = forwardRef<HTMLAnchorElement, NavItemProps>(function NavItem(
  { active, asChild, size = 'md', inverse, className, ...rest },
  ref,
) {
  const Comp = asChild ? Slot.Root : 'a';
  return (
    <li>
      <Comp
        ref={ref}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex items-center rounded-md font-semibold transition-colors duration-(--duration-fast) ease-standard',
          size === 'lg' ? 'min-h-12 px-4 text-title' : 'min-h-10 px-3.5 text-body-sm',
          inverse
            ? 'text-ink-inverse-secondary hover:bg-white/10 hover:text-ink-inverse aria-[current=page]:text-ink-inverse'
            : 'text-ink-secondary hover:bg-brand-soft hover:text-brand-ink aria-[current=page]:bg-brand-soft aria-[current=page]:text-brand-ink',
          className,
        )}
        {...rest}
      />
    </li>
  );
});

export interface MobileNavProps {
  /** Variant for the menu button, e.g. `ghost-inverse` over a dark hero. */
  triggerVariant?: ButtonVariant;
  /** Header content inside the sheet, usually the Wordmark. */
  title: ReactNode;
  /** Accessible title for the dialog. */
  label?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Usually a vertical NavList. Close the sheet on navigation via onOpenChange. */
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/**
 * Small-screen navigation: a menu button that opens a right-hand sheet.
 * Focus is trapped while open, Escape and the close button dismiss it,
 * and focus returns to the menu button. Hide it from `md` up.
 */
export function MobileNav({
  triggerVariant = 'ghost',
  title,
  label = 'Menu',
  open,
  onOpenChange,
  children,
  footer,
  className,
}: MobileNavProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Trigger asChild>
        <IconButton
          label="Open menu"
          icon={<Menu />}
          variant={triggerVariant}
          className={className}
        />
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn('fixed inset-0 z-(--z-overlay) bg-scrim', overlayMotion.backdrop)}
        />
        <DialogPrimitive.Content
          className={cn(
            'fixed inset-y-0 right-0 z-(--z-modal) flex w-[min(22rem,88vw)] flex-col bg-page shadow-lg',
            overlayMotion.drawer,
          )}
          aria-describedby={undefined}
        >
          <div className="flex h-16 items-center justify-between border-b border-line px-5">
            <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
            {title}
            <DialogPrimitive.Close asChild>
              <IconButton label="Close menu" icon={<X />} />
            </DialogPrimitive.Close>
          </div>
          <div className="flex-1 overflow-y-auto p-4">{children}</div>
          {footer ? <div className="border-t border-line p-5">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
