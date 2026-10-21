import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import type { CurrencyCode } from '@wayora/contracts';
import { Divider, Field, MobileNav, Select, Wordmark, cn } from '@wayora/ui';
import { RevealGroup, RevealItem, stagger } from '@wayora/ui/motion';
import { DISPLAY_CURRENCIES, useDisplayCurrency } from '../preferences/currency';
import { DrawerAccount } from './AccountAction';
import { DISCOVER, SERVICE_NAV, type AppPath, type HeaderTone } from './config';
import { ServiceMenuItem, serviceMenuRow } from './ServiceMenuItem';

/** Rows slide in one after another each time the drawer opens. */
const ROW_STAGGER = stagger.tight / 2;
const FIRST_ROW_DELAY = stagger.tight;

function DrawerLink({
  to,
  icon,
  title,
  summary,
  soon,
  current,
  onNavigate,
}: {
  to: AppPath;
  icon: LucideIcon;
  title: string;
  summary: string;
  soon?: boolean;
  current: boolean;
  onNavigate: () => void;
}) {
  return (
    <RevealItem as="li" preset="fadeStart" distance={12}>
      <Link
        to={to}
        onClick={onNavigate}
        aria-current={current ? 'page' : undefined}
        className={cn(
          serviceMenuRow,
          'min-h-14 items-center px-3 py-2 aria-[current=page]:bg-brand-soft',
        )}
      >
        <ServiceMenuItem icon={icon} title={title} summary={summary} soon={soon} />
      </Link>
    </RevealItem>
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
          <RevealGroup
            as="ul"
            trigger="mount"
            stagger={ROW_STAGGER}
            delayChildren={FIRST_ROW_DELAY}
            className="flex flex-col gap-0.5"
          >
            {SERVICE_NAV.map((s) => (
              <DrawerLink
                key={s.slug}
                to={s.path}
                icon={s.icon}
                title={s.name}
                summary={s.summary}
                soon={s.availability !== 'live'}
                current={pathname === s.path}
                onNavigate={close}
              />
            ))}
          </RevealGroup>
        </section>

        <Divider />

        <section aria-labelledby="drawer-explore">
          <h2 id="drawer-explore" className="px-3 pb-2 text-caption text-ink-secondary">
            Explore
          </h2>
          <RevealGroup
            as="ul"
            trigger="mount"
            delayChildren={FIRST_ROW_DELAY + SERVICE_NAV.length * ROW_STAGGER}
          >
            <DrawerLink
              to={DISCOVER.path}
              icon={DISCOVER.icon}
              title={DISCOVER.name}
              summary={DISCOVER.summary}
              soon
              current={pathname === DISCOVER.path}
              onNavigate={close}
            />
          </RevealGroup>
        </section>

        <Divider />

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
