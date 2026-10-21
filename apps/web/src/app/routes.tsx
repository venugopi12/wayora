import { Navigate, useLocation, type RouteObject } from 'react-router';
import { PageLoader } from '../components/feedback/PageLoader';
import { AuthLayout } from '../components/layout/AuthLayout';
import { MarketingLayout } from '../components/layout/MarketingLayout';
import type { RouteHandle } from '../components/layout/route-handle';
import { RootLayout } from '../components/layout/RootLayout';
import { findDestination } from '../features/discover/search';
import { RedirectIfSignedIn, RequireAuth } from '../features/auth/guards';
import {
  ACCOUNT_PATHS,
  DISCOVER,
  INFO_PATHS,
  LEGACY_SIGN_IN_PATH,
  SERVICE_NAV,
} from '../features/navigation/config';
import { HomeRoute } from '../routes/HomeRoute';
import { NotFoundRoute } from '../routes/NotFoundRoute';
import { RouteErrorBoundary } from '../routes/RouteErrorBoundary';

/**
 * Development-only routes.
 *
 * `import.meta.env.DEV` is replaced with `false` in production builds, so this
 * constant and its dynamic import are removed from the bundle entirely — the
 * showcase code is never shipped. `npm run build` verifies this
 * (apps/web/scripts/assert-no-dev-routes.mjs).
 */
const devRoutes: RouteObject[] = import.meta.env.DEV
  ? [
      {
        path: 'design-system',
        lazy: async () => {
          const { DesignSystemRoute } = await import('../features/design-system/DesignSystemRoute');
          return { Component: DesignSystemRoute };
        },
      },
    ]
  : [];

export interface CreateRoutesOptions {
  /** Include development-only routes. Defaults to `import.meta.env.DEV`. */
  includeDevRoutes?: boolean;
}

/**
 * Code splitting: the homepage, not-found page and error boundary are in the
 * main bundle; every other page is a separate chunk loaded on first visit
 * (React Router `lazy`), so the homepage doesn't pay for pages it never shows.
 * All seven service search pages share one chunk, as do the info and legal pages.
 */
/** All seven service search pages share one chunk (Phase 9). */
const search = () => import('../features/search/routes');
/** Offer pages (Phase 10). */
const offers = () => import('../features/offers/routes');
/** Sign-in and registration share one chunk; profile and travellers another. */
const auth = () => import('../features/auth/routes');
const account = () => import('../features/account/routes');

/** /sign-in (the pre-Phase 8 link) → /login, keeping any query string. */
function LegacySignInRedirect() {
  const { search } = useLocation();
  return <Navigate to={`${ACCOUNT_PATHS.login}${search}`} replace />;
}
const info = () => import('../features/info/routes');
const crumb = (label: RouteHandle['crumb']) => ({ crumb: label }) satisfies RouteHandle;
/** Discover and destination pages share one chunk. */
const discover = () => import('../features/discover/routes');

/**
 * Every service in the navigation has a route: since Phase 9, a demo search
 * page driven by the search API (features/search). Booking flows in later
 * phases add their own nested routes, e.g. `flights/offer/:id`.
 */
const serviceRoutes: RouteObject[] = SERVICE_NAV.map((service) => ({
  path: service.path.slice(1),
  lazy: async () => {
    const { ServiceSearchRoute } = await search();
    return { Component: () => <ServiceSearchRoute slug={service.slug} /> };
  },
}));

/**
 * Route table.
 *
 *   RootLayout                 scroll restoration, route announcer (all layouts)
 *   ├─ AuthLayout              focused split-screen layout, no site nav/footer
 *   │  └─ RedirectIfSignedIn   signed-in visitors continue to ?redirect=
 *   │     └─ /login, /register
 *   └─ MarketingLayout         header + <main> + footer for the public site
 *      └─ (pages)              errorElement here, so errors keep header and footer
 *         ├─ / , /status, /discover, /discover/:slug, /about, /help,
 *         │  /legal/privacy, /legal/terms, /flights … /holidays (demo search),
 *         │  /offers/:serviceType/:resultId (offer details), dev /design-system
 *         ├─ /sign-in          redirects to /login
 *         ├─ RequireAuth       loader until /auth/session answers; else /login?redirect=
 *         │  └─ /profile, /profile/travellers
 *         └─ *                 not-found page
 *
 * Future focused layouts (checkout, admin) become siblings of MarketingLayout
 * under RootLayout, like AuthLayout (docs/layouts.md).
 * `handle.crumb` feeds breadcrumbs; `handle.headerOverlay` floats the header.
 */
export function createRoutes({
  includeDevRoutes = import.meta.env.DEV,
}: CreateRoutesOptions = {}): RouteObject[] {
  return [
    {
      element: <RootLayout />,
      // Last resort if a layout itself fails: no chrome, just the message.
      errorElement: <RouteErrorBoundary />,
      hydrateFallbackElement: (
        <MarketingLayout footer={false}>
          <PageLoader />
        </MarketingLayout>
      ),
      children: [
        {
          element: <AuthLayout />,
          children: [
            {
              errorElement: <RouteErrorBoundary />,
              element: <RedirectIfSignedIn />,
              children: [
                {
                  path: ACCOUNT_PATHS.login.slice(1),
                  lazy: async () => ({ Component: (await auth()).LoginRoute }),
                },
                {
                  path: ACCOUNT_PATHS.register.slice(1),
                  lazy: async () => ({ Component: (await auth()).RegisterRoute }),
                },
              ],
            },
          ],
        },
        {
          element: <MarketingLayout />,
          children: [
            {
              // Page errors (render failures, failed chunk loads) render inside
              // the layout, so the header and footer stay usable.
              errorElement: <RouteErrorBoundary />,
              children: [
                {
                  index: true,
                  element: <HomeRoute />,
                  handle: { headerOverlay: true } satisfies RouteHandle,
                },
                {
                  path: INFO_PATHS.status.slice(1),
                  lazy: async () => ({
                    Component: (await import('../routes/StatusRoute')).StatusRoute,
                  }),
                },
                {
                  path: DISCOVER.path.slice(1),
                  handle: crumb(DISCOVER.name),
                  children: [
                    {
                      index: true,
                      lazy: async () => ({ Component: (await discover()).DiscoverRoute }),
                    },
                    {
                      path: ':slug',
                      handle: crumb((params) => findDestination(params.slug)?.name),
                      lazy: async () => ({ Component: (await discover()).DestinationRoute }),
                    },
                  ],
                },
                {
                  path: LEGACY_SIGN_IN_PATH.slice(1),
                  element: <LegacySignInRedirect />,
                },
                {
                  element: <RequireAuth />,
                  children: [
                    {
                      path: ACCOUNT_PATHS.profile.slice(1),
                      lazy: async () => ({ Component: (await account()).ProfileRoute }),
                    },
                    {
                      path: ACCOUNT_PATHS.travellers.slice(1),
                      lazy: async () => ({ Component: (await account()).TravellersRoute }),
                    },
                  ],
                },
                {
                  path: INFO_PATHS.about.slice(1),
                  handle: crumb('About Wayora'),
                  lazy: async () => ({ Component: (await info()).AboutRoute }),
                },
                {
                  path: INFO_PATHS.help.slice(1),
                  handle: crumb('Help and support'),
                  lazy: async () => ({ Component: (await info()).HelpRoute }),
                },
                {
                  path: INFO_PATHS.privacy.slice(1),
                  handle: crumb('Privacy policy'),
                  lazy: async () => ({ Component: (await info()).PrivacyRoute }),
                },
                {
                  path: INFO_PATHS.terms.slice(1),
                  handle: crumb('Terms and conditions'),
                  lazy: async () => ({ Component: (await info()).TermsRoute }),
                },
                ...serviceRoutes,
                {
                  path: 'offers/:serviceType/:resultId',
                  lazy: async () => ({ Component: (await offers()).OfferDetailRoute }),
                },
                ...(includeDevRoutes ? devRoutes : []),
                { path: '*', element: <NotFoundRoute /> },
              ],
            },
          ],
        },
      ],
    },
  ];
}
