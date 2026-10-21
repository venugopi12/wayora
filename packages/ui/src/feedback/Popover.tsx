import { Popover as PopoverPrimitive } from 'radix-ui';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { cn } from '../lib/cn';
import { overlayMotion } from '../motion/presets';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export interface PopoverContentProps {
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  sideOffset?: number;
  /** Accessible name when the content has no visible heading. */
  'aria-label'?: string;
  /** Override where focus goes on open (e.g. into a search input). */
  onOpenAutoFocus?: ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>['onOpenAutoFocus'];
  className?: string;
  children: ReactNode;
}

/**
 * Non-modal floating panel anchored to a trigger. Escape and outside click
 * close it and focus returns to the trigger. Stays within the viewport
 * (collision padding) and never exceeds the available height.
 */
export function PopoverContent({
  align = 'center',
  side = 'bottom',
  sideOffset = 8,
  className,
  children,
  ...rest
}: PopoverContentProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={12}
        className={cn(
          'z-(--z-dropdown) max-h-(--radix-popover-content-available-height) w-[min(26rem,calc(100vw-1.5rem))] overflow-y-auto',
          'rounded-xl border border-line bg-card shadow-lg outline-none',
          'origin-(--radix-popover-content-transform-origin)',
          overlayMotion.dropdown,
          className,
        )}
        {...rest}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}
