import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router';
import { Container, DestinationFeatureCard, PageHeader, cn, interaction } from '@wayora/ui';
import { Parallax, Reveal } from '@wayora/ui/motion';
import type { DestinationSummary } from '@wayora/contracts';
import { placeLine } from '../discover/format';
import { destinationPath } from '../discover/paths';
import { DISCOVER } from '../navigation/config';
import { FEATURED_DESTINATIONS } from './content';

type Layout = 'lead' | 'stack' | 'panorama';

const layoutClasses: Record<Layout, string> = {
  lead: 'aspect-[4/5] sm:aspect-[4/3] lg:col-span-7 lg:row-span-2 lg:aspect-auto lg:min-h-[40rem]',
  stack: 'aspect-[4/5] sm:aspect-[4/3] lg:col-span-5 lg:aspect-auto lg:min-h-[19.5rem]',
  panorama: 'aspect-[4/5] sm:aspect-[16/9] lg:col-span-12 lg:aspect-[21/8]',
};

const layoutFor = (index: number): Layout =>
  index === 0 ? 'lead' : index === 3 ? 'panorama' : 'stack';

function DestinationTile({
  destination,
  layout,
  index,
}: {
  destination: DestinationSummary;
  layout: Layout;
  index: number;
}) {
  return (
    <Reveal
      as="li"
      delay={(index % 3) * 0.08}
      distance="lg"
      className={cn('flex flex-col', layoutClasses[layout])}
    >
      <DestinationFeatureCard
        className="flex-1"
        name={destination.name}
        region={placeLine(destination)}
        description={destination.description}
        image={destination.image}
        sizes={layout === 'panorama' ? '100vw' : '(min-width: 1024px) 58vw, 100vw'}
        titleSize={layout === 'lead' ? 'lg' : 'md'}
        cta={`Explore ${destination.name}`}
        link={<Link to={destinationPath(destination.slug)} />}
        renderMedia={(media) => (
          <Parallax offset={5} className="absolute inset-x-0 -top-[6%] -bottom-[6%]">
            {media}
          </Parallax>
        )}
      />
    </Reveal>
  );
}

/**
 * Featured destinations: four SAMPLE destinations (no prices, ratings or
 * deals), each linking to its Discover page.
 */
export function DestinationsSection() {
  return (
    <section
      id="destinations"
      aria-labelledby="destinations-title"
      className="scroll-mt-(--header-offset) pb-section"
    >
      <Container size="wide">
        <Reveal preset="sectionReveal">
          <PageHeader
            size="section"
            headingLevel="h2"
            id="destinations-title"
            eyebrow="Featured destinations"
            title="Four places worth the journey."
            description="A small, curated set of examples to show where Wayora is heading. No prices or deals, just places to begin."
            actions={
              <Link
                to={DISCOVER.path}
                className="group inline-flex shrink-0 items-center gap-1.5 rounded-md text-label text-brand-ink hover:underline hover:underline-offset-4"
              >
                All destination ideas
                <ArrowRight aria-hidden="true" className={cn('size-4', interaction.iconNudge)} />
              </Link>
            }
          />
        </Reveal>
        <ul
          aria-label="Featured destinations"
          className="mt-section-head grid gap-4 sm:gap-5 lg:grid-cols-12"
        >
          {FEATURED_DESTINATIONS.map((d, i) => (
            <DestinationTile key={d.slug} destination={d} layout={layoutFor(i)} index={i} />
          ))}
        </ul>
      </Container>
    </section>
  );
}
