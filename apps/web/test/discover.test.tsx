import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MotionConfig } from 'motion/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  destinationListSchema,
  destinationSummarySchema,
  type DestinationSummary,
} from '@wayora/contracts';
import { Collection, describeResults } from '../src/features/discover/Collection';
import {
  DESTINATIONS,
  DISCOVER_PICKS,
  HOMEPAGE_FEATURED,
  HOMEPAGE_MOODS,
  MOODS,
  PAIRINGS,
  REGIONS,
} from '../src/features/discover/data';
import { travelOptionsFor } from '../src/features/discover/DestinationDetail';
import { FULL_DESTINATIONS, withDetails } from '../src/features/discover/details';
import { placeLine } from '../src/features/discover/format';
import {
  filterDestinations,
  findDestination,
  normalizeSearch,
  relatedDestinations,
  searchDestinations,
  suggestForSlug,
} from '../src/features/discover/search';
import { parseFilters } from '../src/features/discover/useDiscoverFilters';
import { renderRoute } from './render';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
});
afterEach(() => vi.unstubAllGlobals());

const slugs = (list: readonly { slug: string }[]) => list.map((d) => d.slug);
const publicDir = resolve(__dirname, '../public');

describe('sample destination data', () => {
  it('matches the shared destination contract, summaries and full records', () => {
    for (const d of DESTINATIONS) expect(destinationSummarySchema.safeParse(d).success).toBe(true);
    // Every summary has its long-form copy in details.ts.
    expect(slugs(FULL_DESTINATIONS)).toEqual(slugs(DESTINATIONS));
    const parsed = destinationListSchema.safeParse(FULL_DESTINATIONS);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });

  it('is clearly sample content with no price, rating or availability fields', () => {
    for (const d of DESTINATIONS) {
      expect(d.sample).toBe(true);
      for (const key of ['price', 'priceFrom', 'rating', 'reviews', 'availability', 'deal'])
        expect(d).not.toHaveProperty(key);
    }
  });

  it('includes the twelve destinations from the brief across all four regions', () => {
    expect(slugs(DESTINATIONS).sort()).toEqual(
      [
        'bali',
        'bengaluru',
        'delhi',
        'dubai',
        'goa',
        'hyderabad',
        'jaipur',
        'kerala',
        'kyoto',
        'manali',
        'mumbai',
        'singapore',
      ].sort(),
    );
    for (const region of REGIONS)
      expect(DESTINATIONS.some((d) => d.region === region.slug)).toBe(true);
  });

  it('only references destinations and moods that exist', () => {
    const known = new Set(slugs(DESTINATIONS));
    for (const slug of [
      ...HOMEPAGE_FEATURED,
      ...DISCOVER_PICKS,
      ...PAIRINGS.flatMap((p) => p.stops),
    ])
      expect(known).toContain(slug);
    const moods = new Set(MOODS.map((m) => m.slug));
    for (const slug of HOMEPAGE_MOODS) expect(moods).toContain(slug);
    for (const mood of MOODS)
      expect(DESTINATIONS.some((d) => d.categories.includes(mood.slug))).toBe(true);
  });

  it('points every image at a file that exists, with alt text', () => {
    for (const src of [
      ...DESTINATIONS.map((d) => d.image?.src),
      ...MOODS.map((m) => m.image.src),
    ]) {
      expect(src).toBeTruthy();
      expect(existsSync(`${publicDir}${src}`), src).toBe(true);
    }
    for (const d of DESTINATIONS) expect(d.image?.alt.length).toBeGreaterThan(20);
  });
});

describe('search and filters', () => {
  it('matches case-insensitively, partially, by alias and without accents', () => {
    expect(slugs(searchDestinations('GOA'))).toEqual(['goa']);
    expect(slugs(searchDestinations('ky'))).toEqual(['kyoto']);
    expect(slugs(searchDestinations('bangalore'))).toEqual(['bengaluru']);
    expect(slugs(searchDestinations('BOM'))).toEqual(['mumbai']);
    expect(slugs(searchDestinations('Kyōto'))).toEqual(['kyoto']);
    expect(normalizeSearch('  Bengalūru   CITY ')).toBe('bengaluru city');
  });

  it('searches countries and regions, ranking name matches first', () => {
    expect(slugs(searchDestinations('japan'))).toEqual(['kyoto']);
    expect(slugs(searchDestinations('southeast'))).toEqual(['bali', 'singapore']);
    // "de" starts Delhi's name, starts Bali's alias "Denpasar", and is inside "Hyderabad".
    const de = slugs(searchDestinations('de'));
    expect(de[0]).toBe('delhi');
    expect(de.indexOf('bali')).toBeLessThan(de.indexOf('hyderabad'));
    expect(searchDestinations('')).toHaveLength(DESTINATIONS.length);
    expect(searchDestinations('atlantis')).toEqual([]);
  });

  it('filters by mood and by region, and combines both with search', () => {
    expect(slugs(filterDestinations({ mood: 'mountain-retreats' }))).toEqual(['manali']);
    expect(slugs(filterDestinations({ region: 'southeast-asia' }))).toEqual(['bali', 'singapore']);
    expect(slugs(filterDestinations({ mood: 'beach-escapes', region: 'india' }))).toEqual([
      'goa',
      'kerala',
    ]);
    expect(filterDestinations({ query: 'goa', region: 'east-asia' })).toEqual([]);
  });

  it('reads filters from the URL and ignores unknown values', () => {
    expect(parseFilters(new URLSearchParams('q=%20goa%20&mood=city-breaks&region=india'))).toEqual({
      query: 'goa',
      mood: 'city-breaks',
      region: 'india',
    });
    expect(parseFilters(new URLSearchParams('mood=nope&region=mars'))).toEqual({
      query: '',
      mood: undefined,
      region: undefined,
    });
    // Old homepage links used `cultural-cities`.
    expect(parseFilters(new URLSearchParams('mood=cultural-cities')).mood).toBe(
      'cultural-journeys',
    );
  });

  it('describes results in plain language', () => {
    expect(describeResults(12, {})).toBe('Showing all 12 sample destinations.');
    expect(describeResults(1, { query: 'goa', mood: 'beach-escapes', region: 'india' })).toBe(
      '1 sample destination matching “goa” for beach escapes in India.',
    );
  });

  it('recommends related places only when they share a mood or region', () => {
    const kyoto = findDestination('kyoto')!;
    const related = relatedDestinations(kyoto);
    expect(related.length).toBeGreaterThan(0);
    expect(related.length).toBeLessThanOrEqual(3);
    for (const d of related) {
      expect(d.slug).not.toBe('kyoto');
      expect(
        d.categories.some((c) => kyoto.categories.includes(c)) || d.region === kyoto.region,
      ).toBe(true);
    }
    const loner: DestinationSummary = {
      ...kyoto,
      slug: 'x',
      id: 'x',
      region: 'middle-east',
      categories: ['mountain-retreats'],
    };
    expect(relatedDestinations(loner, { source: [loner, findDestination('goa')!] })).toEqual([]);
  });

  it('suggests close matches for a mistyped slug', () => {
    expect(slugs(suggestForSlug('jaipurr'))).toContain('jaipur');
    expect(slugs(suggestForSlug('kyot'))).toContain('kyoto');
    expect(suggestForSlug('zzzz')).toEqual([]);
  });

  it('offers rail and road only for the India samples', () => {
    expect(travelOptionsFor(findDestination('kyoto')!)).toEqual([
      'flights',
      'hotels',
      'cabs',
      'holidays',
    ]);
    expect(travelOptionsFor(findDestination('goa')!, 'trains')[0]).toBe('trains');
    // A homepage choice that doesn't apply is not forced in.
    expect(travelOptionsFor(findDestination('bali')!, 'trains')).not.toContain('trains');
    expect(travelOptionsFor(findDestination('goa')!)).toContain('buses');
  });

  it('formats place lines for cities, countries and city-states', () => {
    expect(placeLine(findDestination('jaipur')!)).toBe('Rajasthan, India');
    expect(placeLine(findDestination('bali')!)).toBe('Indonesia');
    expect(placeLine(findDestination('singapore')!)).toBe('Southeast Asia');
  });
});

describe('/discover page', () => {
  it('renders the hero, every section and all sample destinations', async () => {
    renderRoute('/discover');
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Find the place that feels like your next story.',
      }),
    ).toBeInTheDocument();
    for (const name of [
      /start with how you want it to feel/i,
      /places to begin with/i,
      /four corners of the map/i,
      /six places we'd start with/i,
      /two places, one journey/i,
      /found a place that feels right/i,
    ])
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
    const grid = screen.getByRole('list', { name: 'Sample destinations' });
    expect(grid.querySelectorAll(':scope > li')).toHaveLength(12);
    expect(screen.getByRole('status')).toHaveTextContent('Showing all 12 sample destinations.');
    expect(screen.getAllByText(/sample data/i).length).toBeGreaterThan(0);
    await waitFor(() => expect(document.title).toBe('Discover | Wayora'));
  });

  it('renders each destination card with a stable image, place, moods and one link', async () => {
    renderRoute('/discover');
    const grid = await screen.findByRole('list', { name: 'Sample destinations' });
    const link = within(grid).getByRole('link', { name: 'Kyoto' });
    expect(link).toHaveAttribute('href', '/discover/kyoto');
    const card = link.closest('li')!;
    expect(within(card).getByText('Kansai, Japan')).toBeInTheDocument();
    expect(
      within(card).getByRole('img', { name: findDestination('kyoto')!.image!.alt }),
    ).toHaveAttribute('loading', 'lazy');
    expect(within(card).getByRole('list', { name: 'Travel moods' })).toHaveTextContent(
      'Cultural journeys',
    );
    expect(within(card).getByText("Editor's pick")).toBeInTheDocument();
    expect(within(card).getAllByRole('link')).toHaveLength(1);
    expect(card.textContent).not.toMatch(/₹|\$|€|rating|reviews|left|deal/i);
  });

  it('searches from the hero: case-insensitive, partial, clearable, in the URL', async () => {
    const { router } = renderRoute('/discover');
    const input = await screen.findByRole('searchbox', { name: 'Destination' });
    fireEvent.change(input, { target: { value: 'SINGA' } });
    fireEvent.submit(screen.getByRole('search', { name: 'Search sample destinations' }));
    await waitFor(() => expect(router.state.location.search).toBe('?q=SINGA'));
    expect(screen.getByRole('status')).toHaveTextContent('1 sample destination matching “SINGA”.');
    const grid = screen.getByRole('list', { name: 'Sample destinations' });
    expect(within(grid).getByRole('link', { name: 'Singapore' })).toBeInTheDocument();
    // Filtered-out cards fade out (AnimatePresence) before they leave the DOM.
    await waitFor(() => expect(within(grid).queryByRole('link', { name: 'Goa' })).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: “SINGA”' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(input).toHaveValue('');
  });

  it('shows a no-results state with ways out', async () => {
    const { router } = renderRoute('/discover?q=atlantis');
    expect(await screen.findByText('No sample destinations match')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Sample destinations' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(screen.getByRole('list', { name: 'Sample destinations' })).toBeInTheDocument();
  });

  it('filters by travel mood with toggle buttons', async () => {
    const { router } = renderRoute('/discover');
    const mood = await screen.findByRole('button', { name: 'Mountain retreats' });
    expect(mood).toHaveAttribute('aria-pressed', 'false');
    expect(mood).toHaveAccessibleDescription(/1 destination/);
    fireEvent.click(mood);
    await waitFor(() => expect(router.state.location.search).toBe('?mood=mountain-retreats'));
    expect(mood).toHaveAttribute('aria-pressed', 'true');
    const grid = screen.getByRole('list', { name: 'Sample destinations' });
    await waitFor(() =>
      expect(
        within(grid)
          .getAllByRole('link')
          .map((l) => l.textContent),
      ).toEqual(['Manali']),
    );
    fireEvent.click(mood);
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('filters by region, with counts, from the toolbar and the region panels', async () => {
    const { router } = renderRoute('/discover?mood=city-breaks');
    const group = await screen.findByRole('group', { name: 'Filter by region' });
    expect(within(group).getByRole('button', { name: /^India/ })).toHaveTextContent('India4');
    fireEvent.click(within(group).getByRole('button', { name: /^Middle East/ }));
    await waitFor(() =>
      expect(router.state.location.search).toBe('?mood=city-breaks&region=middle-east'),
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 sample destination for city breaks in Middle East.',
    );

    // Region panel shortcut: resets other filters so the region is never empty.
    const regions = screen.getByRole('list', { name: 'Regions' });
    fireEvent.click(
      within(regions).getByRole('button', { name: /show in the collection\W+east asia/i }),
    );
    await waitFor(() => expect(router.state.location.search).toBe('?region=east-asia'));
    const grid = screen.getByRole('list', { name: 'Sample destinations' });
    await waitFor(() =>
      expect(
        within(grid)
          .getAllByRole('link')
          .map((l) => l.textContent),
      ).toEqual(['Kyoto']),
    );
  });

  it('explains when a region has no sample destinations yet', () => {
    const onChange = vi.fn();
    const source = DESTINATIONS.filter((d) => d.region !== 'east-asia');
    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: (
            <Collection
              filters={{ region: 'east-asia' }}
              onChange={onChange}
              onClear={() => {}}
              source={source}
            />
          ),
        },
      ],
      { initialEntries: ['/'] },
    );
    render(
      <MotionConfig reducedMotion="always">
        <RouterProvider router={router} />
      </MotionConfig>,
    );
    expect(screen.getByText('No sample destinations in East Asia yet')).toBeInTheDocument();
    expect(
      screen.getByText(/more destinations will be added to this region later/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all regions' }));
    expect(onChange).toHaveBeenCalledWith({ region: undefined });
  });

  it('redirects old ?destination= links to the destination page', async () => {
    const { router } = renderRoute('/discover?destination=goa');
    expect(await screen.findByRole('heading', { level: 1, name: 'Goa' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/discover/goa');
  });

  it('keeps every animated element visible under reduced motion', async () => {
    const { container } = renderRoute('/discover', { reducedMotion: 'always' });
    await screen.findByRole('list', { name: 'Sample destinations' });
    const hidden = [...container.querySelectorAll<HTMLElement>('main [style]')].filter(
      (el) =>
        /opacity:\s*0(?![.\d])/.test(el.getAttribute('style') ?? '') &&
        !el.closest('[aria-hidden="true"]'),
    );
    expect(hidden.map((el) => el.textContent?.slice(0, 40))).toEqual([]);
  });
});

describe('/discover/:slug', () => {
  it('renders a destination page directly (deep link / refresh)', async () => {
    renderRoute('/discover/kyoto');
    expect(await screen.findByRole('heading', { level: 1, name: 'Kyoto' })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Kyoto, Kansai, Japan | Wayora'));
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Discover' })).toHaveAttribute(
      'href',
      '/discover',
    );
    expect(within(crumbs).getByText('Kyoto')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('img', { name: findDestination('kyoto')!.image!.alt })).toHaveAttribute(
      'loading',
      'eager',
    );
    expect(
      screen.getByRole('heading', { level: 2, name: /why it's worth exploring/i }),
    ).toBeInTheDocument();
    for (const h of withDetails(findDestination('kyoto'))!.highlights)
      expect(screen.getByRole('heading', { level: 3, name: h.title })).toBeInTheDocument();
    expect(screen.getByText(/sample editorial content/i)).toBeInTheDocument();
  });

  it('links mood tags to the filtered collection', async () => {
    renderRoute('/discover/bali');
    const moods = await screen.findByRole('list', { name: 'Travel moods' });
    expect(within(moods).getByRole('link', { name: 'Beach escapes' })).toHaveAttribute(
      'href',
      '/discover?mood=beach-escapes#collection',
    );
  });

  it('offers travel options that lead to clearly labelled demo search pages', async () => {
    const { router } = renderRoute('/discover/kyoto');
    const list = await screen.findByRole('list', { name: 'Travel options for Kyoto' });
    const links = within(list).getAllByRole('link');
    expect(links.map((l) => l.textContent?.match(/^[A-Za-z ]+ (to|in) Kyoto/)?.[0])).toEqual([
      'Flights to Kyoto',
      'Hotels in Kyoto',
      'Cabs in Kyoto',
      'Holiday packages in Kyoto',
    ]);
    for (const link of links)
      expect(link).toHaveAccessibleDescription(/demo search · booking later/i);
    fireEvent.click(within(list).getByRole('link', { name: 'Flights to Kyoto' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Flights' })).toBeInTheDocument();
    expect(router.state.location.search).toBe('?to=kyoto');
    expect(screen.getByText(/The demo doesn't cover flights for Kyoto yet/)).toBeInTheDocument();
    expect(screen.getByText('Demo data only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /book|pay|reserve/i })).toBeNull();
  });

  it('links related destinations from the local dataset', async () => {
    const { router } = renderRoute('/discover/kyoto');
    const related = await screen.findByRole('list', { name: 'Destinations related to Kyoto' });
    const expected = relatedDestinations(findDestination('kyoto')!).map((d) => d.name);
    const names = within(related)
      .getAllByRole('link')
      .map((l) => l.textContent);
    expect(names).toEqual(expected);
    fireEvent.click(within(related).getByRole('link', { name: expected[0]! }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/discover/${findDestination(expected[0]!.toLowerCase())?.slug ?? ''}`,
      ),
    );
    expect(await screen.findByRole('heading', { level: 1, name: expected[0] })).toBeInTheDocument();
  });

  it('suggests the paired destination when there is one', async () => {
    renderRoute('/discover/delhi');
    expect(await screen.findByRole('link', { name: /explore jaipur/i })).toHaveAttribute(
      'href',
      '/discover/jaipur',
    );
  });

  it('handles an unknown slug with suggestions and a way back', async () => {
    renderRoute('/discover/jaipurr');
    expect(
      await screen.findByRole('heading', { level: 1, name: /couldn't find that destination/i }),
    ).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Destination not found | Wayora'));
    const similar = screen.getByRole('navigation', { name: 'Similar destinations' });
    expect(within(similar).getByRole('link', { name: 'Jaipur' })).toHaveAttribute(
      'href',
      '/discover/jaipur',
    );
    expect(screen.getByRole('link', { name: /browse all destinations/i })).toHaveAttribute(
      'href',
      '/discover',
    );
  });

  it('keeps deeper unknown paths on the site not-found page', async () => {
    renderRoute('/discover/goa/extra');
    expect(await screen.findByRole('heading', { name: /isn't on the map/i })).toBeInTheDocument();
  });

  it('uses a branded placeholder when a destination has no image', () => {
    // DestinationImage renders no <img> without a source; the frame keeps its ratio.
    const goa = withDetails(findDestination('goa'))!;
    expect(goa.image).toBeDefined();
    const { image: _omit, ...withoutImage } = goa;
    expect(destinationListSchema.safeParse([withoutImage]).success).toBe(true);
  });
});
