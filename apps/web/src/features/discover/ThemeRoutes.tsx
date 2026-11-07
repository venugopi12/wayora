import { ArrowRight } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { Breadcrumbs, Container } from '@wayora/ui';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { NotFoundRoute } from '../../routes/NotFoundRoute';
import { DestinationGrid } from '../content/DestinationGrid';
import { notFoundMeta, themeMeta, themesIndexMeta, THEMES_PATH } from '../seo/pages';
import { siteUrl, usePageMeta } from '../seo/SeoProvider';
import { DISCOVER } from '../navigation/config';
import { destinationsFor, PUBLISHED_THEMES, themePath } from './themes';

/*
 * /discover/themes and /discover/themes/:theme (Phase 29). Themes are
 * editorial groupings of the sample destinations by travel mood or region,
 * not rankings; each page says so.
 */

export function ThemesIndexRoute() {
  usePageMeta(themesIndexMeta(siteUrl()));
  useDocumentTitle('Destination themes');
  return (
    <Container className="flex flex-col gap-8 py-section-sm">
      <Breadcrumbs
        items={[
          { label: 'Home', link: <Link to="/" /> },
          { label: DISCOVER.name, link: <Link to={DISCOVER.path} /> },
          { label: 'Themes' },
        ]}
      />
      <header className="flex max-w-prose flex-col gap-2">
        <h1 className="text-heading-1">Destination themes</h1>
        <p className="text-body-lg text-ink-secondary">
          Editorial groupings of the destinations in Wayora’s Discover collection, by the kind of
          trip they suit.
        </p>
      </header>
      <ThemeLinks />
    </Container>
  );
}

/** Links to every published theme, with its destination count. */
export function ThemeLinks({ exclude }: { exclude?: string }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {PUBLISHED_THEMES.filter((t) => t.slug !== exclude).map((t) => {
        const count = destinationsFor(t).length;
        return (
          <li key={t.slug} className="min-w-0">
            <Link
              to={themePath(t.slug)}
              className="flex h-full flex-col gap-1 rounded-lg border border-line bg-card p-4 hover:border-brand-300"
            >
              <span className="flex items-center justify-between gap-2 text-title text-ink">
                {t.title}
                <ArrowRight className="size-4 shrink-0 text-ink-secondary" aria-hidden="true" />
              </span>
              <span className="text-body-sm text-ink-secondary">
                {count} {count === 1 ? 'destination' : 'destinations'}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function ThemeRoute() {
  const { theme: slug = '' } = useParams();
  const theme = PUBLISHED_THEMES.find((t) => t.slug === slug);
  usePageMeta(theme ? themeMeta(siteUrl(), theme) : notFoundMeta());
  useDocumentTitle(theme ? theme.title : 'Page not found');
  if (!theme) return <NotFoundRoute />;
  const places = destinationsFor(theme);
  return (
    <Container className="flex flex-col gap-8 py-section-sm">
      <Breadcrumbs
        items={[
          { label: 'Home', link: <Link to="/" /> },
          { label: DISCOVER.name, link: <Link to={DISCOVER.path} /> },
          { label: 'Themes', link: <Link to={THEMES_PATH} /> },
          { label: theme.title },
        ]}
      />
      <header className="flex max-w-prose flex-col gap-2">
        <h1 className="text-heading-1">{theme.title}</h1>
        <p className="text-body-lg text-ink-secondary">{theme.description}</p>
        <p className="text-body-sm text-ink-secondary">
          An editorial grouping of {places.length} sample destinations, in no particular order. It
          isn’t a ranking.
        </p>
      </header>
      <section aria-labelledby="theme-destinations" className="flex flex-col gap-4">
        <h2 id="theme-destinations" className="text-heading-3">
          Destinations
        </h2>
        <DestinationGrid slugs={places.map((d) => d.slug)} />
      </section>
      <section
        aria-labelledby="other-themes"
        className="flex flex-col gap-4 border-t border-line pt-6"
      >
        <h2 id="other-themes" className="text-heading-3">
          Other themes
        </h2>
        <ThemeLinks exclude={theme.slug} />
      </section>
    </Container>
  );
}
