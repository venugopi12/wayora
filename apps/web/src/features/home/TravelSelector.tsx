import { ArrowRight, Compass } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type {
  CategoryAvailability,
  DestinationSummary,
  TravelCategorySlug,
} from '@wayora/contracts';
import { Badge, Button, Container, Tabs, TabsContent, TabsList, TabsTrigger } from '@wayora/ui';
import { useCategories } from '../catalog/useCategories';
import { destinationPath, discoverPath } from '../discover/paths';
import { SERVICE_NAV, type ServiceNavItem } from '../navigation/config';
import { DestinationCombobox } from '../navigation/DestinationCombobox';

export interface TravelIntent {
  service: TravelCategorySlug;
  destinationSlug: string | null;
}

/**
 * Where an intent leads today: the destination's Discover page (which offers
 * the chosen service as its first travel option), or Discover itself. Replace
 * per service as booking flows ship.
 */
export function intentHref({ service, destinationSlug }: TravelIntent): string {
  if (destinationSlug) return `${destinationPath(destinationSlug)}?mode=${service}`;
  return discoverPath();
}

const statusCopy: Record<
  CategoryAvailability,
  { badge: string; tone: 'neutral' | 'brand' | 'success' }
> = {
  planned: { badge: 'Coming in a later phase', tone: 'neutral' },
  beta: { badge: 'Beta', tone: 'brand' },
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
          {availability === 'live'
            ? service.summary
            : `${service.category.description} Booking isn't open yet; you can explore destination ideas today.`}
        </p>
      </div>
    </div>
  );
}

/**
 * Homepage travel entry point. Selecting a service and a sample destination
 * leads to that destination's Discover page (no search API exists yet). Service status
 * comes from the catalog API, falling back to the bundled contract, so a
 * service flips to "Available" here as soon as the API marks it live.
 */
export function TravelSelector({ onExplore }: { onExplore?: (intent: TravelIntent) => void }) {
  const navigate = useNavigate();
  const { data } = useCategories();
  const [service, setService] = useState<TravelCategorySlug>('flights');
  const [destination, setDestination] = useState<DestinationSummary | null>(null);

  const availability = useMemo(() => {
    const map = new Map(SERVICE_NAV.map((s) => [s.slug, s.availability]));
    data?.forEach((c) => map.set(c.slug, c.availability));
    return map;
  }, [data]);

  const current = SERVICE_NAV.find((s) => s.slug === service) ?? SERVICE_NAV[0]!;
  const intent: TravelIntent = { service, destinationSlug: destination?.slug ?? null };

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
              Booking opens service by service in later phases.
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
                  Sample destinations only. Nothing can be booked yet.
                </p>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row lg:flex-col lg:pb-6">
                <Button
                  size="lg"
                  leadingIcon={<Compass />}
                  onClick={() => (onExplore ? onExplore(intent) : navigate(intentHref(intent)))}
                >
                  {destination ? `Explore ${destination.name}` : 'Explore ideas'}
                </Button>
                <Button asChild variant="ghost" size="sm" className="justify-center">
                  <Link to={current.path}>
                    About {current.name}
                    <ArrowRight aria-hidden="true" />
                  </Link>
                </Button>
              </div>
            </div>
          </Tabs>
        </div>
      </Container>
    </section>
  );
}
