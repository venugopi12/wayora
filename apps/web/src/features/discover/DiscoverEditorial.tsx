import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router';
import { Button, Container, PageHeader } from '@wayora/ui';
import { getPopularDestinations, listPublishedContent } from '../../services/content';
import { DestinationGrid } from '../content/DestinationGrid';
import { contentKeys } from '../content/keys';
import { ContentCard } from '../content/routes';
import { GUIDES_PATH, THEMES_PATH } from '../seo/pages';
import { ThemeLinks } from './ThemeRoutes';

/*
 * Discover additions (Phase 29). Each section says what it's based on:
 * "Most viewed" comes from first-party page-view counts and is hidden
 * until there's enough data; collections and guides are editorial (CMS);
 * themes are editorial groupings. Nothing here is a ranking of quality.
 */

export function MostViewed() {
  const query = useQuery({
    queryKey: contentKeys.popular,
    queryFn: ({ signal }) => getPopularDestinations(signal),
  });
  const data = query.data;
  if (!data || data.items.length === 0) return null;
  return (
    <section aria-labelledby="most-viewed-title" className="border-t border-line py-section-sm">
      <Container size="wide" className="flex flex-col gap-section-head">
        <PageHeader
          size="section"
          headingLevel="h2"
          id="most-viewed-title"
          eyebrow="Based on page views"
          title="Most viewed on Wayora"
          description={`Destination pages people opened most in the last ${data.days} days (each at least ${data.minimumViews} times). A count of page views, not a rating or a recommendation.`}
        />
        <DestinationGrid slugs={data.items.map((i) => i.slug)} />
      </Container>
    </section>
  );
}

function Collections() {
  const params = { type: 'collection' as const, pageSize: 6 };
  const query = useQuery({
    queryKey: contentKeys.list(params),
    queryFn: ({ signal }) => listPublishedContent(params, signal),
  });
  const items = query.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        size="section"
        headingLevel="h2"
        id="collections-title"
        eyebrow="Editorial"
        title="Collections"
        description="Destinations grouped by the Wayora team around an idea."
      />
      <ul aria-labelledby="collections-title" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((c) => (
          <li key={c.slug} className="min-w-0">
            <ContentCard item={c} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function LatestGuides() {
  const params = { type: 'guides' as const, pageSize: 3 };
  const query = useQuery({
    queryKey: contentKeys.list(params),
    queryFn: ({ signal }) => listPublishedContent(params, signal),
  });
  const items = query.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        size="section"
        headingLevel="h2"
        id="latest-guides-title"
        eyebrow="Editorial"
        title="Latest guides"
        actions={
          <Button asChild variant="secondary">
            <Link to={GUIDES_PATH}>
              All guides
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        }
      />
      <ul
        aria-labelledby="latest-guides-title"
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        {items.map((c) => (
          <li key={c.slug} className="min-w-0">
            <ContentCard item={c} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DiscoverEditorial() {
  return (
    <>
      <MostViewed />
      <section
        aria-label="Guides, collections and themes"
        className="border-t border-line py-section-sm"
      >
        <Container size="wide" className="flex flex-col gap-12">
          <LatestGuides />
          <Collections />
          <div className="flex flex-col gap-4">
            <PageHeader
              size="section"
              headingLevel="h2"
              id="themes-title"
              eyebrow="Editorial groupings"
              title="Browse by theme"
              actions={
                <Button asChild variant="secondary">
                  <Link to={THEMES_PATH}>
                    All themes
                    <ArrowRight aria-hidden="true" />
                  </Link>
                </Button>
              }
            />
            <ThemeLinks />
          </div>
        </Container>
      </section>
    </>
  );
}
