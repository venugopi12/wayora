import { Tabs as TabsPrimitive } from 'radix-ui';
import { forwardRef, type ReactNode } from 'react';
import { cn } from '../lib/cn';

/**
 * Accessible tabs (WAI-ARIA tabs pattern via Radix): role=tablist/tab/tabpanel,
 * aria-selected and aria-controls wired, Left/Right/Home/End move between tabs
 * and select them (activationMode "automatic").
 */
export const Tabs = TabsPrimitive.Root;

export interface TabsListProps {
  /** Accessible name for the tablist. */
  label: string;
  className?: string;
  children: ReactNode;
}

/**
 * Horizontally scrollable on narrow screens (no page overflow); the list
 * never wraps so each tab keeps a stable 44px+ touch target.
 */
export function TabsList({ label, className, children }: TabsListProps) {
  return (
    <TabsPrimitive.List
      aria-label={label}
      className={cn(
        'flex max-w-full snap-x gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      {children}
    </TabsPrimitive.List>
  );
}

export interface TabsTriggerProps {
  value: string;
  icon?: ReactNode;
  /** Small trailing marker, e.g. a "Soon" badge. */
  meta?: ReactNode;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

/** A tab. Selected state uses a raised white chip on a sunken track. */
export const TabsTrigger = forwardRef<HTMLButtonElement, TabsTriggerProps>(function TabsTrigger(
  { value, icon, meta, disabled, className, children },
  ref,
) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      value={value}
      disabled={disabled}
      className={cn(
        'group/tab relative flex min-h-11 shrink-0 snap-start items-center gap-2 rounded-md px-3.5 text-body-sm font-semibold whitespace-nowrap',
        'text-ink-secondary transition-[background-color,color,box-shadow] duration-(--duration-fast) ease-standard',
        'hover:bg-card/70 hover:text-ink',
        'data-[state=active]:bg-card data-[state=active]:text-ink data-[state=active]:shadow-sm',
        'disabled:pointer-events-none disabled:text-ink-subtle',
        '[&_svg]:size-[18px] [&_svg]:shrink-0',
        className,
      )}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className="flex text-ink-secondary transition-colors duration-(--duration-fast) group-data-[state=active]/tab:text-brand"
        >
          {icon}
        </span>
      ) : null}
      {children}
      {meta}
    </TabsPrimitive.Trigger>
  );
});

export interface TabsContentProps {
  value: string;
  className?: string;
  children: ReactNode;
}

export function TabsContent({ value, className, children }: TabsContentProps) {
  return (
    <TabsPrimitive.Content value={value} className={cn('outline-none', className)}>
      {children}
    </TabsPrimitive.Content>
  );
}
