import { ChevronDown } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { Container, Wordmark, cn, effects } from '@wayora/ui';
import { useMediaQuery } from '@wayora/ui/motion';
import { CurrencySelector } from '../../features/navigation/CurrencySelector';
import {
  FOOTER_GROUPS,
  LEGAL_LINKS,
  SOCIAL_LINKS,
  type FooterGroup,
} from '../../features/navigation/footer';
import { FooterNavLink } from './FooterNavLink';

/**
 * The phone accordion (Radix Accordion) loads only on phones, so desktop and
 * tablet visitors don't download it. Until it arrives, the same closed rows
 * render without interaction, so nothing shifts when it does.
 */
const FooterAccordion = lazy(() => import('./FooterAccordion'));

function ClosedRows({ groups }: { groups: readonly FooterGroup[] }) {
  return (
    <ul className="border-t border-line-inverse">
      {groups.map((g) => (
        <li
          key={g.id}
          className="flex min-h-12 items-center justify-between gap-4 border-b border-line-inverse py-3 text-label text-ink-inverse last:border-b-0"
        >
          {g.title}
          <ChevronDown aria-hidden="true" className="size-4 text-ink-inverse-secondary" />
        </li>
      ))}
    </ul>
  );
}

/** Below `md` the link groups collapse into accordions so the footer stays short. */
const PHONE = '(max-width: 767.98px)';

function GroupColumns({ groups }: { groups: readonly FooterGroup[] }) {
  return (
    <div className="grid grid-cols-3 gap-8 lg:gap-10">
      {groups.map((group) => (
        <div key={group.id} className="flex flex-col gap-4">
          <h2 id={`footer-${group.id}`} className="text-label text-ink-inverse">
            {group.title}
          </h2>
          <ul aria-labelledby={`footer-${group.id}`} className="flex flex-col gap-3 text-body-sm">
            {group.links.map((link) => (
              <li key={link.to}>
                <FooterNavLink link={link} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * Global footer, rendered once by MarketingLayout. Links come from
 * features/navigation/footer.ts. The top edge is the same deep navy that the
 * homepage and Discover closing sections end on, so pages flow into it.
 */
export function SiteFooter() {
  const phone = useMediaQuery(PHONE);
  const year = new Date().getFullYear();

  return (
    <footer className="bg-deep text-ink-inverse focus-ring-inverse">
      <Container
        size="wide"
        className="grid grid-cols-[minmax(0,1fr)] gap-10 pt-section-sm pb-10 md:gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16 lg:pb-14"
      >
        <div className="flex max-w-sm flex-col gap-5">
          <Wordmark surface="dark" className="self-start" />
          <p className="text-body-sm text-ink-inverse-secondary">
            Flights, stays, trains, buses, metro, cabs and holidays, being brought together in one
            place to plan a whole journey. Services open one at a time.
          </p>
          {/* Restrained brand accent: the route motif (origin, stopover, destination). */}
          <svg
            viewBox="0 0 96 12"
            aria-hidden="true"
            focusable="false"
            className="h-3 w-24 text-brand-300/70"
            fill="none"
          >
            <path d="M6 6H90" stroke="currentColor" strokeWidth="1.25" strokeDasharray="2 4" />
            <circle cx="6" cy="6" r="3" fill="currentColor" />
            <circle
              cx="48"
              cy="6"
              r="2.5"
              stroke="currentColor"
              strokeWidth="1.25"
              fill="#171b35"
            />
            <circle cx="90" cy="6" r="3" fill="currentColor" />
          </svg>
          {SOCIAL_LINKS.length ? (
            <ul aria-label="Wayora on social media" className="flex gap-2">
              {SOCIAL_LINKS.map(({ label, href, icon: Icon }) => (
                <li key={href}>
                  <a
                    href={href}
                    rel="noopener noreferrer"
                    target="_blank"
                    aria-label={`${label} (opens in a new tab)`}
                    className="grid size-11 place-items-center rounded-full border border-white/20 hover:bg-white/10"
                  >
                    <Icon aria-hidden="true" className="size-5" />
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <nav aria-label="Footer">
          {phone ? (
            <Suspense fallback={<ClosedRows groups={FOOTER_GROUPS} />}>
              <FooterAccordion groups={FOOTER_GROUPS} />
            </Suspense>
          ) : (
            <GroupColumns groups={FOOTER_GROUPS} />
          )}
        </nav>
      </Container>

      <Container size="wide">
        <div className="flex flex-col gap-4 border-t border-line-inverse py-6 text-caption text-ink-inverse-secondary md:flex-row md:items-center md:justify-between">
          <p className="flex flex-wrap gap-x-3 gap-y-1">
            <span>© {year} Wayora</span>
            <span aria-hidden="true">·</span>
            <span>Booking isn&apos;t available yet.</span>
          </p>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <nav aria-label="Legal">
              <ul className="flex flex-wrap gap-x-5 gap-y-2">
                {LEGAL_LINKS.map((link) => (
                  <li key={link.to}>
                    <FooterNavLink link={link} className="text-caption" />
                  </li>
                ))}
                {import.meta.env.DEV ? (
                  <li>
                    <a
                      href="/design-system"
                      className={cn(
                        'rounded-xs text-ink-inverse-secondary hover:text-ink-inverse',
                        effects.underline,
                      )}
                    >
                      Design system (dev only)
                    </a>
                  </li>
                ) : null}
              </ul>
            </nav>
            <CurrencySelector tone="inverse" className="-mr-2.5" />
          </div>
        </div>
      </Container>
    </footer>
  );
}
