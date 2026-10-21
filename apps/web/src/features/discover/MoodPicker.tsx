import { Check } from 'lucide-react';
import type { TravelMoodSlug } from '@wayora/contracts';
import { Container, MediaFrame, PageHeader, cn, effects } from '@wayora/ui';
import { Reveal, RevealGroup, RevealItem } from '@wayora/ui/motion';
import { DESTINATIONS, MOODS } from './data';

const countFor = (slug: TravelMoodSlug) =>
  DESTINATIONS.filter((d) => d.categories.includes(slug)).length;

export interface MoodPickerProps {
  selected?: TravelMoodSlug;
  onSelect: (mood: TravelMoodSlug | undefined) => void;
}

/**
 * "Explore by travel mood": six themed tiles that act as toggle buttons
 * (aria-pressed). Choosing one filters the collection directly below; choosing
 * it again clears the filter. Phones get a swipeable row, wider screens a grid.
 */
export function MoodPicker({ selected, onSelect }: MoodPickerProps) {
  return (
    <section aria-labelledby="moods-title" className="py-section-sm">
      <Container size="wide">
        <Reveal preset="sectionReveal">
          <PageHeader
            size="section"
            headingLevel="h2"
            id="moods-title"
            eyebrow="Explore by travel mood"
            title="Start with how you want it to feel."
            description="Pick a mood to filter the collection below. Pick it again to see everything."
          />
        </Reveal>
        <RevealGroup
          as="ul"
          stagger="tight"
          aria-label="Travel moods"
          className={cn(
            '-mx-gutter mt-section-head flex snap-x snap-mandatory gap-3 overflow-x-auto px-gutter pt-1 pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
            'md:mx-0 md:grid md:grid-cols-3 md:gap-4 md:overflow-visible md:px-0 md:pb-1 xl:grid-cols-6',
          )}
        >
          {MOODS.map((mood) => {
            const active = selected === mood.slug;
            const count = countFor(mood.slug);
            return (
              <RevealItem
                as="li"
                key={mood.slug}
                className="w-[62%] max-w-60 shrink-0 snap-start sm:w-[40%] md:w-auto md:max-w-none"
              >
                <button
                  type="button"
                  aria-pressed={active}
                  aria-labelledby={`mood-${mood.slug}-name`}
                  aria-describedby={`mood-${mood.slug}-line mood-${mood.slug}-count`}
                  onClick={() => onSelect(active ? undefined : mood.slug)}
                  className={cn(
                    'group relative flex w-full flex-col overflow-hidden rounded-xl border bg-card text-start shadow-xs outline-offset-4',
                    'transition-[border-color,box-shadow,transform] duration-(--duration-base) ease-emphasized hover:-translate-y-0.5 hover:shadow-md active:scale-[0.99]',
                    active
                      ? 'border-brand ring-2 ring-brand'
                      : 'border-line hover:border-brand-200',
                  )}
                >
                  <MediaFrame
                    aspect="4/5"
                    src={mood.image.src}
                    alt=""
                    focalPoint={mood.image.focalPoint}
                    fallbackColor={mood.image.tone}
                    sizes="(min-width: 1280px) 16vw, (min-width: 768px) 33vw, 62vw"
                    imgClassName={effects.hoverZoom}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'absolute top-3 right-3 grid size-7 place-items-center rounded-full bg-brand text-ink-inverse shadow-sm transition-[opacity,transform] duration-(--duration-base) ease-emphasized',
                        active ? 'scale-100 opacity-100' : 'scale-75 opacity-0',
                      )}
                    >
                      <Check className="size-4" strokeWidth={2.5} />
                    </span>
                  </MediaFrame>
                  <span
                    aria-hidden="true"
                    className="h-1 w-full"
                    style={{ backgroundColor: mood.accent }}
                  />
                  <span className="flex flex-1 flex-col gap-1 p-4">
                    <span id={`mood-${mood.slug}-name`} className="text-title">
                      {mood.title}
                    </span>
                    <span id={`mood-${mood.slug}-line`} className="text-body-sm text-ink-secondary">
                      {mood.line}
                    </span>
                    <span
                      id={`mood-${mood.slug}-count`}
                      className="mt-auto pt-2 text-caption text-brand-ink"
                    >
                      {count} {count === 1 ? 'destination' : 'destinations'}
                    </span>
                  </span>
                </button>
              </RevealItem>
            );
          })}
        </RevealGroup>
      </Container>
    </section>
  );
}
