import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import { Container, Wordmark, cn } from '@wayora/ui';
import { AccountAction, HeaderCta } from '../../features/navigation/AccountAction';
import { type HeaderTone } from '../../features/navigation/config';
import { CurrencySelector } from '../../features/navigation/CurrencySelector';
import { DesktopNavigation } from '../../features/navigation/DesktopNavigation';
import { DestinationSearch } from '../../features/navigation/DestinationSearch';
import { MobileNavigationDrawer } from '../../features/navigation/MobileNavigationDrawer';
import { useScrolledPast } from '../../hooks/useScrolledPast';

/** Navigation colours while the header floats over a dark hero (see NavigationMenu). */
const inverseNavVars = {
  '--nav-fg': 'rgb(255 255 255 / 0.8)',
  '--nav-fg-active': '#ffffff',
  '--nav-hover-bg': 'rgb(255 255 255 / 0.12)',
  '--nav-hover-fg': '#ffffff',
  '--nav-indicator': '#ffffff',
} as CSSProperties;

export interface SiteHeaderProps {
  /**
   * The page starts with a full-bleed dark hero that slides under the header.
   * At the top of the page the header is transparent with white controls;
   * once scrolled it becomes the standard solid surface.
   */
  overlay?: boolean;
}

/**
 * Sticky site header. Height never changes, so content doesn't jump.
 *
 * lg+: brand | primary navigation + mega menu | search, currency, account, CTA (xl)
 * Account and CTA follow the session state (see AccountAction).
 * <lg: brand | search, menu (drawer)
 */
export function SiteHeader({ overlay = false }: SiteHeaderProps) {
  const { sentinelRef, scrolled } = useScrolledPast();
  const tone: HeaderTone = overlay && !scrolled ? 'inverse' : 'default';
  const inverse = tone === 'inverse';

  return (
    <>
      <div
        ref={sentinelRef}
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-x-0 top-0',
          // Over a hero, stay transparent a little longer before turning solid.
          overlay ? 'h-20' : 'h-2',
        )}
      />
      <header
        data-scrolled={scrolled || undefined}
        data-tone={tone}
        style={inverse ? inverseNavVars : undefined}
        className={cn(
          'sticky top-0 z-(--z-sticky) border-b transition-[background-color,border-color,box-shadow] duration-(--duration-base) ease-standard',
          inverse && 'focus-ring-inverse border-transparent bg-transparent',
          !inverse &&
            (scrolled
              ? 'border-line bg-page/95 shadow-xs backdrop-blur-sm'
              : 'border-transparent bg-page'),
        )}
      >
        <Container size="wide" className="flex h-(--header-h) items-center gap-3 lg:gap-6">
          <Link to="/" className="shrink-0 rounded-md" aria-label="Wayora, home">
            <Wordmark surface={inverse ? 'dark' : 'light'} />
          </Link>

          <DesktopNavigation className="hidden flex-1 justify-center lg:flex" />

          <div className="ml-auto flex items-center gap-1 lg:ml-0 lg:gap-1.5">
            <DestinationSearch tone={tone} />
            {/* Visibility lives on wrappers so it never fights a component's own display. */}
            <div className="hidden items-center gap-1.5 lg:flex">
              <CurrencySelector tone={tone} />
              <AccountAction tone={tone} />
            </div>
            <div className="ml-1.5 hidden xl:block">
              <HeaderCta tone={tone} />
            </div>
            <div className="lg:hidden">
              <MobileNavigationDrawer tone={tone} />
            </div>
          </div>
        </Container>
      </header>
    </>
  );
}
