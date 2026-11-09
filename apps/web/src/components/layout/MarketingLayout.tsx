import type { ReactNode } from 'react';
import { Outlet, useMatches } from 'react-router';
import { SkipLink } from '@wayora/ui';
import { wantsHeaderOverlay } from './route-handle';
import { SiteFooter } from './SiteFooter';
import { SiteHeader } from './SiteHeader';
import { MobileTabBar, TabBarSpacer } from '../../features/navigation/MobileTabBar';
import { ConnectivityBanner, UpdatePrompt } from '../../pwa/PwaNotices';

/**
 * Public-site layout: skip link, the one SiteHeader, the single `<main>`
 * landmark and the one SiteFooter. Every public page (home, Discover,
 * destination pages, service and info pages, not-found) renders inside it, so
 * pages never render their own header or footer.
 *
 * `children` replaces the routed page. The router uses that for its hydration
 * fallback (`<MarketingLayout footer={false}><PageLoader /></MarketingLayout>`),
 * so when someone opens a lazily loaded page directly, the header renders at
 * once and only the page body waits for its chunk. The footer is left out
 * until the page arrives: if it were shown under the loader, it would jump when
 * the page replaced the loader (layout shift).
 */
export function MarketingLayout({
  children,
  footer = true,
}: {
  children?: ReactNode;
  footer?: boolean;
}) {
  const overlay = wantsHeaderOverlay(useMatches());
  return (
    <div className="relative flex min-h-dvh flex-col bg-page">
      <SkipLink />
      <SiteHeader overlay={overlay} />
      <ConnectivityBanner />
      <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">
        {children ?? <Outlet />}
      </main>
      {footer ? <SiteFooter /> : null}
      <TabBarSpacer className={footer ? 'bg-deep' : undefined} />
      <MobileTabBar />
      <UpdatePrompt />
    </div>
  );
}
