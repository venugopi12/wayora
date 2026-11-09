import { Download, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import type { CategoryAvailability, CurrencyCode } from '@wayora/contracts';
import { Divider, Field, MobileNav, Select, Wordmark, cn } from '@wayora/ui';
import { stagger } from '@wayora/ui/motion';
import { DISPLAY_CURRENCIES, useDisplayCurrency } from '../preferences/currency';
import { DrawerAccount } from './AccountAction';
import { DISCOVER, SERVICE_NAV, type AppPath, type HeaderTone } from './config';
import { ServiceMenuItem, serviceMenuRow } from './ServiceMenuItem';
import { useInstallMethod } from '../../pwa/install';
import { InstallDialog } from '../../pwa/PwaNotices';

/**
 * Rows slide in one after another each time the drawer opens. A CSS animation
 * (compositor only) rather than per-row JavaScript, so opening the menu stays
 * quick on slow phones (docs/pwa.md#performance); none under reduced motion.
 */
const ROW_STAGGER = stagger.tight / 2;
const FIRST_ROW_DELAY = stagger.tight;
const rowDelay = (index: number) => ({
  animationDelay: `${Math.round((FIRST_ROW_DELAY + index * ROW_STAGGER) * 1000)}ms`,
});

function DrawerLink({
  to,
  icon,
  title,
  summary,
  availability,
  current,
  index,
  onNavigate,
}: {
  index: number;
  to: AppPath;
  icon: LucideIcon;
  title: string;
  summary: string;
  availability?: CategoryAvailability;
  current: boolean;
  onNavigate: () => void;
}) {
  return (
    <li className="drawer-row" style={rowDelay(index)}>
      <Link
        to={to}
        onClick={onNavigate}
        aria-current={current ? 'page' : undefined}
        className={cn(
          serviceMenuRow,
          'min-h-14 items-center px-3 py-2 aria-[current=page]:bg-brand-soft',
        )}
      >
        <ServiceMenuItem icon={icon} title={title} summary={summary} availability={availability} />
      </Link>
    </li>
  );
}

/**
 * Small-screen navigation: a right-hand sheet (focus-trapped, scroll-locked,
 * Escape/backdrop/close-button to dismiss, focus returns to the menu button)
 * grouping all seven services, Discover, and preferences. Not a shrunken
 * desktop mega menu: rows are full-width, 56px touch targets.
 */
export function MobileNavigationDrawer({
  className,
  tone = 'default',
}: {
  className?: string;
  tone?: HeaderTone;
}) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const { currency, setCurrency } = useDisplayCurrency();
  const close = () => setOpen(false);

  return (
    <MobileNav
      className={className}
      triggerVariant={tone === 'inverse' ? 'ghost-inverse' : 'ghost'}
      label="Main menu"
      open={open}
      onOpenChange={setOpen}
      title={
        <Link
          to="/"
          onClick={close}
          aria-label="Wayora, home"
          className="flex min-h-11 items-center rounded-md"
        >
          <Wordmark size="sm" />
        </Link>
      }
      footer={<DrawerAccount onNavigate={close} />}
    >
      <nav aria-label="Main menu" className="flex flex-col gap-5">
        <section aria-labelledby="drawer-travel">
          <h2 id="drawer-travel" className="px-3 pb-2 text-caption text-ink-secondary">
            Travel services
          </h2>
          <ul className="flex flex-col gap-0.5">
            {SERVICE_NAV.map((s, i) => (
              <DrawerLink
                key={s.slug}
                index={i}
                to={s.path}
                icon={s.icon}
                title={s.name}
                summary={s.summary}
                availability={s.availability}
                current={pathname === s.path}
                onNavigate={close}
              />
            ))}
          </ul>
        </section>

        <Divider />

        <section aria-labelledby="drawer-explore">
          <h2 id="drawer-explore" className="px-3 pb-2 text-caption text-ink-secondary">
            Explore
          </h2>
          <ul>
            <DrawerLink
              index={SERVICE_NAV.length}
              to={DISCOVER.path}
              icon={DISCOVER.icon}
              title={DISCOVER.name}
              summary={DISCOVER.summary}
              current={pathname === DISCOVER.path}
              onNavigate={close}
            />
          </ul>
        </section>

        <Divider />

        <InstallEntry />

        <section aria-labelledby="drawer-preferences" className="px-3 pb-2">
          <h2 id="drawer-preferences" className="pb-3 text-caption text-ink-secondary">
            Preferences
          </h2>
          <Field label="Display currency" hint="For this visit only. Prices aren't converted.">
            <Select
              value={currency.code}
              onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
              options={DISPLAY_CURRENCIES.map((c) => ({
                value: c.code,
                label: `${c.code}, ${c.name}`,
              }))}
            />
          </Field>
        </section>
      </nav>
    </MobileNav>
  );
}

/** "Install the app" where this browser can install (docs/pwa.md#install). */
function InstallEntry() {
  const method = useInstallMethod();
  const [open, setOpen] = useState(false);
  if (method === 'installed' || method === 'unsupported') return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(serviceMenuRow, 'min-h-14 w-full items-center px-3 py-2 text-left')}
      >
        <ServiceMenuItem
          icon={Download}
          title="Install the app"
          summary="Open Wayora from your home screen."
        />
      </button>
      <InstallDialog open={open} onOpenChange={setOpen} />
      <Divider />
    </>
  );
}
