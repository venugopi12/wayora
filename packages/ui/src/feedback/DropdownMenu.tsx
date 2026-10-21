import { Check } from 'lucide-react';
import { DropdownMenu as MenuPrimitive } from 'radix-ui';
import { forwardRef, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { overlayMotion } from '../motion/presets';

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuGroup = MenuPrimitive.Group;

export interface DropdownMenuContentProps {
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom';
  className?: string;
  children: ReactNode;
}

/**
 * Menu of actions. Arrow keys move, typeahead jumps, Enter selects, Escape
 * closes and returns focus to the trigger. For form values use Select.
 */
export function DropdownMenuContent({
  align = 'start',
  side = 'bottom',
  className,
  children,
}: DropdownMenuContentProps) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        align={align}
        side={side}
        sideOffset={6}
        collisionPadding={12}
        className={cn(
          'z-(--z-dropdown) min-w-52 rounded-lg border border-line bg-card p-1.5 shadow-md',
          'origin-(--radix-dropdown-menu-content-transform-origin)',
          overlayMotion.dropdown,
          className,
        )}
      >
        {children}
      </MenuPrimitive.Content>
    </MenuPrimitive.Portal>
  );
}

export interface DropdownMenuItemProps {
  icon?: ReactNode;
  /** Keyboard hint shown at the end, e.g. "⌘K". */
  shortcut?: string;
  destructive?: boolean;
  disabled?: boolean;
  onSelect?: (event: Event) => void;
  children: ReactNode;
}

export const DropdownMenuItem = forwardRef<HTMLDivElement, DropdownMenuItemProps>(
  function DropdownMenuItem({ icon, shortcut, destructive, disabled, onSelect, children }, ref) {
    return (
      <MenuPrimitive.Item
        ref={ref}
        disabled={disabled}
        onSelect={onSelect}
        className={cn(
          'flex min-h-10 cursor-pointer items-center gap-3 rounded-md px-3 text-body-sm outline-none select-none [&_svg]:size-4',
          destructive
            ? 'text-danger-ink data-[highlighted]:bg-danger-soft'
            : 'text-ink data-[highlighted]:bg-brand-soft data-[highlighted]:text-brand-ink',
          'data-[disabled]:pointer-events-none data-[disabled]:text-ink-subtle',
        )}
      >
        {icon ? (
          <span className="flex text-ink-secondary" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <span className="flex-1">{children}</span>
        {shortcut ? <span className="text-caption text-ink-secondary">{shortcut}</span> : null}
      </MenuPrimitive.Item>
    );
  },
);

export function DropdownMenuLabel({ children }: { children: ReactNode }) {
  return (
    <MenuPrimitive.Label className="px-3 pt-2 pb-1 text-caption text-ink-secondary">
      {children}
    </MenuPrimitive.Label>
  );
}

export function DropdownMenuSeparator() {
  return <MenuPrimitive.Separator className="-mx-1.5 my-1.5 h-px bg-line" />;
}

export interface DropdownMenuRadioGroupProps {
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible name for the group, e.g. "Display currency". */
  label?: string;
  children: ReactNode;
}

/** A single-choice group inside a menu (e.g. a preference). */
export function DropdownMenuRadioGroup({
  value,
  onValueChange,
  label,
  children,
}: DropdownMenuRadioGroupProps) {
  return (
    <MenuPrimitive.RadioGroup value={value} onValueChange={onValueChange} aria-label={label}>
      {children}
    </MenuPrimitive.RadioGroup>
  );
}

export interface DropdownMenuRadioItemProps {
  value: string;
  /** Secondary text at the end, e.g. a currency symbol. */
  hint?: ReactNode;
  children: ReactNode;
}

/** Exposed as role="menuitemradio" with aria-checked. */
export function DropdownMenuRadioItem({ value, hint, children }: DropdownMenuRadioItemProps) {
  return (
    <MenuPrimitive.RadioItem
      value={value}
      className={cn(
        'flex min-h-10 cursor-pointer items-center gap-3 rounded-md px-3 text-body-sm text-ink outline-none select-none',
        'data-[highlighted]:bg-brand-soft data-[highlighted]:text-brand-ink data-[state=checked]:font-semibold',
      )}
    >
      <span className="grid size-4 place-items-center">
        <MenuPrimitive.ItemIndicator>
          <Check className="size-4 text-brand" aria-hidden="true" />
        </MenuPrimitive.ItemIndicator>
      </span>
      <span className="flex-1">{children}</span>
      {hint ? <span className="text-caption text-ink-secondary">{hint}</span> : null}
    </MenuPrimitive.RadioItem>
  );
}
