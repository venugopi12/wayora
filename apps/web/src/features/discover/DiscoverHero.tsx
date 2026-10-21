import { ArrowUpRight, Search, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  Badge,
  Button,
  Container,
  DestinationImage,
  Eyebrow,
  IconButton,
  Input,
  cn,
} from '@wayora/ui';
import { ImageReveal, LineReveal, Reveal } from '@wayora/ui/motion';
import { findDestination } from './search';
import { destinationPath } from './paths';

/** Collage and suggestion picks: a spread of regions from the sample set. */
const COLLAGE = ['kyoto', 'bali', 'jaipur'] as const;
const SUGGESTIONS = ['kyoto', 'goa', 'bali', 'manali'] as const;

const collageLayout = [
  'col-span-7 row-span-2 rounded-2xl',
  'col-span-5 rounded-xl',
  'col-span-5 rounded-xl',
] as const;

export interface DiscoverHeroProps {
  query: string;
  /** Called with the trimmed query when the search is submitted. */
  onSearch: (query: string) => void;
}

/**
 * Discover hero: editorial headline, destination search over the SAMPLE
 * dataset, quick suggestions and a three-image collage. Search filters the
 * collection below (no API is called).
 */
export function DiscoverHero({ query, onSearch }: DiscoverHeroProps) {
  const [value, setValue] = useState(query);
  // Keep the field in step when the query changes elsewhere (chip removed, Back).
  const [syncedQuery, setSyncedQuery] = useState(query);
  if (query !== syncedQuery) {
    setSyncedQuery(query);
    setValue(query);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSearch(value.trim());
  }

  return (
    <section
      aria-labelledby="discover-title"
      className="relative isolate overflow-hidden bg-page pt-10 pb-section-sm sm:pt-14 lg:pt-20"
    >
      {/* Soft brand wash behind the collage. */}
      <div
        aria-hidden="true"
        className="absolute inset-y-0 right-0 -z-10 hidden w-1/2 bg-[radial-gradient(70%_60%_at_70%_40%,var(--color-brand-100),transparent_70%)] lg:block"
      />
      <Container
        size="wide"
        className="grid grid-cols-[minmax(0,1fr)] items-center gap-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-16"
      >
        <div className="flex flex-col gap-7">
          <Reveal trigger="mount" distance="sm">
            <Eyebrow>Discover</Eyebrow>
          </Reveal>
          <LineReveal
            id="discover-title"
            className="text-display max-w-[16ch]"
            lines={['Find the place that', 'feels like your', 'next story.']}
            delay={0.1}
          />
          <Reveal
            as="p"
            trigger="mount"
            delay={0.35}
            className="max-w-[34rem] text-body-lg text-ink-secondary"
          >
            Explore remarkable destinations, discover new perspectives, and start imagining your
            next journey.
          </Reveal>

          <Reveal trigger="mount" delay={0.45} className="flex max-w-[36rem] flex-col gap-3">
            <form
              id="discover-search"
              role="search"
              aria-label="Search sample destinations"
              onSubmit={submit}
              className="flex scroll-mt-(--header-offset) flex-col gap-2 sm:flex-row"
            >
              <label htmlFor="discover-query" className="sr-only">
                Destination
              </label>
              <Input
                id="discover-query"
                name="q"
                type="search"
                size="lg"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="Search by place, country or region"
                autoComplete="off"
                enterKeyHint="search"
                maxLength={80}
                aria-describedby="discover-query-hint"
                leading={<Search />}
                trailing={
                  value ? (
                    <IconButton
                      label="Clear search"
                      icon={<X />}
                      size="sm"
                      onClick={() => {
                        setValue('');
                        if (query) onSearch('');
                        document.getElementById('discover-query')?.focus();
                      }}
                    />
                  ) : null
                }
                className="w-full bg-card shadow-sm sm:flex-1 [&_input::-webkit-search-cancel-button]:hidden"
              />
              <Button type="submit" size="lg" className="shrink-0">
                Search
              </Button>
            </form>
            <p
              id="discover-query-hint"
              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-secondary"
            >
              <Badge size="sm" title="A small, curated demonstration set, not live inventory">
                Sample data
              </Badge>
              Twelve curated destinations. No prices or availability.
            </p>
          </Reveal>

          <Reveal trigger="mount" delay={0.55}>
            <nav aria-label="Suggested destinations" className="flex flex-wrap items-center gap-2">
              <span className="mr-1 text-caption text-ink-secondary">Try</span>
              {SUGGESTIONS.map((slug) => {
                const d = findDestination(slug);
                if (!d) return null;
                return (
                  <Link
                    key={slug}
                    to={destinationPath(slug)}
                    className="group inline-flex min-h-10 items-center gap-1 rounded-full border border-line bg-card px-3.5 text-body-sm font-semibold text-ink shadow-xs transition-colors duration-(--duration-fast) hover:border-brand-300 hover:bg-brand-50"
                  >
                    {d.name}
                    <ArrowUpRight
                      aria-hidden="true"
                      className="size-3.5 text-brand transition-transform duration-(--duration-base) group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                    />
                  </Link>
                );
              })}
            </nav>
          </Reveal>
        </div>

        {/* Decorative collage: the names are links elsewhere, so images are hidden from AT. */}
        <div aria-hidden="true" className="grid grid-cols-12 grid-rows-2 gap-3 sm:gap-4">
          {COLLAGE.map((slug, i) => {
            const d = findDestination(slug);
            return (
              <ImageReveal
                key={slug}
                delay={0.2 + i * 0.12}
                className={cn(
                  'relative overflow-hidden shadow-md',
                  collageLayout[i],
                  i === 0
                    ? 'aspect-[4/5] sm:aspect-auto sm:min-h-[26rem] lg:min-h-[32rem]'
                    : 'aspect-[4/3] sm:aspect-auto',
                )}
              >
                <DestinationImage
                  name={d?.name ?? slug}
                  image={d?.image ? { ...d.image, alt: '' } : undefined}
                  aspect="fill"
                  priority
                  zoomOnHover={false}
                />
                <span className="absolute bottom-3 left-3 rounded-full bg-deep/70 px-2.5 py-1 text-caption text-ink-inverse backdrop-blur-sm">
                  {d?.name}
                </span>
              </ImageReveal>
            );
          })}
        </div>
      </Container>
    </section>
  );
}
