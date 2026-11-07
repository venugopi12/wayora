import { Compass, MapPinOff } from 'lucide-react';
import { useEffect } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router';
import { travelCategorySlugSchema } from '@wayora/contracts';
import { Button, Container } from '@wayora/ui';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { DISCOVER } from '../navigation/config';
import { track } from '../../services/content';
import { destinationMeta, discoverMeta, notFoundMeta } from '../seo/pages';
import { siteUrl, usePageMeta } from '../seo/SeoProvider';
import { DiscoverEditorial } from './DiscoverEditorial';
import { Collection, COLLECTION_TITLE_ID } from './Collection';
import { DestinationDetail } from './DestinationDetail';
import { DiscoverCta } from './DiscoverCta';
import { DiscoverHero } from './DiscoverHero';
import { FeaturedSection } from './FeaturedSection';
import { InspirationSection } from './InspirationSection';
import { MoodPicker } from './MoodPicker';
import { RegionsSection } from './RegionsSection';
import { withDetails } from './details';
import { placeLine } from './format';
import { destinationPath } from './paths';
import { findDestination, suggestForSlug } from './search';
import { focusResults, useDiscoverFilters } from './useDiscoverFilters';

/**
 * /discover — destination discovery over the SAMPLE dataset.
 * Filters live in the URL: ?q=<text>&mood=<mood>&region=<region>.
 * Older links (?destination=<slug>) redirect to the destination's page.
 */
export function DiscoverRoute() {
  const [params] = useSearchParams();
  const { filters, setFilters, clearFilters } = useDiscoverFilters();
  useDocumentTitle('Discover');
  usePageMeta(discoverMeta(siteUrl()));

  const legacy = findDestination(params.get('destination') ?? undefined);
  if (legacy) return <Navigate to={destinationPath(legacy.slug)} replace />;

  return (
    <>
      <DiscoverHero
        query={filters.query ?? ''}
        onSearch={(query) => {
          setFilters({ query }, { push: true });
          // Let the results render, then bring them into view.
          requestAnimationFrame(() => focusResults(COLLECTION_TITLE_ID));
        }}
      />
      <MoodPicker selected={filters.mood} onSelect={(mood) => setFilters({ mood })} />
      <Collection filters={filters} onChange={setFilters} onClear={clearFilters} />
      <RegionsSection
        onBrowse={(region) => {
          setFilters({ region, mood: undefined, query: '' });
          requestAnimationFrame(() => focusResults(COLLECTION_TITLE_ID));
        }}
      />
      <DiscoverEditorial />
      <FeaturedSection />
      <InspirationSection />
      <DiscoverCta />
    </>
  );
}

/** /discover/:slug — one sample destination, or a helpful not-found state. */
export function DestinationRoute() {
  const { slug = '' } = useParams();
  const [params] = useSearchParams();
  const destination = withDetails(findDestination(slug));
  const mode = travelCategorySlugSchema.safeParse(params.get('mode'));
  useDocumentTitle(
    destination ? `${destination.name}, ${placeLine(destination)}` : 'Destination not found',
  );

  usePageMeta(
    destination ? destinationMeta(siteUrl(), destination) : notFoundMeta('Destination not found'),
  );
  const viewed = destination?.slug;
  useEffect(() => {
    if (viewed) track({ event: 'destination_view', key: viewed });
  }, [viewed]);

  if (!destination) return <DestinationNotFound slug={slug} />;
  return (
    <DestinationDetail
      key={destination.slug}
      destination={destination}
      preferredService={mode.success ? mode.data : undefined}
    />
  );
}

function DestinationNotFound({ slug }: { slug: string }) {
  const suggestions = suggestForSlug(slug);
  return (
    <Container size="narrow" className="py-section-sm">
      <div className="flex flex-col items-center gap-6 py-10 text-center">
        <span
          aria-hidden="true"
          className="grid size-14 place-items-center rounded-full bg-brand-soft text-brand-ink [&_svg]:size-7"
        >
          <MapPinOff />
        </span>
        <div className="flex max-w-prose flex-col gap-3">
          <h1 className="mx-auto max-w-[17ch] text-heading-1">
            We couldn&apos;t find that destination
          </h1>
          <p className="text-body-lg text-ink-secondary">
            There&apos;s no sample destination at “{slug}”. The Discover collection is a small,
            curated set for now, and more places will be added over time.
          </p>
        </div>
        {suggestions.length ? (
          <nav aria-label="Similar destinations" className="flex flex-col items-center gap-3">
            <p className="text-label text-ink">Did you mean</p>
            <ul className="flex flex-wrap justify-center gap-2">
              {suggestions.map((d) => (
                <li key={d.slug}>
                  <Button asChild variant="secondary" size="sm">
                    <Link to={destinationPath(d.slug)}>{d.name}</Link>
                  </Button>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        <Button asChild>
          <Link to={DISCOVER.path}>
            <Compass aria-hidden="true" />
            Browse all destinations
          </Link>
        </Button>
      </div>
    </Container>
  );
}

export { ThemeRoute, ThemesIndexRoute } from './ThemeRoutes';
