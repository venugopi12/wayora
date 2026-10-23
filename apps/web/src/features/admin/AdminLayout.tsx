import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, LogOut, Menu, RotateCw, ShieldAlert } from 'lucide-react';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { isStaff, type AdminMe, type AdminPermission, hasPermission } from '@wayora/contracts';
import {
  Badge,
  Button,
  Container,
  EmptyState,
  ErrorState,
  Sheet,
  SheetContent,
  SheetTrigger,
  SkipLink,
  Wordmark,
  cn,
} from '@wayora/ui';
import { PageLoader } from '../../components/feedback/PageLoader';
import { ApiClientError } from '../../lib/api-client';
import { adminApi } from '../../services/admin';
import { useAuth } from '../auth/AuthProvider';
import { useSignOut } from '../auth/useSignOut';
import { adminKeys } from './keys';
import { ADMIN_NAV } from './nav';
import { ADMIN_PATHS } from './paths';

/*
 * The admin dashboard's frame (docs/admin.md#web): a focused layout, sibling
 * of the marketing layout, with its own navigation. What it shows is driven
 * by GET /admin/me, i.e. by the server: links a role can't use are hidden,
 * but hiding is only presentation — every admin endpoint checks the role
 * itself, and a page whose request is refused shows "no access".
 */

const AdminContext = createContext<AdminMe | null>(null);

export function useAdmin(): AdminMe {
  const value = useContext(AdminContext);
  if (!value) throw new Error('useAdmin outside AdminLayout');
  return value;
}

/** Whether the server granted this permission (presentation only; the API enforces it). */
export function useCan(permission: AdminPermission): boolean {
  const me = useAdmin();
  return hasPermission(me.role, permission) && me.permissions.includes(permission);
}

export const isForbidden = (error: unknown) =>
  error instanceof ApiClientError && error.code === 'FORBIDDEN';

export function AccessDenied({ inLayout = true }: { inLayout?: boolean }) {
  const body = (
    <div className="rounded-xl border border-dashed border-line-strong bg-card">
      <EmptyState
        size="page"
        titleAs="h1"
        icon={<ShieldAlert />}
        title="You don’t have access to this"
        description="This area is for Wayora staff with the right role. If you think you should have access, ask an administrator."
        action={
          <Button asChild variant="secondary">
            <Link to="/">
              <ArrowLeft aria-hidden="true" />
              Back to Wayora
            </Link>
          </Button>
        }
      />
    </div>
  );
  return inLayout ? (
    body
  ) : (
    <Container size="narrow" className="py-section-sm">
      {body}
    </Container>
  );
}

function Bare({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-page">
      <SkipLink />
      <header className="flex h-(--header-h) items-center px-gutter">
        <Link to="/" className="rounded-md" aria-label="Wayora, home">
          <Wordmark />
        </Link>
      </header>
      <main id="main" tabIndex={-1} className="focus:outline-none">
        {children}
      </main>
    </div>
  );
}

function NavLinks({ me, onNavigate }: { me: AdminMe; onNavigate?: () => void }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {ADMIN_NAV.filter((item) => me.permissions.includes(item.permission)).map(
        ({ to, label, icon: Icon, end }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              onClick={onNavigate}
              className={cn(
                'flex min-h-11 items-center gap-2.5 rounded-md px-3 text-body-sm text-ink-secondary',
                'hover:bg-brand-soft hover:text-brand-ink',
                'aria-[current=page]:bg-brand-soft aria-[current=page]:font-semibold aria-[current=page]:text-brand-ink',
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </NavLink>
          </li>
        ),
      )}
    </ul>
  );
}

const ROLE_LABEL = { admin: 'Administrator', support: 'Support', user: 'User' } as const;

export function AdminLayout() {
  const { user } = useAuth();
  const staff = user ? isStaff(user.role) : false;
  const me = useQuery({
    queryKey: adminKeys.me,
    queryFn: ({ signal }) => adminApi.me(signal),
    // Ordinary users never ask: the answer would be "no" (and audited as a denial).
    enabled: staff,
    staleTime: 60_000,
  });
  const { pending, signOut } = useSignOut();
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();

  if (!user || !staff) {
    return (
      <Bare>
        <AccessDenied inLayout={false} />
      </Bare>
    );
  }
  if (me.isPending) return <PageLoader />;
  if (me.isError) {
    return (
      <Bare>
        {isForbidden(me.error) ? (
          <AccessDenied inLayout={false} />
        ) : (
          <Container size="narrow" className="py-section-sm">
            <ErrorState
              title="We couldn’t open the admin dashboard"
              description="The server didn’t answer. Check your connection, then try again."
              reference={
                me.error instanceof ApiClientError ? (me.error.requestId ?? undefined) : undefined
              }
              action={
                <Button
                  variant="secondary"
                  onClick={() => void me.refetch()}
                  loading={me.isFetching}
                >
                  <RotateCw aria-hidden="true" />
                  Try again
                </Button>
              }
            />
          </Container>
        )}
      </Bare>
    );
  }

  const current = ADMIN_NAV.find((item) =>
    item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`),
  );

  return (
    <AdminContext.Provider value={me.data}>
      <div className="min-h-dvh bg-page">
        <SkipLink />
        <header className="sticky top-0 z-(--z-sticky) border-b border-line bg-page/95 backdrop-blur">
          <div className="flex h-(--header-h) items-center justify-between gap-3 px-gutter">
            <div className="flex min-w-0 items-center gap-3">
              <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
                <SheetTrigger asChild>
                  <Button variant="ghost" size="sm" className="lg:hidden" aria-label="Admin menu">
                    <Menu aria-hidden="true" />
                  </Button>
                </SheetTrigger>
                <SheetContent title="Admin" closeLabel="Close admin menu">
                  <nav aria-label="Admin sections">
                    <NavLinks me={me.data} onNavigate={() => setMenuOpen(false)} />
                  </nav>
                </SheetContent>
              </Sheet>
              <Link
                to={ADMIN_PATHS.overview}
                className="rounded-md"
                aria-label="Wayora admin, overview"
              >
                <Wordmark />
              </Link>
              <Badge tone="brand">Admin</Badge>
              {current ? (
                <span className="hidden truncate text-body-sm text-ink-secondary sm:inline lg:hidden">
                  {current.label}
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <span className="hidden text-right md:block">
                <span className="block max-w-48 truncate text-label">{user.name}</span>
                <span className="block text-caption text-ink-secondary">
                  {ROLE_LABEL[me.data.role]}
                </span>
              </span>
              <Button asChild variant="ghost" size="sm">
                <Link to="/">
                  <ArrowLeft aria-hidden="true" />
                  <span className="hidden sm:inline">Back to Wayora</span>
                  <span className="sm:hidden">Site</span>
                </Link>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Sign out"
                loading={pending}
                onClick={() => void signOut()}
              >
                <LogOut aria-hidden="true" />
                <span className="hidden sm:inline">Sign out</span>
              </Button>
            </div>
          </div>
        </header>
        <div className="mx-auto grid w-full max-w-[90rem] gap-8 px-gutter lg:grid-cols-[13.5rem_minmax(0,1fr)]">
          <nav
            aria-label="Admin sections"
            className="sticky top-(--header-offset) hidden self-start py-6 lg:block"
          >
            <NavLinks me={me.data} />
          </nav>
          <main id="main" tabIndex={-1} className="min-w-0 py-6 pb-16 focus:outline-none sm:py-8">
            <Outlet />
          </main>
        </div>
      </div>
    </AdminContext.Provider>
  );
}
