import { ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router';
import { Container, MediaFrame, PageHeader, cn, effects, interaction } from '@wayora/ui';
import { Reveal, RevealGroup, RevealItem } from '@wayora/ui/motion';
import { discoverPath } from '../discover/paths';
import { HOME_MOODS } from './content';

/**
 * "Explore by mood": four editorial entry points (inspiration, not inventory).
 * Each opens Discover filtered to that mood, scrolled to the results.
 * Desktop: staggered columns. Phones: a swipeable row with the next card
 * peeking, so it never overflows the page.
 */
export function MoodSection() {
  return (
    <section
      id="moods"
      aria-labelledby="moods-title"
      className="scroll-mt-(--header-offset) py-section"
    >
      <Container size="wide">
        <Reveal preset="sectionReveal">
          <PageHeader
            size="section"
            headingLevel="h2"
            id="moods-title"
            eyebrow="Explore by mood"
            title="Start with a feeling, not a place."
            description="Four ways into your next trip. Each one opens the sample destinations that match it in Discover."
          />
        </Reveal>
      </Container>

      <Container size="wide" className="mt-section-head">
        <RevealGroup
          as="ul"
          stagger="tight"
          aria-label="Travel moods"
          className={cn(
            '-mx-gutter flex snap-x snap-mandatory gap-4 overflow-x-auto px-gutter pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
            'md:mx-0 md:grid md:snap-none md:grid-cols-2 md:gap-6 md:overflow-visible md:px-0 md:pb-0',
            'lg:grid-cols-4 lg:gap-5',
          )}
        >
          {HOME_MOODS.map((mood, i) => (
            <RevealItem
              as="li"
              key={mood.slug}
              distance="lg"
              className={cn(
                'w-[78%] max-w-80 shrink-0 snap-start md:w-auto md:max-w-none',
                i % 2 === 1 && 'lg:mt-20',
              )}
            >
              <Link
                to={discoverPath({ mood: mood.slug }, { toResults: true })}
                aria-labelledby={`mood-${mood.slug}-title`}
                aria-describedby={`mood-${mood.slug}-line`}
                className="group flex flex-col gap-4 rounded-xl outline-offset-4"
              >
                <MediaFrame
                  aspect="3/4"
                  src={mood.image.src}
                  alt={mood.image.alt}
                  focalPoint={mood.image.focalPoint}
                  fallbackColor={mood.image.tone}
                  sizes="(min-width: 1024px) 25vw, (min-width: 768px) 50vw, 78vw"
                  className="rounded-xl"
                  imgClassName={effects.hoverZoom}
                />
                <div className="flex flex-col gap-1.5">
                  <span className="numeric text-caption text-ink-secondary">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <h3
                    id={`mood-${mood.slug}-title`}
                    className="flex items-center justify-between gap-3 text-heading-3"
                  >
                    {mood.title}
                    <ArrowUpRight
                      aria-hidden="true"
                      className={cn(
                        'size-5 shrink-0 text-brand',
                        interaction.iconNudge,
                        'group-hover:-translate-y-0.5 group-focus-visible:-translate-y-0.5',
                      )}
                    />
                  </h3>
                  <p id={`mood-${mood.slug}-line`} className="text-body-sm text-ink-secondary">
                    {mood.line}
                  </p>
                </div>
              </Link>
            </RevealItem>
          ))}
        </RevealGroup>
      </Container>
    </section>
  );
}
