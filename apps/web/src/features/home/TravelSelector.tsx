import { Compass, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  DEMO_SEARCH_NOTICE,
  type CategoryAvailability,
  type DestinationSummary,
  type TravelCategorySlug,
} from '@wayora/contracts';
import { Badge, Button, Container, Tabs, TabsContent, TabsList, TabsTrigger } from '@wayora/ui';
import { useCategories } from '../catalog/useCategories';
import { destinationPath, discoverPath, servicePathFor } from '../discover/paths';
import { SERVICE_NAV, type ServiceNavItem } from '../navigation/config';
import { DestinationCombobox } from '../navigation/DestinationCombobox';

export interface TravelIntent {
  service: TravelCategorySlug;
  destinationSlug: string | null;
  availability: CategoryAvailability;
}

/**
 * Where the main action leads.
 *
 * - A service with search (catalog `beta` or `live`): its search page. A chosen
 *   destination travels as `?to=<destination slug>`, the same link Discover
 *   uses: the search page maps it to a valid place for that service with the
 *   shared place lookup and prefills the form only. It never starts a search,
 *   because the dates (and, for journeys, the origin) are still missing. A
 *   destination the demo doesn't cover is named on that page, honestly.
 * - A `planned` service has no search yet: Discover ideas instead.
 */
export function intentHref({ service, destinationSlug, availability }: TravelIntent): string {
  if (availability === 'planned') {
    return destinationSlug ? `${destinationPath(destinationSlug)}?mode=${service}` : discoverPath();
  }
  return destinationSlug ? servicePathFor(service, destinationSlug) : `/${service}`;
}

/** The secondary action: the destination's Discover page, or Discover itself. */
export function exploreHref({ service, destinationSlug }: TravelIntent): string {
  return destinationSlug ? `${destinationPath(destinationSlug)}?mode=${service}` : discoverPath();
}

/** Button text for the main action. It opens the search page; it doesn't run a search. */
const SEARCH_ACTION: Record<TravelCategorySlug, string> = {
  flights: 'Search flights',
  hotels: 'Search hotels',
  trains: 'Search trains',
  buses: 'Search buses',
  metro: 'Plan a metro journey',
  cabs: 'Find a cab',
  holidays: 'Search holiday packages',
};

const statusCopy: Record<
  CategoryAvailability,
  { badge: string; tone: 'neutral' | 'brand' | 'success' }
> = {
  planned: { badge: 'Coming in a later phase', tone: 'neutral' },
  beta: { badge: 'Demo search', tone: 'brand' },
  live: { badge: 'Available', tone: 'success' },
};

function ServicePanel({
  service,
  availability,
}: {
  service: ServiceNavItem;
  availability: CategoryAvailability;
}) {
  const Icon = service.icon;
  return (
    <div className="flex h-full items-start gap-4">
      <span
        aria-hidden="true"
        className="grid size-12 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand-ink [&_svg]:size-6"
      >
        <Icon strokeWidth={1.75} />
      </span>
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-title">{service.name}</h3>
          <Badge size="sm" tone={statusCopy[availability].tone}>
            {statusCopy[availability].badge}
          </Badge>
        </div>
        <p className="text-body-sm text-ink-secondary">
          {availability === 'planned'
            ? "Search and booking aren't available yet; you can explore destination ideas today."
            : service.category.description}
        </p>
        {availability === 'beta' ? (
          <p className="text-caption text-ink-secondary">{DEMO_SEARCH_NOTICE}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Homepage travel entry point. Pick a service (and optionally a sample
 * destination), then open that service's search page, prefilled. Service
 * status comes from the catalog API, falling back to the bundled contract.
 */
export function TravelSelector() {
  const { data } = useCategories();
  const [service, setService] = useState<TravelCategorySlug>('flights');
  const [destination, setDestination] = useState<DestinationSummary | null>(null);

  const availability = useMemo(() => {
    const map = new Map(SERVICE_NAV.map((s) => [s.slug, s.availability]));
    data?.forEach((c) => map.set(c.slug, c.availability));
    return map;
  }, [data]);

  const current = SERVICE_NAV.find((s) => s.slug === service) ?? SERVICE_NAV[0]!;
  const currentAvailability = availability.get(service) ?? current.availability;
  const intent: TravelIntent = {
    service,
    destinationSlug: destination?.slug ?? null,
    availability: currentAvailability,
  };
  const anySearch = [...availability.values()].some((a) => a !== 'planned');

  return (
    <section
      id="journeys"
      aria-labelledby="journeys-title"
      className="relative z-(--z-raised) -mt-24 scroll-mt-(--header-offset) sm:-mt-28 lg:-mt-32"
    >
      <Container size="wide">
        <div className="rounded-2xl border border-line bg-card p-3 shadow-lg sm:p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-2 pt-1 pb-3">
            <h2 id="journeys-title" className="text-title">
              How would you like to travel?
            </h2>
            <p className="text-caption text-ink-secondary">
              {anySearch
                ? 'Try any service with demo search. Booking opens in a later phase.'
                : 'Booking opens service by service in later phases.'}
            </p>
          </div>

          <Tabs value={service} onValueChange={(v) => setService(v as TravelCategorySlug)}>
            <TabsList label="Travel services" className="rounded-lg bg-sunken p-1">
              {SERVICE_NAV.map((s) => {
                const Icon = s.icon;
                return (
                  <TabsTrigger key={s.slug} value={s.slug} icon={<Icon strokeWidth={1.75} />}>
                    {s.name}
                  </TabsTrigger>
                );
              })}
            </TabsList>

            <div className="grid gap-5 px-2 pt-5 pb-2 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)_auto] lg:items-end lg:gap-6">
              {SERVICE_NAV.map((s) => (
                <TabsContent key={s.slug} value={s.slug} className="lg:self-center">
                  <ServicePanel
                    service={s}
                    availability={availability.get(s.slug) ?? s.availability}
                  />
                </TabsContent>
              ))}

              <div className="flex flex-col gap-2">
                <label htmlFor="journey-destination" className="text-label">
                  Where to?
                </label>
                <DestinationCombobox
                  id="journey-destination"
                  variant="floating"
                  label="Where to?"
                  describedBy="journey-destination-hint"
                  placeholder="Try Goa, Jaipur or Manali"
                  onSelect={setDestination}
                  onClear={() => setDestination(null)}
                />
                <p id="journey-destination-hint" className="text-caption text-ink-secondary">
                  Optional. Sample destinations only, used to start your search.
                </p>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row lg:flex-col lg:pb-6">
                <Button asChild size="lg">
                  <Link to={intentHref(intent)}>
                    {currentAvailability === 'planned' ? (
                      <Compass aria-hidden="true" />
                    ) : (
                      <Search aria-hidden="true" />
                    )}
                    {currentAvailability === 'planned'
                      ? destination
                        ? `Explore ${destination.name}`
                        : 'Explore ideas'
                      : SEARCH_ACTION[service]}
                  </Link>
                </Button>
                {currentAvailability === 'planned' ? null : (
                  <Button asChild variant="ghost" size="sm" className="justify-center">
                    <Link to={exploreHref(intent)}>
                      {destination ? `Explore ${destination.name}` : 'Destination ideas'}
                    </Link>
                  </Button>
                )}
              </div>
            </div>
          </Tabs>
        </div>
      </Container>
    </section>
  );
}
