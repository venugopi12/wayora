import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRAVEL_CATEGORIES } from '@wayora/contracts';
import { FEATURED_DESTINATIONS, HOME_MOODS } from '../src/features/home/content';
import { renderRoute } from './render';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/api/v1/catalog/categories')
        ? jsonResponse({ data: TRAVEL_CATEGORIES, meta: { requestId: 'r1' } })
        : jsonResponse({
            data: { status: 'ready', timestamp: new Date().toISOString(), dependencies: [] },
            meta: { requestId: 'r2' },
          }),
    ),
  );
}

beforeEach(() => stubApi());
afterEach(() => vi.unstubAllGlobals());

const hero = () => screen.getByRole('region', { name: /some journeys change everything/i });

describe('homepage sections', () => {
  it('renders the hero and every section of the narrative in order', () => {
    renderRoute('/');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Some journeys change everything.',
    );
    const titles = [
      /some journeys change everything/i,
      /how would you like to travel/i,
      /start with a feeling, not a place/i,
      /four places worth the journey/i,
      /designed around the whole journey/i,
      /where will your next line lead/i,
    ];
    const regions = titles.map((name) => screen.getByRole('region', { name }));
    for (let i = 1; i < regions.length; i += 1) {
      // DOCUMENT_POSITION_FOLLOWING === 4
      expect(regions[i - 1]!.compareDocumentPosition(regions[i]!) & 4).toBe(4);
    }
  });

  it('floats the header over the hero on the homepage only', async () => {
    renderRoute('/');
    expect(document.querySelector('header[data-tone]')).toHaveAttribute('data-tone', 'inverse');
  });

  it('keeps the standard header on other pages', async () => {
    renderRoute('/flights');
    await screen.findByRole('heading', { level: 1, name: 'Flights' });
    expect(document.querySelector('header[data-tone]')).toHaveAttribute('data-tone', 'default');
  });

  it('shows no prices, ratings, reviews or deals', () => {
    renderRoute('/');
    const text = screen.getByRole('main').textContent ?? '';
    expect(text).not.toMatch(/[₹$€£]\s?\d/);
    expect(text).not.toMatch(/\b(rated|reviews?|% off|deal of|only \d+ left)\b/i);
  });
});

describe('calls to action', () => {
  it('points the hero CTAs at the travel selector and Discover', () => {
    renderRoute('/');
    expect(within(hero()).getByRole('link', { name: /explore journeys/i })).toHaveAttribute(
      'href',
      '#journeys',
    );
    expect(within(hero()).getByRole('link', { name: /discover destinations/i })).toHaveAttribute(
      'href',
      '/discover',
    );
  });

  it('closing CTA leads to Discover and back to the travel selector', async () => {
    renderRoute('/');
    const cta = screen.getByRole('region', { name: /where will your next line lead/i });
    expect(within(cta).getByRole('link', { name: /discover destinations/i })).toHaveAttribute(
      'href',
      '/discover',
    );
    expect(within(cta).getByRole('link', { name: /choose how to travel/i })).toHaveAttribute(
      'href',
      '#journeys',
    );
  });

  it('primary hero CTA target exists on the page', () => {
    renderRoute('/');
    expect(document.getElementById('journeys')).toBeInTheDocument();
  });
});

describe('travel selector', () => {
  const selector = () => screen.getByRole('region', { name: /how would you like to travel/i });

  it('offers all seven services as tabs, Flights selected, each labelled coming soon', () => {
    renderRoute('/');
    const tabs = within(selector()).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(TRAVEL_CATEGORIES.map((c) => c.name));
    expect(within(selector()).getByRole('tab', { name: 'Flights' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const panel = within(selector()).getByRole('tabpanel');
    expect(within(panel).getByRole('heading', { name: 'Flights' })).toBeInTheDocument();
    expect(within(panel).getByText('Coming in a later phase')).toBeInTheDocument();
  });

  it('moves between services with the arrow keys', async () => {
    renderRoute('/');
    const flights = within(selector()).getByRole('tab', { name: 'Flights' });
    act(() => flights.focus());
    fireEvent.keyDown(flights, { key: 'ArrowRight' });
    await waitFor(() =>
      expect(within(selector()).getByRole('tab', { name: 'Hotels' })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    expect(within(selector()).getByRole('tabpanel')).toHaveAccessibleName('Hotels');
  });

  it('links the selected service to its demo search page', async () => {
    const { router } = renderRoute('/');
    fireEvent.mouseDown(within(selector()).getByRole('tab', { name: 'Cabs' }));
    const about = await within(selector()).findByRole('link', { name: /about cabs/i });
    expect(about).toHaveAttribute('href', '/cabs');
    fireEvent.click(about);
    expect(await screen.findByRole('heading', { level: 1, name: 'Cabs' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/cabs');
    expect(screen.getByText('Demo data only')).toBeInTheDocument();
  });

  it('explores a sample destination by the chosen mode, honestly', async () => {
    const { router } = renderRoute('/');
    fireEvent.mouseDown(within(selector()).getByRole('tab', { name: 'Trains' }));
    const field = within(selector()).getByRole('combobox', { name: 'Where to?' });
    expect(field).toHaveAccessibleDescription(/sample destinations only/i);

    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'go' } });
    expect(within(selector()).getByText('Sample data')).toBeInTheDocument();
    expect(
      within(selector())
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['GoaWest coast, India']);
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(field).toHaveValue('Goa');

    fireEvent.click(within(selector()).getByRole('button', { name: 'Explore Goa' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/discover/goa'));
    expect(router.state.location.search).toBe('?mode=trains');
    expect(await screen.findByRole('heading', { level: 1, name: 'Goa' })).toBeInTheDocument();
    // The chosen service is offered first, and is honestly not bookable yet.
    const options = within(
      screen.getByRole('list', { name: 'Travel options for Goa' }),
    ).getAllByRole('link');
    expect(options[0]).toHaveAccessibleName('Trains to Goa');
    expect(options[0]).toHaveAccessibleDescription(/demo search · booking later.*your choice/i);
  });

  it('explores ideas without a destination', async () => {
    const { router } = renderRoute('/');
    fireEvent.click(within(selector()).getByRole('button', { name: 'Explore ideas' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/discover'));
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Find the place that feels like your next story.',
      }),
    ).toBeInTheDocument();
  });

  it('still lists every service when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    renderRoute('/');
    expect(within(selector()).getAllByRole('tab')).toHaveLength(7);
  });
});

describe('moods and featured destinations', () => {
  it('links each mood to Discover, filtered and scrolled to the results', async () => {
    const { router } = renderRoute('/');
    const moods = screen.getByRole('list', { name: 'Travel moods' });
    for (const mood of HOME_MOODS) {
      expect(within(moods).getByRole('link', { name: mood.title })).toHaveAttribute(
        'href',
        `/discover?mood=${mood.slug}#collection`,
      );
    }
    fireEvent.click(within(moods).getByRole('link', { name: 'Beach escapes' }));
    expect(await screen.findByText('4 sample destinations for beach escapes.')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?mood=beach-escapes');
    expect(screen.getByRole('button', { name: 'Beach escapes' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('shows four featured destinations linking to their Discover pages', async () => {
    const { router } = renderRoute('/');
    const list = screen.getByRole('list', { name: 'Featured destinations' });
    for (const d of FEATURED_DESTINATIONS) {
      const link = within(list).getByRole('link', { name: d.name });
      expect(link).toHaveAttribute('href', `/discover/${d.slug}`);
      expect(link).toHaveAccessibleDescription(d.description);
    }
    fireEvent.click(within(list).getByRole('link', { name: 'Jaipur' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Jaipur' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/discover/jaipur');
  });
});

describe('imagery', () => {
  it('describes informative images and hides decorative ones', () => {
    renderRoute('/');
    const heroImgs = hero().querySelectorAll('img');
    expect(heroImgs.length).toBeGreaterThan(0);
    heroImgs.forEach((img) => expect(img).toHaveAttribute('alt', ''));

    for (const d of FEATURED_DESTINATIONS) {
      expect(screen.getByRole('img', { name: d.image?.alt })).toBeInTheDocument();
    }
    for (const m of HOME_MOODS) {
      expect(screen.getByRole('img', { name: m.image.alt })).toBeInTheDocument();
    }
  });

  it('loads hero media eagerly and everything else lazily', () => {
    renderRoute('/');
    hero()
      .querySelectorAll('img')
      .forEach((img) => expect(img).toHaveAttribute('loading', 'eager'));
    const below = screen
      .getByRole('list', { name: 'Featured destinations' })
      .querySelectorAll('img');
    below.forEach((img) => expect(img).toHaveAttribute('loading', 'lazy'));
  });
});

describe('motion', () => {
  it('starts the headline masked when motion is allowed', () => {
    renderRoute('/');
    const line = within(screen.getByRole('heading', { level: 1 })).getByText('Some journeys');
    expect(line.getAttribute('style') ?? '').toMatch(/translateY\(105%\)/);
  });

  it('renders the final state immediately with reduced motion', () => {
    renderRoute('/', { reducedMotion: 'always' });
    const line = within(screen.getByRole('heading', { level: 1 })).getByText('Some journeys');
    expect(line.getAttribute('style') ?? '').not.toMatch(/translateY\(105%\)/);
    const lead = screen.getByText(/find your next escape/i);
    expect(lead.getAttribute('style') ?? '').not.toMatch(/opacity:\s*0/);
  });

  it('leaves no section content hidden behind an animation with reduced motion', () => {
    const { container } = renderRoute('/', { reducedMotion: 'always' });
    // Inactive frames of the Experience cross-fade are aria-hidden duplicates
    // of content shown inline with each chapter, so they are excluded.
    const hidden = [...container.querySelectorAll<HTMLElement>('main [style]')].filter(
      (el) =>
        /opacity:\s*0(?![.\d])/.test(el.getAttribute('style') ?? '') &&
        !el.closest('[aria-hidden="true"]'),
    );
    expect(hidden.map((el) => el.textContent?.slice(0, 40))).toEqual([]);
  });

  it('uses the shared library pieces for section intros and destination tiles', () => {
    renderRoute('/', { reducedMotion: 'always' });
    for (const id of ['moods-title', 'destinations-title', 'experience-title']) {
      const heading = document.getElementById(id)!;
      expect(heading.tagName).toBe('H2');
      // PageHeader size="section" with an eyebrow kicker.
      expect(heading.closest('header')?.querySelector('p.text-label')).not.toBeNull();
    }
    const tiles = within(screen.getByRole('list', { name: 'Featured destinations' })).getAllByRole(
      'article',
    );
    expect(tiles).toHaveLength(FEATURED_DESTINATIONS.length);
    for (const tile of tiles) expect(within(tile).getAllByRole('link')).toHaveLength(1);
  });
});

describe('platform status page', () => {
  it('moved to /status and is linked from the footer', async () => {
    renderRoute('/');
    expect(
      within(screen.getByRole('contentinfo')).getByRole('link', { name: 'Platform status' }),
    ).toHaveAttribute('href', '/status');
  });

  it('renders the readiness panel at /status', async () => {
    renderRoute('/status');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Platform status' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Platform status | Wayora'));
  });
});
