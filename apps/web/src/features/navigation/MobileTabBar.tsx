import { Compass, Gift, House, Luggage, Search, UserRound, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { Sheet, SheetContent, SheetTrigger, cn } from '@wayora/ui';
import { useAuth } from '../auth/AuthProvider';
import { loginPathFor } from '../auth/redirect';
import { ACCOUNT_PATHS, DISCOVER, SERVICE_NAV } from './config';

/*
 * Phone and small-tablet navigation bar (below `lg`), docs/pwa.md#navigation:
 * Home · Search · Trips · Rewards · Account (sign-in when signed out). Fixed to the bottom edge, above
 * the home indicator (safe-area inset); the layout reserves the same space
 * (`--tab-bar-h`) so it never covers the page. It steps aside while the
 * on-screen keyboard is likely open and on focused flows (checkout and
 * payment pages have their own actions there). The header keeps the menu,
 * destination search and notifications; this bar only adds one-tap access to
 * the places people return to.
 */

/** Paths where the bar would compete with the page's own primary action. */
export const FOCUSED_FLOW = [/^\/book\//, /^\/trips\/[^/]+\/pay$/, /^\/trips\/[^/]+\/payments\//];

export const showsTabBar = (pathname: string) => !FOCUSED_FLOW.some((r) => r.test(pathname));

type Tab = 'home' | 'search' | 'trips' | 'rewards' | 'account';

const SERVICE_PATHS = new Set(SERVICE_NAV.map((s) => s.path as string));

export function activeTab(pathname: string): Tab | null {
  if (pathname === '/') return 'home';
  if (SERVICE_PATHS.has(pathname) || pathname.startsWith('/offers/')) return 'search';
  if (pathname === ACCOUNT_PATHS.trips || pathname.startsWith(`${ACCOUNT_PATHS.trips}/`))
    return 'trips';
  if (pathname === ACCOUNT_PATHS.rewards) return 'rewards';
  if (
    [
      ACCOUNT_PATHS.profile,
      ACCOUNT_PATHS.notifications,
      ACCOUNT_PATHS.support,
      ACCOUNT_PATHS.reviews,
      ACCOUNT_PATHS.login,
      ACCOUNT_PATHS.register,
    ].some((p) => pathname === p || pathname.startsWith(`${p}/`))
  )
    return 'account';
  return null;
}

const EDITABLE =
  'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=range]), textarea, select, [contenteditable="true"]';

/**
 * Whether a text field has focus on a touch device, i.e. the on-screen
 * keyboard is probably up. A fixed bar would otherwise ride on top of it.
 */
export function useEditingOnTouch(): boolean {
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    if (!coarse) return;
    const update = () => {
      const el = document.activeElement;
      setEditing(el instanceof HTMLElement && el.matches(EDITABLE));
    };
    // Focus moving between fields fires focusout then focusin: check after both.
    const later = () => requestAnimationFrame(update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', later);
    return () => {
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', later);
    };
  }, []);
  return editing;
}

const tabClass =
  'flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[0.6875rem] font-semibold leading-tight text-ink-secondary transition-colors duration-(--duration-fast) hover:text-ink aria-[current=page]:text-brand-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset';

function TabIcon({ icon: Icon, active }: { icon: LucideIcon; active: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid h-7 w-12 place-items-center rounded-full transition-colors duration-(--duration-fast)',
        active && 'bg-brand-soft',
      )}
    >
      <Icon className="size-5" strokeWidth={active ? 2.25 : 1.75} />
    </span>
  );
}

function TabLink({
  to,
  icon,
  label,
  active,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  active: boolean;
}) {
  return (
    <li className="flex flex-1">
      <Link to={to} className={tabClass} aria-current={active ? 'page' : undefined}>
        <TabIcon icon={icon} active={active} />
        {label}
      </Link>
    </li>
  );
}

function SearchSheet({ active, children }: { active: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const close = () => setOpen(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          className={cn(tabClass, active && 'text-brand-ink')}
          // "Search" is also the label of search forms on some pages.
          aria-label="Search travel"
          aria-haspopup="dialog"
        >
          <TabIcon icon={Search} active={active} />
          Search
        </button>
      </SheetTrigger>
      <SheetContent side="bottom" title="Search travel" closeLabel="Close search">
        <nav aria-label="Travel services">
          <ul className="grid grid-cols-2 gap-2 min-[400px]:grid-cols-3">
            {SERVICE_NAV.map((s) => (
              <li key={s.slug}>
                <Link
                  to={s.path}
                  onClick={close}
                  aria-current={pathname === s.path ? 'page' : undefined}
                  className="flex min-h-16 items-center gap-3 rounded-xl border border-line bg-card px-3 py-2 text-label text-ink hover:border-brand-300 aria-[current=page]:border-brand aria-[current=page]:bg-brand-soft"
                >
                  <s.icon className="size-5 shrink-0 text-brand-ink" aria-hidden="true" />
                  {s.name}
                </Link>
              </li>
            ))}
            <li>
              <Link
                to={DISCOVER.path}
                onClick={close}
                className="flex min-h-16 items-center gap-3 rounded-xl border border-line bg-card px-3 py-2 text-label text-ink hover:border-brand-300"
              >
                <Compass className="size-5 shrink-0 text-brand-ink" aria-hidden="true" />
                Destinations
              </Link>
            </li>
          </ul>
        </nav>
        {children}
      </SheetContent>
    </Sheet>
  );
}

export function MobileTabBar() {
  const { pathname, search } = useLocation();
  const { status } = useAuth();
  const editing = useEditingOnTouch();
  if (!showsTabBar(pathname)) return null;
  const active = activeTab(pathname);
  const signedIn = status === 'authenticated';
  return (
    <nav
      aria-label="Quick links"
      data-hidden={editing || undefined}
      // Out of the way (and out of the tab order) while the keyboard is up.
      inert={editing}
      className={cn(
        'fixed inset-x-0 bottom-0 z-(--z-sticky) border-t border-line bg-page/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm lg:hidden',
        'pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]',
        'transition-transform duration-(--duration-base) ease-standard data-[hidden]:translate-y-full',
      )}
    >
      <ul className="mx-auto flex h-(--tab-bar-h) max-w-xl items-stretch px-1">
        <TabLink to="/" icon={House} label="Home" active={active === 'home'} />
        <li className="flex flex-1">
          <SearchSheet active={active === 'search'} />
        </li>
        <TabLink
          to={ACCOUNT_PATHS.trips}
          icon={Luggage}
          label="Trips"
          active={active === 'trips'}
        />
        <TabLink
          to={ACCOUNT_PATHS.rewards}
          icon={Gift}
          label="Rewards"
          active={active === 'rewards'}
        />
        {/* Signed out it leads to sign-in (and back here afterwards). */}
        <TabLink
          to={signedIn ? ACCOUNT_PATHS.profile : loginPathFor(`${pathname}${search}`)}
          icon={UserRound}
          label="Account"
          active={active === 'account'}
        />
      </ul>
    </nav>
  );
}

/**
 * Keeps the bottom of the page clear of the bar (and the home indicator),
 * below `lg` and only where the bar shows. Same colour as the footer above it.
 */
export function TabBarSpacer({ className }: { className?: string }) {
  if (!showsTabBar(useLocation().pathname)) return null;
  return (
    <div
      aria-hidden="true"
      className={cn('h-[calc(var(--tab-bar-h)+env(safe-area-inset-bottom))] lg:hidden', className)}
    />
  );
}
