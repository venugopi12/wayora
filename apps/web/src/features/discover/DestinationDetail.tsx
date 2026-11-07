import { ArrowLeft, ArrowRight, CalendarRange, Compass, MapPin } from 'lucide-react';
import { Link } from 'react-router';
import type { Destination, DestinationSummary, TravelCategorySlug } from '@wayora/contracts';
import {
  Badge,
  Breadcrumbs,
  Button,
  Container,
  DestinationCard,
  DestinationImage,
  EmptyState,
  Eyebrow,
  PageHeader,
  cn,
  interaction,
} from '@wayora/ui';
import { ImageReveal, LineReveal, Reveal, RevealGroup, RevealItem } from '@wayora/ui/motion';
import { useRouteBreadcrumbs } from '../../components/layout/route-handle';
import { DISCOVER, serviceBySlug } from '../navigation/config';
import { newPlanPath } from '../planner/paths';
import { PAIRINGS, moodBySlug } from './data';
import { placeLine } from './format';
import { destinationPath, discoverPath, serviceForPlace, servicePathFor } from './paths';
import { DestinationReviews } from '../reviews/sections';
import { findDestination, relatedDestinations } from './search';

/**
 * Services worth offering for a destination (demo search and demo booking).
 * Rail and road are offered for the India samples only. A service chosen on
 * the homepage moves to the front when it applies here, and is otherwise not
 * offered (no "trains to Bali").
 */
export function travelOptionsFor(
  destination: Pick<DestinationSummary, 'region'>,
  preferred?: TravelCategorySlug,
): TravelCategorySlug[] {
  const base: TravelCategorySlug[] =
    destination.region === 'india'
      ? ['flights', 'trains', 'hotels', 'buses', 'cabs', 'holidays']
      : ['flights', 'hotels', 'cabs', 'holidays'];
  if (!preferred || !base.includes(preferred)) return base;
  return [preferred, ...base.filter((s) => s !== preferred)];
}

function Hero({ destination }: { destination: Destination }) {
  const crumbs = useRouteBreadcrumbs();
  return (
    <section aria-labelledby="destination-title" className="pt-8 pb-section-sm sm:pt-10">
      <Container size="wide" className="flex flex-col gap-8">
        <Breadcrumbs items={crumbs} />
        <div className="grid grid-cols-[minmax(0,1fr)] items-center gap-10 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-16">
          <div className="flex flex-col gap-6 lg:order-1">
            <Reveal
              as="p"
              trigger="mount"
              distance="sm"
              className="flex items-center gap-2 text-label text-brand-ink"
            >
              <MapPin aria-hidden="true" className="size-4" />
              {placeLine(destination)}
            </Reveal>
            <LineReveal
              id="destination-title"
              className="text-display"
              lines={[destination.name]}
              delay={0.05}
            />
            <Reveal
              as="p"
              trigger="mount"
              delay={0.25}
              className="max-w-[36rem] text-body-lg text-ink-secondary"
            >
              {destination.description}
            </Reveal>
            <Reveal trigger="mount" delay={0.35} className="flex flex-col gap-5">
              <ul aria-label="Travel moods" className="flex flex-wrap gap-2">
                {destination.categories.map((c) => (
                  <li key={c}>
                    <Link
                      to={discoverPath({ mood: c }, { toResults: true })}
                      className="inline-flex min-h-9 items-center rounded-full border border-line bg-card px-3.5 text-body-sm font-semibold text-ink transition-colors duration-(--duration-fast) hover:border-brand-300 hover:bg-brand-50"
                    >
                      {moodBySlug[c].title}
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Button asChild size="lg">
                  <a href="#travel-options">
                    See travel options
                    <ArrowRight aria-hidden="true" />
                  </a>
                </Button>
                <Button asChild size="lg" variant="secondary">
                  <Link to={newPlanPath(destination.id)}>
                    <CalendarRange aria-hidden="true" />
                    Plan this trip
                  </Link>
                </Button>
                <Button asChild size="lg" variant="secondary">
                  <Link to={DISCOVER.path}>
                    <ArrowLeft aria-hidden="true" />
                    All destinations
                  </Link>
                </Button>
              </div>
            </Reveal>
          </div>
          <ImageReveal className="relative overflow-hidden rounded-2xl shadow-lg lg:order-2">
            <DestinationImage
              name={destination.name}
              image={
                destination.image
                  ? { ...destination.image, sizes: '(min-width: 1024px) 52vw, 100vw' }
                  : undefined
              }
              aspect="4/3"
              priority
              zoomOnHover={false}
            >
              {destination.image?.kind === 'artwork' ? (
                <span className="absolute right-3 bottom-3 rounded-full bg-deep/70 px-2.5 py-1 text-caption text-ink-inverse backdrop-blur-sm">
                  Illustration
                </span>
              ) : null}
            </DestinationImage>
          </ImageReveal>
        </div>
      </Container>
    </section>
  );
}

function About({ destination }: { destination: Destination }) {
  return (
    <section aria-labelledby="about-title" className="border-t border-line bg-card py-section-sm">
      <Container
        size="wide"
        className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16"
      >
        <Reveal preset="fadeUp" className="flex flex-col gap-4">
          <Eyebrow>About {destination.name}</Eyebrow>
          <h2 id="about-title" className="text-heading-2">
            Why it&apos;s worth exploring
          </h2>
          <p className="text-body-lg text-ink-secondary">{destination.intro}</p>
          {destination.sample ? (
            <p className="text-caption text-ink-secondary">
              Sample editorial content. Check current travel advice and local conditions before you
              go.
            </p>
          ) : null}
        </Reveal>
        <RevealGroup as="ol" stagger="base" className="flex flex-col">
          {destination.highlights.map((h, i) => (
            <RevealItem
              as="li"
              key={h.title}
              className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-1 border-b border-line py-6 first:pt-0 last:border-b-0"
            >
              <span aria-hidden="true" className="numeric row-span-2 text-heading-3 text-brand">
                {String(i + 1).padStart(2, '0')}
              </span>
              <h3 className="text-title">{h.title}</h3>
              <p className="text-body text-ink-secondary">{h.text}</p>
            </RevealItem>
          ))}
        </RevealGroup>
      </Container>
    </section>
  );
}

function TravelOptions({
  destination,
  preferred,
}: {
  destination: Destination;
  preferred?: TravelCategorySlug;
}) {
  const options = travelOptionsFor(destination, preferred);
  const chosenApplies = preferred !== undefined && options.includes(preferred);
  return (
    <section
      id="travel-options"
      aria-labelledby="travel-options-title"
      className="scroll-mt-(--header-offset) py-section-sm"
    >
      <Container size="wide">
        <Reveal preset="sectionReveal">
          <PageHeader
            size="section"
            headingLevel="h2"
            id="travel-options-title"
            eyebrow="Plan the journey"
            title={`Ways to reach ${destination.name}`}
            description="Each option opens a demo search with sample data, where you can also make a demo booking. No real reservation or payment is made."
          />
        </Reveal>
        <RevealGroup
          as="ul"
          stagger="tight"
          aria-label={`Travel options for ${destination.name}`}
          className="mt-section-head grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 lg:grid-cols-3"
        >
          {options.map((slug) => {
            const service = serviceBySlug[slug];
            const Icon = service.icon;
            const chosen = chosenApplies && slug === preferred;
            return (
              <RevealItem as="li" key={slug}>
                <Link
                  to={servicePathFor(slug, destination.slug)}
                  aria-labelledby={`option-${slug}-name`}
                  aria-describedby={`option-${slug}-status`}
                  className={cn(
                    'group flex h-full items-center gap-4 rounded-xl border bg-card p-4 shadow-xs',
                    interaction.hoverLift,
                    chosen
                      ? 'border-brand ring-1 ring-brand'
                      : 'border-line hover:border-brand-200',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="grid size-12 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand-ink [&_svg]:size-6"
                  >
                    <Icon strokeWidth={1.75} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span id={`option-${slug}-name`} className="text-title">
                      {serviceForPlace(slug, destination.name)}
                    </span>
                    <span id={`option-${slug}-status`} className="flex flex-wrap gap-1.5">
                      <Badge size="sm">Demo search and booking</Badge>
                      {chosen ? (
                        <Badge size="sm" tone="brand">
                          Your choice
                        </Badge>
                      ) : null}
                    </span>
                  </span>
                  <ArrowRight
                    aria-hidden="true"
                    className={cn('size-5 shrink-0 text-brand', interaction.iconNudge)}
                  />
                </Link>
              </RevealItem>
            );
          })}
        </RevealGroup>
      </Container>
    </section>
  );
}

function Related({ destination }: { destination: DestinationSummary }) {
  const related = relatedDestinations(destination);
  const pairing = PAIRINGS.find((p) => p.stops.includes(destination.slug));
  const partner = pairing
    ? findDestination(pairing.stops.find((s) => s !== destination.slug))
    : undefined;

  return (
    <section
      aria-labelledby="related-title"
      className="border-t border-line bg-sunken py-section-sm"
    >
      <Container size="wide">
        <Reveal preset="sectionReveal">
          <PageHeader
            size="section"
            headingLevel="h2"
            id="related-title"
            eyebrow="Keep exploring"
            title="You might also like"
            description={`Chosen from the sample set for sharing a travel mood or region with ${destination.name}.`}
            actions={
              <Button asChild variant="secondary">
                <Link to={DISCOVER.path}>
                  <Compass aria-hidden="true" />
                  Browse all destinations
                </Link>
              </Button>
            }
          />
        </Reveal>

        {pairing && partner ? (
          <Reveal className="mt-8 flex flex-col gap-3 rounded-xl border border-brand-200 bg-brand-soft p-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-body text-ink">
              <strong className="font-semibold">{pairing.title}.</strong>{' '}
              <span className="text-ink-secondary">{pairing.text}</span>
            </p>
            <Button asChild size="sm" className="shrink-0">
              <Link to={destinationPath(partner.slug)}>
                Explore {partner.name}
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          </Reveal>
        ) : null}

        {related.length > 0 ? (
          <RevealGroup
            as="ul"
            stagger="base"
            aria-label={`Destinations related to ${destination.name}`}
            className="mt-section-head grid grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-2 lg:grid-cols-3"
          >
            {related.map((d) => {
              const shared = d.categories.filter((c) => destination.categories.includes(c));
              return (
                <RevealItem as="li" key={d.slug}>
                  <DestinationCard
                    className="h-full"
                    name={d.name}
                    region={placeLine(d)}
                    description={d.description}
                    image={d.image}
                    sizes="(min-width: 1024px) 30vw, (min-width: 640px) 50vw, 100vw"
                    tags={(shared.length ? shared : d.categories).map((c) => moodBySlug[c].title)}
                    tagsLabel={shared.length ? 'Shared travel moods' : 'Travel moods'}
                    link={<Link to={destinationPath(d.slug)} />}
                  />
                </RevealItem>
              );
            })}
          </RevealGroup>
        ) : (
          <EmptyState
            className="mt-8"
            icon={<Compass />}
            title="No related sample destinations yet"
            description="Nothing else in the sample set shares a mood or region with this place. Browse the full collection instead."
            action={
              <Button asChild>
                <Link to={DISCOVER.path}>Browse all destinations</Link>
              </Button>
            }
          />
        )}
      </Container>
    </section>
  );
}

export interface DestinationDetailProps {
  destination: Destination;
  /** Service the visitor picked on the homepage (?mode=), listed first. */
  preferredService?: TravelCategorySlug;
}

/** /discover/:slug: one sample destination, its moods, travel options and related places. */
export function DestinationDetail({ destination, preferredService }: DestinationDetailProps) {
  return (
    <>
      <Hero destination={destination} />
      <About destination={destination} />
      <TravelOptions destination={destination} preferred={preferredService} />
      <div className="border-t border-line py-section-sm">
        <Container>
          <DestinationReviews slug={destination.slug} name={destination.name} />
        </Container>
      </div>
      <Related destination={destination} />
    </>
  );
}
