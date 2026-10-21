import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router';
import { BRAND_ROUTE_PATH, Button, NavigationMenuLink, cn, interaction } from '@wayora/ui';
import {
  DISCOVER,
  HEADER_SERVICE_LINKS,
  MORE_MENU_SLUGS,
  serviceBySlug,
  type ServiceNavItem,
} from './config';
import { ServiceMenuItem, serviceMenuRow } from './ServiceMenuItem';

/** Services that collapse out of the bar below `xl` appear here instead. */
const collapsed = HEADER_SERVICE_LINKS.filter((l) => l.collapseBelowXl).map(
  (l) => serviceBySlug[l.slug],
);
const always = MORE_MENU_SLUGS.map((slug) => serviceBySlug[slug]);

function ServiceLink({ service, className }: { service: ServiceNavItem; className?: string }) {
  return (
    <li className={className}>
      <NavigationMenuLink>
        <Link to={service.path} className={cn(serviceMenuRow, 'items-start p-3')}>
          <ServiceMenuItem
            icon={service.icon}
            title={service.name}
            summary={service.summary}
            soon
          />
        </Link>
      </NavigationMenuLink>
    </li>
  );
}

/**
 * Panel for the "More" trigger: secondary services plus a featured panel.
 * Every service is labelled "Soon" (booking isn't open) and links to its demo search page.
 */
export function TravelMegaMenu() {
  return (
    <div className="grid w-[min(46rem,calc(100vw-2rem))] grid-cols-[minmax(0,1fr)_16rem] gap-2 p-2">
      <div className="flex flex-col p-2">
        <p id="more-services-heading" className="px-3 pt-1 pb-2 text-caption text-ink-secondary">
          More ways to travel
        </p>
        <ul aria-labelledby="more-services-heading" className="flex flex-col gap-0.5">
          {collapsed.map((service) => (
            <ServiceLink key={service.slug} service={service} className="xl:hidden" />
          ))}
          {always.map((service) => (
            <ServiceLink key={service.slug} service={service} />
          ))}
        </ul>
      </div>

      <div className="relative flex min-h-64 flex-col overflow-hidden rounded-lg bg-deep p-5 text-ink-inverse focus-ring-inverse">
        <svg
          viewBox="0 0 32 32"
          fill="none"
          aria-hidden="true"
          className="pointer-events-none absolute -right-6 -bottom-12 size-36 text-brand-400/30"
        >
          <path
            d={BRAND_ROUTE_PATH}
            stroke="currentColor"
            strokeWidth="1.1"
            strokeLinecap="round"
          />
          <circle cx="8" cy="10.5" r="1.3" fill="currentColor" />
          <circle cx="16" cy="10.5" r="1" stroke="currentColor" strokeWidth="0.7" />
          <circle cx="24" cy="10.5" r="1.3" fill="currentColor" />
        </svg>
        <p className="relative text-title text-ink-inverse">Your next journey starts here.</p>
        <p className="relative mt-2 mb-5 text-body-sm text-ink-inverse-secondary">
          Discover will bring destination ideas and travel guides together. It opens in a later
          phase.
        </p>
        <NavigationMenuLink>
          <Button asChild size="sm" variant="inverse" className="group relative mt-auto self-start">
            <Link to={DISCOVER.path}>
              Explore destinations
              <ArrowRight aria-hidden="true" className={interaction.iconNudge} />
            </Link>
          </Button>
        </NavigationMenuLink>
      </div>
    </div>
  );
}
