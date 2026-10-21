import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router';
import { BRAND_ROUTE_PATH, Container, MediaFrame, PageHeader, cn, interaction } from '@wayora/ui';
import { DrawPath, Reveal, RevealGroup, RevealItem } from '@wayora/ui/motion';
import { PAIRINGS } from './data';
import { destinationPath } from './paths';
import { findDestination } from './search';

/**
 * Travel inspiration: editorial ideas for pairing two sample destinations in
 * one trip. Copy describes the places, never journey times, fares or deals.
 */
export function InspirationSection() {
  const pairings = PAIRINGS.map((p) => ({
    ...p,
    places: p.stops.map((slug) => findDestination(slug)).filter((d) => d !== undefined),
  })).filter((p) => p.places.length === 2);
  if (pairings.length === 0) return null;

  return (
    <section
      id="inspiration"
      aria-labelledby="inspiration-title"
      className="scroll-mt-(--header-offset) bg-sunken py-section"
    >
      <Container size="wide">
        <Reveal preset="sectionReveal">
          <PageHeader
            size="section"
            headingLevel="h2"
            id="inspiration-title"
            eyebrow="Travel inspiration"
            title="Two places, one journey."
            description="Ideas for pairing a city with a slower stop. Open either destination to see how you could travel there."
          />
        </Reveal>
        <RevealGroup
          as="ul"
          stagger="base"
          aria-label="Trip ideas"
          className="mt-section-head grid grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-3"
        >
          {pairings.map((pairing) => {
            const [from, to] = pairing.places;
            return (
              <RevealItem
                as="li"
                key={pairing.title}
                className="flex flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-xs"
              >
                <div aria-hidden="true" className="relative grid grid-cols-2">
                  {[from, to].map((d) =>
                    d ? (
                      <MediaFrame
                        key={d.slug}
                        aspect="4/5"
                        src={d.image?.src ?? ''}
                        alt=""
                        focalPoint={d.image?.focalPoint}
                        fallbackColor={d.image?.tone}
                        sizes="(min-width: 768px) 16vw, 50vw"
                      />
                    ) : null,
                  )}
                  <span className="absolute top-1/2 left-1/2 grid size-14 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-card shadow-md">
                    <svg viewBox="0 0 32 32" className="size-9 text-brand" fill="none">
                      <DrawPath
                        d={BRAND_ROUTE_PATH}
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                      />
                      <circle cx="8" cy="10.5" r="2" fill="currentColor" />
                      <circle cx="24" cy="10.5" r="2" fill="currentColor" />
                    </svg>
                  </span>
                </div>
                <div className="flex flex-1 flex-col gap-3 p-6">
                  <h3 className="text-heading-3">{pairing.title}</h3>
                  <p className="text-body-sm text-ink-secondary">{pairing.text}</p>
                  <ul
                    aria-label={`Destinations in “${pairing.title}”`}
                    className="mt-auto flex flex-wrap items-center gap-x-1 gap-y-2 pt-3"
                  >
                    {[from, to].map((d, i) =>
                      d ? (
                        <li key={d.slug} className="flex items-center gap-1">
                          {i === 1 ? (
                            <span aria-hidden="true" className="px-1 text-ink-subtle">
                              then
                            </span>
                          ) : null}
                          <Link
                            to={destinationPath(d.slug)}
                            className="group inline-flex min-h-10 items-center gap-1 rounded-md px-1 text-label text-brand-ink hover:underline hover:underline-offset-4"
                          >
                            {d.name}
                            <ArrowRight
                              aria-hidden="true"
                              className={cn('size-4', interaction.iconNudge)}
                            />
                          </Link>
                        </li>
                      ) : null,
                    )}
                  </ul>
                </div>
              </RevealItem>
            );
          })}
        </RevealGroup>
      </Container>
    </section>
  );
}
