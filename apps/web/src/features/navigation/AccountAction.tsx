import {
  Bell,
  LifeBuoy,
  CalendarRange,
  ChevronDown,
  LogOut,
  Luggage,
  ShieldCheck,
  Sparkles,
  UserRound,
  Users,
} from 'lucide-react';
import { isStaff } from '@wayora/contracts';
import { Link, useLocation, useNavigate } from 'react-router';
import {
  Avatar,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Skeleton,
  cn,
} from '@wayora/ui';
import { useAuth } from '../auth/AuthProvider';
import { loginPathFor } from '../auth/redirect';
import { useSignOut } from '../auth/useSignOut';
import { ADMIN_PATHS } from '../admin/paths';
import { ACCOUNT_PATHS, DISCOVER, type HeaderTone } from './config';

/*
 * Account entry points in the header and the mobile drawer. Every variant has
 * three states, driven by the single /auth/session check:
 *   loading          → same-size placeholders (no flash of the wrong state)
 *   unauthenticated  → Sign in / Create account
 *   authenticated    → account menu: my trips, trip planner, notifications, profile, saved travellers, sign out
 */

const firstName = (name: string) => name.split(' ')[0] ?? name;

/** Sign-in link that brings people back to the page they were on. */
function useSignInHref(): string {
  const { pathname, search, hash } = useLocation();
  return loginPathFor(`${pathname}${search}${hash}`);
}

function AccountMenu({ tone }: { tone: HeaderTone }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { pending, signOut } = useSignOut();
  if (!user) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={tone === 'inverse' ? 'ghost-inverse' : 'ghost'}
          size="sm"
          className="gap-2 pl-1.5"
          aria-label={`Account menu for ${user.name}`}
        >
          <Avatar name={user.name} size="sm" className="size-7 ring-0" />
          <span className="max-w-28 truncate">{firstName(user.name)}</span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          <span className="block truncate text-label text-ink">{user.name}</span>
          <span className="block truncate">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<Luggage />} onSelect={() => void navigate(ACCOUNT_PATHS.trips)}>
          My trips
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={<CalendarRange />}
          onSelect={() => void navigate(ACCOUNT_PATHS.plans)}
        >
          Trip planner
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={<Sparkles />}
          onSelect={() => void navigate(ACCOUNT_PATHS.assistant)}
        >
          Travel assistant
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={<Bell />}
          onSelect={() => void navigate(ACCOUNT_PATHS.notifications)}
        >
          Notifications
        </DropdownMenuItem>
        <DropdownMenuItem icon={<LifeBuoy />} onSelect={() => void navigate(ACCOUNT_PATHS.support)}>
          Support
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={<UserRound />}
          onSelect={() => void navigate(ACCOUNT_PATHS.profile)}
        >
          Profile
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Users />} onSelect={() => void navigate(ACCOUNT_PATHS.travellers)}>
          Saved travellers
        </DropdownMenuItem>
        {/* Staff only. Hiding it is presentation; the API authorizes every admin request. */}
        {isStaff(user.role) ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              icon={<ShieldCheck />}
              onSelect={() => void navigate(ADMIN_PATHS.overview)}
            >
              Admin dashboard
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<LogOut />} disabled={pending} onSelect={() => void signOut()}>
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Header, lg and up: "Sign in" or the account menu. */
export function AccountAction({ tone = 'default' }: { tone?: HeaderTone }) {
  const { status } = useAuth();
  const signInHref = useSignInHref();
  const { pathname } = useLocation();

  if (status === 'loading') {
    return <Skeleton className="h-9 w-24 rounded-sm opacity-60" />;
  }
  if (status === 'authenticated') return <AccountMenu tone={tone} />;
  return (
    <Button asChild variant={tone === 'inverse' ? 'ghost-inverse' : 'ghost'} size="sm">
      <Link to={signInHref} aria-current={pathname === ACCOUNT_PATHS.login ? 'page' : undefined}>
        <UserRound aria-hidden="true" />
        Sign in
      </Link>
    </Button>
  );
}

/** Header call to action, xl and up: "Create account" when signed out, "Plan a trip" when signed in. */
export function HeaderCta({ tone = 'default' }: { tone?: HeaderTone }) {
  const { status } = useAuth();
  if (status === 'loading') return <Skeleton className="h-9 w-32 rounded-sm opacity-60" />;
  const variant = tone === 'inverse' ? 'inverse' : 'primary';
  return status === 'authenticated' ? (
    <Button asChild size="sm" variant={variant}>
      <Link to={DISCOVER.path}>Plan a trip</Link>
    </Button>
  ) : (
    <Button asChild size="sm" variant={variant}>
      <Link to={ACCOUNT_PATHS.register}>Create account</Link>
    </Button>
  );
}

/** Mobile drawer footer. `onNavigate` closes the drawer. */
export function DrawerAccount({ onNavigate }: { onNavigate: () => void }) {
  const { status, user } = useAuth();
  const signInHref = useSignInHref();
  const { pending, signOut } = useSignOut();

  if (status === 'loading') {
    return (
      <div className="flex flex-col gap-3" aria-hidden="true">
        <Skeleton className="h-13 rounded-md" />
        <Skeleton className="h-13 rounded-md" />
      </div>
    );
  }

  if (status === 'authenticated' && user) {
    const linkRow = cn(
      'flex min-h-12 items-center gap-3 rounded-md px-3 text-body text-ink hover:bg-brand-soft hover:text-brand-ink',
      '[&_svg]:size-[18px] [&_svg]:text-ink-secondary',
    );
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3 px-1">
          <Avatar name={user.name} />
          <div className="min-w-0">
            <p className="truncate text-label">{user.name}</p>
            <p className="truncate text-caption text-ink-secondary">{user.email}</p>
          </div>
        </div>
        <ul aria-label="Your account" className="flex flex-col">
          <li>
            <Link to={ACCOUNT_PATHS.trips} onClick={onNavigate} className={linkRow}>
              <Luggage aria-hidden="true" />
              My trips
            </Link>
          </li>
          <li>
            <Link to={ACCOUNT_PATHS.notifications} onClick={onNavigate} className={linkRow}>
              <Bell aria-hidden="true" />
              Notifications
            </Link>
          </li>
          <li>
            <Link to={ACCOUNT_PATHS.profile} onClick={onNavigate} className={linkRow}>
              <UserRound aria-hidden="true" />
              Profile
            </Link>
          </li>
          <li>
            <Link to={ACCOUNT_PATHS.travellers} onClick={onNavigate} className={linkRow}>
              <Users aria-hidden="true" />
              Saved travellers
            </Link>
          </li>
          {isStaff(user.role) ? (
            <li>
              <Link to={ADMIN_PATHS.overview} onClick={onNavigate} className={linkRow}>
                <ShieldCheck aria-hidden="true" />
                Admin dashboard
              </Link>
            </li>
          ) : null}
        </ul>
        <Button
          variant="secondary"
          size="lg"
          fullWidth
          loading={pending}
          onClick={async () => {
            if (await signOut()) onNavigate();
          }}
        >
          <LogOut aria-hidden="true" />
          Sign out
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Button asChild size="lg" fullWidth>
        <Link to={ACCOUNT_PATHS.register} onClick={onNavigate}>
          Create account
        </Link>
      </Button>
      <Button asChild variant="secondary" size="lg" fullWidth>
        <Link to={signInHref} onClick={onNavigate}>
          <UserRound aria-hidden="true" />
          Sign in
        </Link>
      </Button>
    </div>
  );
}
