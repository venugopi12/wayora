import {
  Bell,
  CalendarRange,
  Gift,
  LifeBuoy,
  Luggage,
  MessageSquareText,
  Sparkles,
  UserRound,
  Users,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { Container, cn } from '@wayora/ui';
import { ACCOUNT_PATHS } from '../navigation/config';

/*
 * The signed-in area's frame: side navigation (Profile, Saved travellers,
 * My trips, Trip planner, Travel assistant, Rewards, Notifications, Support, Reviews) and a
 * page heading. Used by /profile, /profile/travellers, /trips, /plans,
 * /assistant, /rewards and /notifications.
 */

const ACCOUNT_NAV = [
  { to: ACCOUNT_PATHS.profile, label: 'Profile', icon: UserRound, end: true },
  { to: ACCOUNT_PATHS.travellers, label: 'Saved travellers', icon: Users, end: true },
  // Not `end`: trip details (/trips/WYD-…) keep "My trips" marked as current.
  { to: ACCOUNT_PATHS.trips, label: 'My trips', icon: Luggage, end: false },
  // Plans are not bookings: a separate entry (/plans, /plans/:id).
  { to: ACCOUNT_PATHS.plans, label: 'Trip planner', icon: CalendarRange, end: false },
  // Conversations live under /assistant/:id.
  { to: ACCOUNT_PATHS.assistant, label: 'Travel assistant', icon: Sparkles, end: false },
  { to: ACCOUNT_PATHS.rewards, label: 'Rewards', icon: Gift, end: true },
  { to: ACCOUNT_PATHS.notifications, label: 'Notifications', icon: Bell, end: true },
  // Requests live under /support/:reference (Phase 27).
  { to: ACCOUNT_PATHS.support, label: 'Support', icon: LifeBuoy, end: false },
  // Writing and editing live under /reviews/… (Phase 28).
  { to: ACCOUNT_PATHS.reviews, label: 'Reviews', icon: MessageSquareText, end: false },
] as const;

export function AccountShell({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Container className="py-section-sm">
      <div className="grid gap-8 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-12">
        <nav aria-label="Account" className="lg:pt-2">
          <ul className="flex flex-wrap gap-1 lg:flex-col">
            {ACCOUNT_NAV.map(({ to, label, icon: Icon, end }) => (
              <li key={to} className="shrink-0">
                <NavLink
                  to={to}
                  end={end}
                  className={cn(
                    'flex min-h-11 items-center gap-2 rounded-md px-2.5 text-body-sm text-ink-secondary sm:gap-2.5 sm:px-3',
                    'hover:bg-brand-soft hover:text-brand-ink',
                    'aria-[current=page]:bg-brand-soft aria-[current=page]:font-semibold aria-[current=page]:text-brand-ink',
                  )}
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex min-w-0 flex-col gap-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex max-w-2xl flex-col gap-2">
              <h1 className="text-heading-1">{title}</h1>
              <p className="text-body text-ink-secondary">{description}</p>
            </div>
            {actions ? <div className="shrink-0">{actions}</div> : null}
          </div>
          {children}
        </div>
      </div>
    </Container>
  );
}

export function Panel({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = `panel-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <section
      aria-labelledby={id}
      className={cn('rounded-xl border border-line bg-card p-5 shadow-xs sm:p-7', className)}
    >
      <div className="mb-5 flex flex-col gap-1">
        <h2 id={id} className="text-title">
          {title}
        </h2>
        {description ? <p className="text-body-sm text-ink-secondary">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}
