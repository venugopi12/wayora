import { Tooltip as TooltipPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { overlayMotion } from '../motion/presets';

/** Mount once near the app root. Controls hover delay for every tooltip. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={300} skipDelayDuration={150}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export interface TooltipProps {
  /** Short supplementary text. Never put essential information only in a tooltip. */
  content: ReactNode;
  /** A single focusable element (Button, IconButton, link). */
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

/**
 * Hover/focus hint for an interactive element. Opens on keyboard focus,
 * closes on Escape; content is linked via aria-describedby.
 */
export function Tooltip({ content, children, side = 'top' }: TooltipProps) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={8}
          collisionPadding={12}
          className={cn(
            'z-(--z-tooltip) max-w-64 rounded-sm bg-deep px-3 py-2 text-body-sm text-ink-inverse shadow-md',
            overlayMotion.tooltip,
          )}
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-deep" width={10} height={5} />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
