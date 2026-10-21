import { Link } from 'react-router';
import type { DestinationSummary } from '@wayora/contracts';
import { Container, DestinationFeatureCard, PageHeader, cn } from '@wayora/ui';
import { Reveal } from '@wayora/ui/motion';
import { DISCOVER_PICKS } from './data';
import { placeLine } from './format';
import { destinationPath } from './paths';
import { findDestination } from './search';

/** Bento slots on large screens; phones get a swipeable row of portrait tiles. */
const slots = [
  'lg:col-span-7 lg:row-span-2 lg:min-h-[38rem]',
  'lg:col-span-5 lg:min-h-[18.5rem]',
  'lg:col-span-5 lg:min-h-[18.5rem]',
  'lg:col-span-4 lg:min-h-[24rem]',
  'lg:col-span-4 lg:min-h-[24rem]',
  'lg:col-span-4 lg:min-h-[24rem]',
] as const;

/** "Editor's picks": featured sample destinations, in the order set by DISCOVER_PICKS. */
export function FeaturedSection() {
  const picks = DISCOVER_PICKS.map((slug) => findDestination(slug))
    .filter((d): d is DestinationSummary => d !== undefined && d.featured)
    .slice(0, slots.length);
  if (picks.length === 0) return null;
  return (
    <section aria-labelledby="featured-title" className="py-section">
      <Container size="wide">
        <Reveal preset="sectionReveal">
          <PageHeader
            size="section"
            headingLevel="h2"
            id="featured-title"
            eyebrow="Editor's picks"
            title="Six places we'd start with."
            description="Chosen for variety: coast and mountains, old cities and green retreats. Editorial picks, not rankings or deals."
          />
        </Reveal>
        <ul
          aria-label="Editor's picks"
          className={cn(
            '-mx-gutter mt-section-head flex snap-x snap-mandatory gap-4 overflow-x-auto px-gutter pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
            'lg:mx-0 lg:grid lg:snap-none lg:grid-cols-12 lg:gap-5 lg:overflow-visible lg:px-0 lg:pb-0',
          )}
        >
          {picks.map((d, i) => (
            <Reveal
              as="li"
              key={d.slug}
              delay={(i % 3) * 0.08}
              distance="lg"
              className={cn(
                'flex aspect-[4/5] w-[82%] max-w-sm shrink-0 snap-start flex-col sm:w-[46%] lg:aspect-auto lg:w-auto lg:max-w-none',
                slots[i],
              )}
            >
              <DestinationFeatureCard
                className="flex-1"
                name={d.name}
                region={placeLine(d)}
                description={d.description}
                image={d.image}
                sizes={
                  i === 0 ? '(min-width: 1024px) 55vw, 82vw' : '(min-width: 1024px) 35vw, 82vw'
                }
                titleSize={i === 0 ? 'lg' : 'md'}
                cta={`Explore ${d.name}`}
                link={<Link to={destinationPath(d.slug)} />}
              />
            </Reveal>
          ))}
        </ul>
      </Container>
    </section>
  );
}
