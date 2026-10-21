import { ChevronDown } from 'lucide-react';
import { NavigationMenu as NM } from 'radix-ui';
import { createContext, forwardRef, useContext, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { overlayMotion } from '../motion/presets';

/**
 * Site navigation with optional dropdown panels (mega menus), built on Radix
 * NavigationMenu. Gives you, without extra code:
 * - open on click, and on hover after a short delay (no flicker moving
 *   between trigger and panel, thanks to Radix's pointer grace handling);
 * - Escape closes and returns focus to the trigger; outside click closes;
 * - selecting a NavigationMenuLink inside a panel closes it;
 * - arrow-key movement between top-level items; aria-expanded/aria-controls.
 *
 * The panel renders into one shared viewport centred under the list, so it
 * animates between sizes and never escapes the header's horizontal bounds.
 *
 * Theming: top-level items read optional CSS variables, so a container can
 * restyle them without overriding classes (e.g. a header over a dark hero):
 *   --nav-fg, --nav-fg-active, --nav-hover-bg, --nav-hover-fg, --nav-indicator
 * Each falls back to the default light-surface token.
 */
export interface NavigationMenuProps {
  /** Accessible name for the <nav> landmark. */
  label: string;
  className?: string;
  /** Extra classes for the floating panel (e.g. width). */
  viewportClassName?: string;
  children: ReactNode;
}

type Interaction = 'pointer' | 'keyboard' | null;
const InteractionContext = createContext<(kind: Interaction) => void>(() => {});

export function NavigationMenu({
  label,
  className,
  viewportClassName,
  children,
}: NavigationMenuProps) {
  const [value, setValue] = useState('');
  // Radix toggles a panel on trigger click. If the panel was just opened by
  // hover, that click would close it again (flicker). Remember how the panel
  // was opened and treat a click on a hover-opened panel as "keep it open".
  const interaction = useRef<Interaction>(null);
  const openedBy = useRef<'hover' | 'explicit'>('explicit');

  const onValueChange = (next: string) => {
    const kind = interaction.current;
    interaction.current = null;
    if (next) {
      openedBy.current = kind ? 'explicit' : 'hover';
    } else if (kind === 'pointer' && openedBy.current === 'hover') {
      openedBy.current = 'explicit';
      return;
    }
    setValue(next);
  };

  return (
    <InteractionContext.Provider value={(kind) => (interaction.current = kind)}>
      <NM.Root
        aria-label={label}
        value={value}
        onValueChange={onValueChange}
        delayDuration={120}
        skipDelayDuration={400}
        className={cn('relative', className)}
      >
        <NM.List className="flex items-center gap-0.5">{children}</NM.List>
        <div className="absolute top-full left-1/2 z-(--z-dropdown) -translate-x-1/2 pt-3">
          <NM.Viewport
            className={cn(
              'relative origin-top overflow-hidden rounded-xl border border-line bg-card shadow-lg',
              'h-(--radix-navigation-menu-viewport-height) w-(--radix-navigation-menu-viewport-width)',
              'transition-[width,height] duration-(--duration-base) ease-emphasized',
              overlayMotion.panel,
              viewportClassName,
            )}
          />
        </div>
      </NM.Root>
    </InteractionContext.Provider>
  );
}

export const NavigationMenuItem = NM.Item;

const topLevel =
  'relative flex min-h-10 items-center gap-1.5 rounded-md px-3.5 text-body-sm font-semibold whitespace-nowrap ' +
  'text-[var(--nav-fg,var(--color-ink-secondary))] ' +
  'transition-colors duration-(--duration-fast) ease-standard ' +
  'hover:bg-[var(--nav-hover-bg,var(--color-brand-soft))] hover:text-[var(--nav-hover-fg,var(--color-brand-ink))] ' +
  // Active-page indicator: a short bar that grows from the centre.
  'after:pointer-events-none after:absolute after:inset-x-3.5 after:-bottom-[9px] after:h-0.5 after:origin-center after:scale-x-0 after:rounded-full ' +
  'after:bg-[var(--nav-indicator,var(--color-brand))] ' +
  'after:transition-transform after:duration-(--duration-base) after:ease-emphasized';

export interface NavigationMenuLinkProps {
  /** Marks the current page: sets aria-current="page" and the indicator. */
  active?: boolean;
  /** Pass a router Link (or <a>) as the single child. */
  children: ReactNode;
  /** `top` styles a top-level header link; `plain` leaves styling to you (panel content). */
  variant?: 'top' | 'plain';
  className?: string;
  onSelect?: (event: Event) => void;
}

/** A link in the bar or inside a panel. Selecting it closes any open panel. */
export const NavigationMenuLink = forwardRef<HTMLAnchorElement, NavigationMenuLinkProps>(
  function NavigationMenuLink({ active, children, variant = 'plain', className, onSelect }, ref) {
    return (
      <NM.Link
        ref={ref}
        asChild
        active={active}
        onSelect={onSelect}
        className={cn(
          variant === 'top' && topLevel,
          variant === 'top' &&
            'data-[active]:text-[var(--nav-fg-active,var(--color-ink))] data-[active]:after:scale-x-100',
          className,
        )}
      >
        {children}
      </NM.Link>
    );
  },
);

export interface NavigationMenuTriggerProps {
  children: ReactNode;
  /** Highlights the trigger when the current page lives inside its panel. */
  sectionActive?: boolean;
  className?: string;
}

/** Opens a panel. The chevron turns when open. */
export const NavigationMenuTrigger = forwardRef<HTMLButtonElement, NavigationMenuTriggerProps>(
  function NavigationMenuTrigger({ children, sectionActive, className }, ref) {
    const report = useContext(InteractionContext);
    return (
      <NM.Trigger
        ref={ref}
        onPointerDown={() => report('pointer')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') report('keyboard');
        }}
        data-section-active={sectionActive || undefined}
        className={cn(
          topLevel,
          'group data-[state=open]:bg-[var(--nav-hover-bg,var(--color-brand-soft))] data-[state=open]:text-[var(--nav-hover-fg,var(--color-brand-ink))]',
          'data-[section-active]:text-[var(--nav-fg-active,var(--color-ink))] data-[section-active]:after:scale-x-100',
          className,
        )}
      >
        {children}
        <ChevronDown
          aria-hidden="true"
          className="size-4 transition-transform duration-(--duration-base) ease-emphasized group-data-[state=open]:rotate-180"
        />
      </NM.Trigger>
    );
  },
);

/** Panel content for a trigger. Rendered inside the shared viewport. */
export function NavigationMenuContent({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <NM.Content
      className={cn(
        'top-0 left-0 w-max max-w-[calc(100vw-2rem)]',
        'data-[motion^=from-]:animate-fade-in data-[motion^=to-]:animate-fade-out',
        className,
      )}
    >
      {children}
    </NM.Content>
  );
}
