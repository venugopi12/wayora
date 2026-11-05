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
/** Checkout, confirmation, My trips, booking details (Phase 12) and demo payments (Phase 13). */
const bookings = () => import('../features/bookings/routes');
/** Trip planner (Phase 18): plan list, new plan and plan pages share one chunk. */
const planner = () => import('../features/planner/routes');
/** Travel assistant (Phase 21): its own chunk. */
const assistant = () => import('../features/assistant/routes');
/** Notifications page (Phase 14). */
const notifications = () => import('../features/notifications/routes');
const rewards = () => import('../features/rewards/routes');
/** Admin dashboard (Phase 15): its layout and pages are one chunk, never loaded by customers. */
const admin = () => import('../features/admin/routes');
const adminLayout = () => import('../features/admin/AdminLayout');
const adminRewards = () => import('../features/admin/RewardsAdmin');

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
 * page driven by the search API (features/search). Offers and demo bookings
 * (Phases 10 and 12) have their own routes below.
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
 *   ├─ RequireAuth → AdminLayout   staff only (role from the server; docs/admin.md)
 *   │  └─ /admin, /admin/users[/:id], /admin/bookings[/:reference],
 *   │     /admin/payments[/:id], /admin/search, /admin/notifications,
 *   │     /admin/audit, /admin/health
 *   └─ MarketingLayout         header + <main> + footer for the public site
 *      └─ (pages)              errorElement here, so errors keep header and footer
 *         ├─ / , /status, /discover, /discover/:slug, /about, /help,
 *         │  /legal/privacy, /legal/terms, /flights … /holidays (demo search),
 *         │  /offers/:serviceType/:resultId (offer details), dev /design-system
 *         ├─ /sign-in          redirects to /login
 *         ├─ RequireAuth       loader until /auth/session answers; else /login?redirect=
 *         │  └─ /profile, /profile/travellers, /book/:serviceType/:resultId (demo
 *         │     checkout), /trips, /trips/:reference, /trips/:reference/confirmation,
 *         │     /trips/:reference/pay, /trips/:reference/payments/:paymentId (demo payments),
 *         │     /notifications, /plans, /plans/new, /plans/:tripId (trip planner),
 *         │     /plans/:tripId/budget (budget and expenses),
 *         │     /assistant, /assistant/:conversationId (travel assistant),
 *         │     /plans/invitations/:invitationId (plan invitations)
 *         └─ *                 not-found page
 *
 * Focused layouts (auth, admin) are siblings of MarketingLayout under
 * RootLayout (docs/layouts.md).
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
                    {
                      path: ACCOUNT_PATHS.notifications.slice(1),
                      lazy: async () => ({ Component: (await notifications()).NotificationsRoute }),
                    },
                    {
                      path: ACCOUNT_PATHS.rewards.slice(1),
                      lazy: async () => ({ Component: (await rewards()).RewardsRoute }),
                    },
                    {
                      path: ACCOUNT_PATHS.plans.slice(1),
                      lazy: async () => ({ Component: (await planner()).PlansRoute }),
                    },
                    {
                      path: `${ACCOUNT_PATHS.plans.slice(1)}/new`,
                      lazy: async () => ({ Component: (await planner()).NewPlanRoute }),
                    },
                    {
                      path: `${ACCOUNT_PATHS.plans.slice(1)}/invitations/:invitationId`,
                      lazy: async () => ({ Component: (await planner()).InvitationRoute }),
                    },
                    {
                      path: `${ACCOUNT_PATHS.plans.slice(1)}/:tripId`,
                      lazy: async () => ({ Component: (await planner()).PlanDetailRoute }),
                    },
                    {
                      path: `${ACCOUNT_PATHS.plans.slice(1)}/:tripId/budget`,
                      lazy: async () => ({ Component: (await planner()).BudgetRoute }),
                    },
                    {
                      path: ACCOUNT_PATHS.assistant.slice(1),
                      lazy: async () => ({ Component: (await assistant()).AssistantRoute }),
                    },
                    {
                      path: `${ACCOUNT_PATHS.assistant.slice(1)}/:conversationId`,
                      lazy: async () => ({ Component: (await assistant()).AssistantRoute }),
                    },
                    {
                      path: 'book/:serviceType/:resultId',
                      lazy: async () => ({ Component: (await bookings()).CheckoutRoute }),
                    },
                    {
                      path: ACCOUNT_PATHS.trips.slice(1),
                      lazy: async () => ({ Component: (await bookings()).TripsRoute }),
                    },
                    {
                      path: `${ACCOUNT_PATHS.trips.slice(1)}/:reference`,
                      lazy: async () => ({ Component: (await bookings()).TripDetailRoute }),
                    },
                    {
                      path: `${ACCOUNT_PATHS.trips.slice(1)}/:reference/confirmation`,
                      lazy: async () => ({ Component: (await bookings()).ConfirmationRoute }),
                    },
                    {
                      path: `${ACCOUNT_PATHS.trips.slice(1)}/:reference/pay`,
                      lazy: async () => ({ Component: (await bookings()).PayRoute }),
                    },
                    {
                      path: `${ACCOUNT_PATHS.trips.slice(1)}/:reference/payments/:paymentId`,
                      lazy: async () => ({ Component: (await bookings()).PaymentStatusRoute }),
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
        // Admin (Phase 15): a focused sibling layout, staff only.
        {
          element: <RequireAuth />,
          children: [
            {
              path: 'admin',
              errorElement: <RouteErrorBoundary />,
              lazy: async () => ({ Component: (await adminLayout()).AdminLayout }),
              children: [
                { index: true, lazy: async () => ({ Component: (await admin()).OverviewRoute }) },
                { path: 'users', lazy: async () => ({ Component: (await admin()).UsersRoute }) },
                {
                  path: 'users/:userId',
                  lazy: async () => ({ Component: (await admin()).UserDetailRoute }),
                },
                {
                  path: 'bookings',
                  lazy: async () => ({ Component: (await admin()).BookingsRoute }),
                },
                {
                  path: 'bookings/:reference',
                  lazy: async () => ({ Component: (await admin()).BookingDetailRoute }),
                },
                {
                  path: 'payments',
                  lazy: async () => ({ Component: (await admin()).PaymentsRoute }),
                },
                {
                  path: 'payments/:paymentId',
                  lazy: async () => ({ Component: (await admin()).PaymentDetailRoute }),
                },
                {
                  path: 'search',
                  lazy: async () => ({ Component: (await admin()).SearchActivityRoute }),
                },
                {
                  path: 'notifications',
                  lazy: async () => ({ Component: (await admin()).NotificationHealthRoute }),
                },
                {
                  path: 'rewards',
                  lazy: async () => ({ Component: (await adminRewards()).RewardsRoute }),
                },
                {
                  path: 'rewards/rules',
                  lazy: async () => ({ Component: (await adminRewards()).RewardRulesRoute }),
                },
                {
                  path: 'rewards/users/:userId',
                  lazy: async () => ({ Component: (await adminRewards()).UserRewardsRoute }),
                },
                { path: 'audit', lazy: async () => ({ Component: (await admin()).AuditLogRoute }) },
                { path: 'health', lazy: async () => ({ Component: (await admin()).HealthRoute }) },
                {
                  path: '*',
                  lazy: async () => ({ Component: (await admin()).AdminNotFoundRoute }),
                },
              ],
            },
          ],
        },
      ],
    },
  ];
}
