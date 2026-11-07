import { useQuery } from '@tanstack/react-query';
import { BookOpen, Clock, RotateCw } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useParams } from 'react-router';
import { CONTENT_TYPE_LABEL, type PublicContent } from '@wayora/contracts';
import {
  Badge,
  Breadcrumbs,
  Button,
  Card,
  Container,
  EmptyState,
  ErrorState,
  Skeleton,
  type BreadcrumbItem,
} from '@wayora/ui';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { NotFoundRoute } from '../../routes/NotFoundRoute';
import { ApiClientError } from '../../lib/api-client';
import {
  getPublishedContent,
  listPublishedContent,
  track,
  type ContentSection,
} from '../../services/content';
import { contentMeta, guidesIndexMeta, GUIDES_PATH, notFoundMeta } from '../seo/pages';
import { siteUrl, usePageMeta } from '../seo/SeoProvider';
import { ContentBody } from './ContentBody';
import { DestinationGrid } from './DestinationGrid';
import { contentKeys } from './keys';
import { ShareButton } from './ShareButton';

/*
 * Published editorial content (Phase 29, docs/seo.md#content-pages):
 * /guides, /guides/:slug (guides, articles, tips), /collections/:slug and
 * /explore/:slug (landing pages). Everything shown comes from the CMS; the
 * prerendered HTML for these URLs is built from the same data.
 */

const dateFmt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'long' });
const formatDate = (iso: string) => dateFmt.format(new Date(iso));

function Loading({ label }: { label: string }) {
  return (
    <Container className="py-section-sm">
      <div role="status" aria-label={label} className="flex max-w-prose flex-col gap-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </Container>
  );
}

function LoadError({
  onRetry,
  busy,
  requestId,
}: {
  onRetry: () => void;
  busy: boolean;
  requestId?: string | null;
}) {
  return (
    <Container size="narrow" className="py-section-sm">
      <h1 className="sr-only">Content</h1>
      <ErrorState
        title="We couldn't load this page"
        description="Check your connection, then try again."
        reference={requestId ?? undefined}
        action={
          <Button variant="secondary" onClick={onRetry} loading={busy}>
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
        }
      />
    </Container>
  );
}

function crumbsFor(c: PublicContent): BreadcrumbItem[] {
  const section: BreadcrumbItem =
    c.type === 'collection' || c.type === 'landing'
      ? { label: 'Discover', link: <Link to="/discover" /> }
      : { label: 'Guides', link: <Link to={GUIDES_PATH} /> };
  return [{ label: 'Home', link: <Link to="/" /> }, section, { label: c.title }];
}

function Byline({ c }: { c: PublicContent }) {
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm text-ink-secondary">
      <span>By {c.author}, Wayora team</span>
      <span aria-hidden="true">·</span>
      <span>
        Published <time dateTime={c.publishedAt}>{formatDate(c.publishedAt)}</time>
      </span>
      {c.updatedAt !== c.publishedAt ? (
        <>
          <span aria-hidden="true">·</span>
          <span>
            Updated <time dateTime={c.updatedAt}>{formatDate(c.updatedAt)}</time>
          </span>
        </>
      ) : null}
      {c.readingMinutes ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1">
            <Clock className="size-4" aria-hidden="true" />
            {c.readingMinutes} min read
          </span>
        </>
      ) : null}
    </p>
  );
}

/** The page body for any published entry; also the admin preview. */
export function ContentView({
  content: c,
  preview = false,
}: {
  content: PublicContent;
  preview?: boolean;
}) {
  // Counts clicks out of this page (the key is this entry's slug), never where to.
  const linkClick = preview ? undefined : () => track({ event: 'content_link_click', key: c.slug });
  return (
    <article aria-labelledby="content-title" className="flex flex-col gap-8">
      <header className="flex max-w-prose flex-col gap-3">
        <Badge tone="brand" className="self-start">
          {CONTENT_TYPE_LABEL[c.type]}
        </Badge>
        <h1 id="content-title" className="text-heading-1">
          {c.title}
        </h1>
        {c.summary ? <p className="text-body-lg text-ink-secondary">{c.summary}</p> : null}
        <Byline c={c} />
        {!preview && c.path ? <ShareButton title={c.title} path={c.path} /> : null}
      </header>
      {c.cover ? (
        <img
          src={c.cover.src}
          alt={c.cover.alt}
          width={c.cover.width}
          height={c.cover.height}
          fetchPriority="high"
          className="h-auto max-h-[32rem] w-full rounded-xl object-cover"
        />
      ) : null}
      {c.body.length ? (
        <div className="max-w-prose">
          <ContentBody blocks={c.body} />
        </div>
      ) : null}
      {c.destinations.length ? (
        <section aria-labelledby="content-destinations" className="flex flex-col gap-4">
          <h2 id="content-destinations" className="text-heading-2">
            {c.type === 'collection' ? 'In this collection' : 'Destinations'}
          </h2>
          <DestinationGrid slugs={c.destinations} {...(linkClick ? { onOpen: linkClick } : {})} />
        </section>
      ) : null}
      {c.related.length ? (
        <section
          aria-labelledby="content-related"
          className="flex flex-col gap-4 border-t border-line pt-6"
        >
          <h2 id="content-related" className="text-heading-3">
            {c.type === 'collection' ? 'Guides in this collection' : 'Related reading'}
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {c.related.map((r) => (
              <li key={r.slug} className="min-w-0">
                {r.path ? (
                  <Link
                    to={r.path}
                    onClick={linkClick}
                    className="flex h-full flex-col gap-1 rounded-lg border border-line bg-card p-4 hover:border-brand-300"
                  >
                    <span className="text-caption text-ink-secondary">
                      {CONTENT_TYPE_LABEL[r.type]}
                    </span>
                    <span className="text-title text-ink">{r.title}</span>
                    {r.summary ? (
                      <span className="text-body-sm text-ink-secondary">{r.summary}</span>
                    ) : null}
                  </Link>
                ) : (
                  <span>{r.title}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}

function useEntry(section: ContentSection, slug: string) {
  return useQuery({
    queryKey: contentKeys.entry(section, slug),
    queryFn: ({ signal }) => getPublishedContent(section, slug, signal),
    retry: (count, e) => !(e instanceof ApiClientError && e.status === 404) && count < 2,
  });
}

function EntryRoute({ section }: { section: ContentSection }) {
  const { slug = '' } = useParams();
  const query = useEntry(section, slug);
  const notFound =
    query.isError && query.error instanceof ApiClientError && query.error.status === 404;
  usePageMeta(query.data ? contentMeta(siteUrl(), query.data) : notFound ? notFoundMeta() : null);
  useDocumentTitle(query.data ? query.data.title : notFound ? 'Page not found' : 'Loading');
  useEffect(() => {
    if (query.data) track({ event: 'content_view', key: query.data.slug });
  }, [query.data]);

  if (query.isPending) return <Loading label="Loading the page" />;
  if (query.isError) {
    if (notFound) return <NotFoundRoute />;
    const api = query.error instanceof ApiClientError ? query.error : null;
    return (
      <LoadError
        onRetry={() => void query.refetch()}
        busy={query.isFetching}
        requestId={api?.requestId}
      />
    );
  }
  return (
    <Container className="flex flex-col gap-8 py-section-sm">
      <Breadcrumbs items={crumbsFor(query.data)} />
      <ContentView content={query.data} />
    </Container>
  );
}

export const GuideRoute = () => <EntryRoute section="guides" />;
export const CollectionRoute = () => <EntryRoute section="collections" />;
export const LandingRoute = () => <EntryRoute section="explore" />;

/** /guides — every published guide, article and tip, newest first. */
export function GuidesRoute() {
  const query = useQuery({
    queryKey: contentKeys.list({ type: 'guides', pageSize: 50 }),
    queryFn: ({ signal }) => listPublishedContent({ type: 'guides', pageSize: 50 }, signal),
  });
  const empty = query.data?.items.length === 0;
  // An empty index isn't worth indexing; the sitemap leaves it out too.
  usePageMeta(
    query.data
      ? empty
        ? { ...guidesIndexMeta(siteUrl()), robots: 'noindex, follow' }
        : guidesIndexMeta(siteUrl())
      : null,
  );
  useDocumentTitle('Travel guides and articles');

  return (
    <Container className="flex flex-col gap-8 py-section-sm">
      <Breadcrumbs items={[{ label: 'Home', link: <Link to="/" /> }, { label: 'Guides' }]} />
      <header className="flex max-w-prose flex-col gap-2">
        <h1 className="text-heading-1">Travel guides and articles</h1>
        <p className="text-body-lg text-ink-secondary">
          Written and reviewed by the Wayora team. Provider rules, prices and opening times can
          change, so check them with the provider before you travel.
        </p>
      </header>
      {query.isPending ? (
        <div
          role="status"
          aria-label="Loading guides"
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState
          title="We couldn't load the guides"
          description="Check your connection, then try again."
          action={
            <Button
              variant="secondary"
              onClick={() => void query.refetch()}
              loading={query.isFetching}
            >
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          }
        />
      ) : empty ? (
        <EmptyState
          icon={<BookOpen />}
          title="No guides yet"
          description="The first guides are being written. Meanwhile, browse destinations."
          action={
            <Button asChild>
              <Link to="/discover">Browse destinations</Link>
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {query.data.items.map((g) => (
            <li key={g.slug} className="min-w-0">
              <ContentCard item={g} />
            </li>
          ))}
        </ul>
      )}
    </Container>
  );
}

export function ContentCard({ item }: { item: Omit<PublicContent, 'body'> }) {
  if (!item.path) return null;
  return (
    <Card padding="none" className="h-full overflow-hidden">
      <Link to={item.path} className="flex h-full flex-col hover:bg-sunken/60">
        {item.cover ? (
          <img
            src={item.cover.src}
            alt=""
            width={item.cover.width}
            height={item.cover.height}
            loading="lazy"
            decoding="async"
            className="aspect-[4/3] h-auto w-full object-cover"
          />
        ) : null}
        <span className="flex flex-col gap-1.5 p-4">
          <span className="text-caption text-ink-secondary">
            {CONTENT_TYPE_LABEL[item.type]}
            {item.readingMinutes ? ` · ${item.readingMinutes} min read` : ''}
          </span>
          <span className="text-title text-ink">{item.title}</span>
          {item.summary ? (
            <span className="line-clamp-3 text-body-sm text-ink-secondary">{item.summary}</span>
          ) : null}
        </span>
      </Link>
    </Card>
  );
}
