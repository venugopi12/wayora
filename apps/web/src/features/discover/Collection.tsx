import { ChevronDown, MapPinned, SearchX, X } from 'lucide-react';
import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Link } from 'react-router';
import type { DestinationSummary, DestinationRegion } from '@wayora/contracts';
import { Badge, Button, Container, DestinationCard, EmptyState, Eyebrow, cn } from '@wayora/ui';
import { Reveal, transitions } from '@wayora/ui/motion';
import { DESTINATIONS, REGIONS, moodBySlug, regionBySlug } from './data';
import { placeLine } from './format';
import { COLLECTION_ID, destinationPath } from './paths';
import { filterDestinations, hasActiveFilters, type DestinationFilters } from './search';

export const COLLECTION_TITLE_ID = 'collection-title';

export function describeResults(count: number, { query, mood, region }: DestinationFilters) {
  if (!hasActiveFilters({ query, mood, region }))
    return `Showing all ${count} sample destinations.`;
  let text = `${count} sample ${count === 1 ? 'destination' : 'destinations'}`;
  if (query) text += ` matching “${query}”`;
  if (mood) text += ` for ${moodBySlug[mood].title.toLowerCase()}`;
  if (region) text += ` in ${regionBySlug[region].name}`;
  return `${text}.`;
}

/** Phones show this many results until "Show all" is pressed; larger screens show all. */
export const MOBILE_PREVIEW = 6;

/** Wider "split" card every fifth result on larger screens, so the grid has a rhythm. */
const isWide = (index: number, total: number) => index % 5 === 0 && total > 2;

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter: ${label}`}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-brand-200 bg-brand-soft pr-2 pl-3 text-body-sm font-semibold text-brand-ink transition-colors duration-(--duration-fast) hover:border-brand-300 hover:bg-brand-100"
      >
        {label}
        <X aria-hidden="true" className="size-4" />
      </button>
    </li>
  );
}

function ResultCard({ destination, wide }: { destination: DestinationSummary; wide: boolean }) {
  return (
    <DestinationCard
      className="h-full"
      name={destination.name}
      region={placeLine(destination)}
      description={destination.description}
      image={destination.image}
      sizes={
        wide
          ? '(min-width: 1024px) 26vw, (min-width: 640px) 40vw, 100vw'
          : '(min-width: 1024px) 30vw, (min-width: 640px) 50vw, 100vw'
      }
      tags={destination.categories.map((c) => moodBySlug[c].title)}
      tagsLabel="Travel moods"
      featured={destination.featured ? "Editor's pick" : undefined}
      layout={wide ? 'split' : 'stacked'}
      link={<Link to={destinationPath(destination.slug)} />}
    />
  );
}

export interface CollectionProps {
  filters: DestinationFilters;
  onChange: (next: Partial<DestinationFilters>) => void;
  onClear: () => void;
  /** Dataset to browse. Defaults to the bundled sample destinations. */
  source?: readonly DestinationSummary[];
}

/**
 * The collection: every SAMPLE destination, narrowed by the search, mood and
 * region filters. The result count is announced politely as filters change.
 */
export function Collection({ filters, onChange, onClear, source = DESTINATIONS }: CollectionProps) {
  const results = filterDestinations(filters, source);
  const [expanded, setExpanded] = useState(false);
  const collapsible = !expanded && results.length > MOBILE_PREVIEW + 2;
  const { query, mood, region } = filters;
  const active = hasActiveFilters(filters);
  const regionCount = (slug?: DestinationRegion) =>
    filterDestinations({ query, mood, region: slug }, source).length;
  const regionIsEmpty = region !== undefined && source.every((d) => d.region !== region);

  return (
    <section
      id={COLLECTION_ID}
      aria-labelledby={COLLECTION_TITLE_ID}
      className="scroll-mt-(--header-offset) border-t border-line bg-card py-section-sm"
    >
      <Container size="wide">
        <Reveal preset="fadeUp" distance="sm" className="flex flex-col gap-6">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div className="flex flex-col gap-3">
              <Eyebrow>The collection</Eyebrow>
              <h2
                id={COLLECTION_TITLE_ID}
                tabIndex={-1}
                className="text-heading-1 outline-none focus-visible:outline-none"
              >
                Places to begin with.
              </h2>
            </div>
            <Badge size="md" className="self-start md:self-auto">
              Sample data · no prices or availability
            </Badge>
          </div>

          <div
            role="group"
            aria-label="Filter by region"
            className="-mx-gutter flex gap-2 overflow-x-auto px-gutter pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden"
          >
            {[{ slug: undefined, name: 'All regions' }, ...REGIONS].map((r) => {
              const pressed = region === r.slug;
              return (
                <button
                  key={r.name}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => onChange({ region: r.slug })}
                  className={cn(
                    'inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-4 text-body-sm font-semibold transition-colors duration-(--duration-fast)',
                    pressed
                      ? 'border-brand bg-brand text-ink-inverse'
                      : 'border-line bg-page text-ink hover:border-brand-300 hover:bg-brand-50',
                  )}
                >
                  {r.name}
                  <span
                    className={cn(
                      'numeric rounded-full px-1.5 text-caption',
                      pressed ? 'bg-white/20' : 'bg-sunken text-ink-secondary',
                    )}
                  >
                    {regionCount(r.slug)}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
            <p role="status" className="text-body text-ink-secondary">
              {describeResults(results.length, filters)}
            </p>
            {active ? (
              <div className="flex flex-wrap items-center gap-2">
                <ul aria-label="Active filters" className="flex flex-wrap gap-2">
                  {query ? (
                    <FilterChip label={`“${query}”`} onRemove={() => onChange({ query: '' })} />
                  ) : null}
                  {mood ? (
                    <FilterChip
                      label={moodBySlug[mood].title}
                      onRemove={() => onChange({ mood: undefined })}
                    />
                  ) : null}
                  {region ? (
                    <FilterChip
                      label={regionBySlug[region].name}
                      onRemove={() => onChange({ region: undefined })}
                    />
                  ) : null}
                </ul>
                <Button variant="ghost" size="sm" onClick={onClear}>
                  Clear all
                </Button>
              </div>
            ) : null}
          </div>
        </Reveal>

        {results.length > 0 ? (
          <ul
            aria-label="Sample destinations"
            className="mt-8 grid grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-2 lg:grid-cols-3"
          >
            <AnimatePresence initial={false} mode="popLayout">
              {results.map((d, i) => {
                const wide = isWide(i, results.length);
                return (
                  <motion.li
                    key={d.slug}
                    layout="position"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={transitions.standard}
                    className={cn(
                      wide && 'sm:col-span-2',
                      collapsible && i >= MOBILE_PREVIEW && 'max-sm:hidden',
                    )}
                  >
                    <ResultCard destination={d} wide={wide} />
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        ) : null}
        {results.length > 0 && collapsible ? (
          <div className="mt-6 flex justify-center sm:hidden">
            <Button
              variant="secondary"
              fullWidth
              trailingIcon={<ChevronDown aria-hidden="true" />}
              onClick={() => {
                setExpanded(true);
                // Move focus to the first newly shown destination.
                requestAnimationFrame(() => {
                  const links = document.querySelectorAll<HTMLAnchorElement>(
                    `#${COLLECTION_ID} li a`,
                  );
                  links[MOBILE_PREVIEW]?.focus();
                });
              }}
            >
              Show all {results.length} destinations
            </Button>
          </div>
        ) : null}
        {results.length > 0 ? null : regionIsEmpty ? (
          <EmptyState
            size="page"
            icon={<MapPinned />}
            title={`No sample destinations in ${regionBySlug[region].name} yet`}
            description="More destinations will be added to this region later. Try another region in the meantime."
            action={
              <Button onClick={() => onChange({ region: undefined })}>Show all regions</Button>
            }
          />
        ) : (
          <EmptyState
            size="page"
            icon={<SearchX />}
            title="No sample destinations match"
            description={
              <>
                The sample set is small, so try fewer filters
                {query ? ', a shorter search, or a country or region name' : ''}.
              </>
            }
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {query ? (
                  <Button variant="secondary" size="sm" onClick={() => onChange({ query: '' })}>
                    Remove “{query}”
                  </Button>
                ) : null}
                {mood ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onChange({ mood: undefined })}
                  >
                    Any mood
                  </Button>
                ) : null}
                {region ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onChange({ region: undefined })}
                  >
                    All regions
                  </Button>
                ) : null}
                <Button size="sm" onClick={onClear}>
                  Clear all filters
                </Button>
              </div>
            }
          />
        )}
      </Container>
    </section>
  );
}
