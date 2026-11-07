import { useEffect, useRef, useState } from 'react';
import { Outlet, ScrollRestoration, useLocation } from 'react-router';
import { SeoProvider } from '../../features/seo/SeoProvider';

/**
 * Root of the route tree: application-wide behaviour that every layout shares.
 * App-wide providers (React Query, Motion, toasts, tooltips, currency) wrap the
 * router in app/App.tsx; page chrome (header, footer) belongs to the layout
 * routes below this one, so a future focused layout (checkout, account, admin)
 * can opt out of it.
 *
 * - Restores scroll position on Back/Forward, scrolls to `#hash` targets and to
 *   the top on new pages (React Router `ScrollRestoration`).
 * - Applies each page's metadata (title, description, canonical, robots,
 *   social cards, structured data; features/seo, docs/seo.md).
 * - Announces each client-side page change to screen readers using the new
 *   document title, which a full page load would otherwise announce.
 */
export function RootLayout() {
  return (
    <SeoProvider>
      <Outlet />
      <RouteAnnouncer />
      <ScrollRestoration />
    </SeoProvider>
  );
}

/** Polite live region that reads the page title after client-side navigation. */
export function RouteAnnouncer() {
  const { pathname } = useLocation();
  const [message, setMessage] = useState('');
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // Pages set document.title in their own effects, which run before this
    // parent effect; a frame later the title is settled.
    const id = requestAnimationFrame(() => setMessage(document.title));
    return () => cancelAnimationFrame(id);
  }, [pathname]);

  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only" data-route-announcer>
      {message}
    </div>
  );
}
