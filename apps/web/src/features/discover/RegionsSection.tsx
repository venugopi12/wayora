import { ArrowDown } from 'lucide-react';
import { Link } from 'react-router';
import type { DestinationSummary, DestinationRegion } from '@wayora/contracts';
import { Button, Container, MediaFrame, PageHeader } from '@wayora/ui';
import { Reveal, RevealGroup, RevealItem } from '@wayora/ui/motion';
import { DESTINATIONS, REGIONS } from './data';
import { destinationPath } from './paths';

export interface RegionsSectionProps {
  /** Filter the collection to a region and bring it into view. */
  onBrowse: (region: DestinationRegion) => void;
  source?: readonly DestinationSummary[];
}

/**
 * "Browse by region": one panel per region with its sample destinations and a
 * shortcut that filters the collection. No map dependency: names and images
 * carry the geography. Regions without sample content say so.
 */
export function RegionsSection({ onBrowse, source = DESTINATIONS }: RegionsSectionProps) {
  return (
    <section
      aria-labelledby="regions-title"
      className="bg-deep py-section text-ink-inverse focus-ring-inverse"
    >
      <Container size="wide">
        <Reveal preset="sectionReveal">
          <PageHeader
            size="section"
            headingLevel="h2"
            tone="inverse"
            id="regions-title"
            eyebrow="Browse by region"
            title="Four corners of the map, one starting point."
            description="Each region holds a few sample destinations for now. Choose one to see them in the collection."
          />
        </Reveal>
        <RevealGroup
          as="ul"
          stagger="base"
          aria-label="Regions"
          className="mt-section-head grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2 lg:gap-5"
        >
          {REGIONS.map((region, i) => {
            const places = source.filter((d) => d.region === region.slug);
            const headingId = `region-${region.slug}-title`;
            return (
              <RevealItem
                as="li"
                key={region.slug}
                className="flex flex-col gap-6 rounded-2xl border border-line-inverse bg-deep-raised p-6 sm:p-8"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex flex-col gap-2">
                    <span className="numeric text-caption text-brand-200">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <h3 id={headingId} className="text-heading-2">
                      {region.name}
                    </h3>
                    <p className="max-w-md text-body text-ink-inverse-secondary">{region.line}</p>
                  </div>
                  {places.length ? (
                    <div aria-hidden="true" className="flex shrink-0 -space-x-3">
                      {places
                        .slice(0, 3)
                        .map((d) =>
                          d.image ? (
                            <MediaFrame
                              key={d.slug}
                              aspect="1/1"
                              src={d.image.src}
                              alt=""
                              focalPoint={d.image.focalPoint}
                              fallbackColor={d.image.tone}
                              sizes="56px"
                              className="size-12 rounded-full ring-2 ring-deep-raised sm:size-14"
                            />
                          ) : null,
                        )}
                    </div>
                  ) : null}
                </div>

                {places.length ? (
                  <>
                    <ul
                      aria-label={`Sample destinations in ${region.name}`}
                      className="flex flex-wrap gap-2"
                    >
                      {places.map((d) => (
                        <li key={d.slug}>
                          <Link
                            to={destinationPath(d.slug)}
                            className="inline-flex min-h-10 items-center rounded-full border border-white/20 px-4 text-body-sm font-semibold text-ink-inverse transition-colors duration-(--duration-fast) hover:border-white/50 hover:bg-white/10"
                          >
                            {d.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                    <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-line-inverse pt-5">
                      <p className="text-body-sm text-ink-inverse-secondary">
                        {places.length} sample{' '}
                        {places.length === 1 ? 'destination' : 'destinations'}
                      </p>
                      <Button
                        variant="outline-inverse"
                        size="sm"
                        onClick={() => onBrowse(region.slug)}
                      >
                        Show in the collection
                        <span className="sr-only">: {region.name}</span>
                        <ArrowDown aria-hidden="true" />
                      </Button>
                    </div>
                  </>
                ) : (
                  <p className="mt-auto border-t border-line-inverse pt-5 text-body-sm text-ink-inverse-secondary">
                    No sample destinations here yet. More destinations will be added to this region
                    later.
                  </p>
                )}
              </RevealItem>
            );
          })}
        </RevealGroup>
      </Container>
    </section>
  );
}
