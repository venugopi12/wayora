import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { RouteObject, UIMatch } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequireAuth } from '../src/features/auth/guards';
import { createRoutes } from '../src/app/routes';
import { MarketingLayout } from '../src/components/layout/MarketingLayout';
import { AuthLayout } from '../src/components/layout/AuthLayout';
import { RootLayout } from '../src/components/layout/RootLayout';
import { crumbsFor } from '../src/components/layout/route-handle';
import { FOOTER_GROUPS, LEGAL_LINKS, SOCIAL_LINKS } from '../src/features/navigation/footer';
import { renderRoute } from './render';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const footer = () => screen.getByRole('contentinfo');
const NOT_FOUND = /isn't on the map/i;

/** Makes `(max-width: 767.98px)` match, as on a phone. */
function asPhone() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('max-width: 767.98px'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

describe('SiteFooter', () => {
  it('renders every configured group and link, from the one config', () => {
    renderRoute('/');
    const nav = within(footer()).getByRole('navigation', { name: 'Footer' });
    for (const group of FOOTER_GROUPS) {
      const heading = within(nav).getByRole('heading', { level: 2, name: group.title });
      const list = within(nav).getByRole('list', { name: group.title });
      expect(heading.id).toBe(list.getAttribute('aria-labelledby'));
      expect(
        within(list)
          .getAllByRole('link')
          .map((a) => [a.textContent, a.getAttribute('href')]),
      ).toEqual(group.links.map((l) => [l.label, l.to]));
    }
    const legal = within(footer()).getByRole('navigation', { name: 'Legal' });
    for (const link of LEGAL_LINKS)
      expect(within(legal).getByRole('link', { name: link.label })).toHaveAttribute(
        'href',
        link.to,
      );
  });

  it('includes the services, Discover, company and legal links from the brief', () => {
    renderRoute('/');
    const names = within(footer())
      .getAllByRole('link')
      .map((a) => a.textContent);
    for (const name of [
      'Discover destinations',
      'Flights',
      'Hotels',
      'Trains',
      'Buses',
      'Metro',
      'Cabs',
      'Holiday packages',
      'Travel inspiration',
      'About Wayora',
      'Help and support',
      'Privacy policy',
      'Terms and conditions',
    ])
      expect(names).toContain(name);
  });

  it('invents no contact details or social profiles', () => {
    renderRoute('/');
    expect(SOCIAL_LINKS).toEqual([]);
    const text = footer().textContent ?? '';
    expect(text).not.toMatch(/@|\+\d|tel:|mailto:/);
    expect(within(footer()).queryByRole('list', { name: /social/i })).toBeNull();
    for (const a of within(footer()).getAllByRole('link'))
      expect(a.getAttribute('href')).toMatch(/^\//);
  });

  it('shows the current year, computed at render time', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2031-03-01T10:00:00Z'));
    renderRoute('/');
    expect(within(footer()).getByText('© 2031 Wayora')).toBeInTheDocument();
  });

  it('reuses the shared currency selector', () => {
    renderRoute('/');
    expect(
      within(footer()).getByRole('button', { name: 'Display currency: INR' }),
    ).toBeInTheDocument();
  });

  it('collapses link groups into keyboard-operable accordions on phones', async () => {
    asPhone();
    renderRoute('/');
    const nav = within(footer()).getByRole('navigation', { name: 'Footer' });
    // The accordion loads lazily on phones; closed rows hold its place meanwhile.
    const explore = await within(nav).findByRole('button', { name: 'Explore' });
    const more = within(nav).getByRole('button', { name: 'More travel' });
    // Triggers sit inside h2 headings, so the outline is kept.
    expect(explore.closest('h2')).not.toBeNull();
    expect(explore).toHaveAttribute('aria-expanded', 'false');
    expect(within(nav).queryByRole('link', { name: 'Flights' })).toBeNull();

    fireEvent.click(explore);
    expect(explore).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(explore.getAttribute('aria-controls')!)!;
    expect(within(panel).getByRole('link', { name: 'Flights' })).toHaveAttribute(
      'href',
      '/flights',
    );

    // Several groups can be open; arrow keys move between headers.
    fireEvent.click(more);
    expect(explore).toHaveAttribute('aria-expanded', 'true');
    explore.focus();
    fireEvent.keyDown(explore, { key: 'ArrowDown' });
    await waitFor(() => expect(more).toHaveFocus());
    fireEvent.click(explore);
    expect(explore).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows columns, not accordions, from tablet width up', () => {
    renderRoute('/');
    const nav = within(footer()).getByRole('navigation', { name: 'Footer' });
    expect(within(nav).queryByRole('button')).toBeNull();
    expect(within(nav).getByRole('link', { name: 'Flights' })).toBeInTheDocument();
  });

  it.each([...FOOTER_GROUPS.flatMap((g) => g.links), ...LEGAL_LINKS].map((l) => [l.label, l.to]))(
    'link "%s" (%s) leads to a real page',
    async (_label, to) => {
      renderRoute(to);
      // The page renders (lazy chunk loaded) and it is not the not-found page.
      await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument());
      expect(screen.queryByRole('heading', { name: NOT_FOUND })).toBeNull();
    },
  );
});

describe('layout', () => {
  const routes = [
    '/',
    '/discover',
    '/discover/goa',
    '/discover/atlantis',
    '/flights',
    '/hotels?to=goa',
    '/status',
    '/about',
    '/help',
    '/legal/privacy',
    '/legal/terms',
    '/no-such-page',
  ];

  it.each(routes)('%s renders one header, one main and one footer', async (path) => {
    renderRoute(path);
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1));
    expect(screen.getAllByRole('navigation', { name: 'Primary' })).toHaveLength(1);
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getAllByRole('contentinfo')).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: 'Skip to content' })).toHaveLength(1);
  });

  it('keeps unknown routes on the existing not-found page, inside the layout', async () => {
    renderRoute('/legal');
    expect(await screen.findByRole('heading', { level: 1, name: NOT_FOUND })).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('nests pages under RootLayout → MarketingLayout → an error boundary', () => {
    const [root] = createRoutes({ includeDevRoutes: false }) as [RouteObject];
    expect((root.element as { type: unknown }).type).toBe(RootLayout);
    expect(root.errorElement).toBeTruthy();
    // The focused auth layout is a sibling, so sign-in pages have no marketing chrome.
    const [authLayout, marketing, admin] = root.children as [RouteObject, RouteObject, RouteObject];
    expect((authLayout.element as { type: unknown }).type).toBe(AuthLayout);
    expect((marketing.element as { type: unknown }).type).toBe(MarketingLayout);
    const pages = marketing.children![0]!;
    expect(pages.errorElement).toBeTruthy();
    expect(pages.children!.some((r) => r.index)).toBe(true);
    expect(pages.children!.at(-1)!.path).toBe('*');
    // The admin dashboard is another focused sibling, behind sign-in (Phase 15).
    expect((admin.element as { type: unknown }).type).toBe(RequireAuth);
    expect(admin.children![0]!.path).toBe('admin');
    expect(admin.children![0]!.errorElement).toBeTruthy();
  });

  it('announces client-side page changes using the page title', async () => {
    const { router } = renderRoute('/about');
    await screen.findByRole('heading', { level: 1, name: 'About Wayora' });
    const announcer = document.querySelector('[data-route-announcer]')!;
    expect(announcer).toHaveAttribute('aria-live', 'polite');
    expect(announcer.textContent).toBe('');
    await act(() => router.navigate('/help'));
    await screen.findByRole('heading', { level: 1, name: 'Help and support' });
    await waitFor(() => expect(announcer.textContent).toBe('Help and support | Wayora'));
  });
});

describe('breadcrumbs', () => {
  const match = (pathname: string, handle?: unknown, params = {}): UIMatch =>
    ({ id: pathname, pathname, params, data: undefined, loaderData: undefined, handle }) as UIMatch;

  it('builds a trail from route handles, starting at Home', () => {
    expect(
      crumbsFor([
        match('/'),
        match('/discover', { crumb: 'Discover' }),
        match('/discover/kyoto', { crumb: () => 'Kyoto' }, { slug: 'kyoto' }),
      ]),
    ).toEqual([
      { label: 'Home', path: '/' },
      { label: 'Discover', path: '/discover' },
      { label: 'Kyoto', path: '/discover/kyoto' },
    ]);
  });

  it('is empty when no route opts in, and drops the trail when a level is unknown', () => {
    expect(crumbsFor([match('/'), match('/flights')])).toEqual([]);
    expect(
      crumbsFor([
        match('/discover', { crumb: 'Discover' }),
        match('/discover/x', { crumb: () => undefined }),
      ]),
    ).toEqual([]);
  });

  it('collapses an index route into its parent', () => {
    expect(
      crumbsFor([
        match('/discover', { crumb: 'Discover' }),
        match('/discover', { crumb: 'Discover' }),
      ]),
    ).toEqual([
      { label: 'Home', path: '/' },
      { label: 'Discover', path: '/discover' },
    ]);
  });

  it('renders on destination pages with working links and the current page marked', async () => {
    renderRoute('/discover/kyoto');
    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    const items = within(nav).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(['Home', 'Discover', 'Kyoto']);
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
    expect(within(nav).getByRole('link', { name: 'Discover' })).toHaveAttribute(
      'href',
      '/discover',
    );
    expect(within(nav).queryByRole('link', { name: 'Kyoto' })).toBeNull();
    expect(within(nav).getByText('Kyoto')).toHaveAttribute('aria-current', 'page');
  });

  it('renders on info and legal pages without guessed intermediate URLs', async () => {
    renderRoute('/legal/privacy');
    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(
      within(nav)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Home', 'Privacy policy']);
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/']);
  });

  it.each(['/', '/discover', '/flights', '/discover/atlantis', '/no-such-page'])(
    'is not shown on %s',
    async (path) => {
      renderRoute(path);
      await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument());
      expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    },
  );
});

describe('info and legal pages', () => {
  it('marks the legal pages as drafts and makes no commitments', async () => {
    for (const [path, title] of [
      ['/legal/privacy', 'Privacy policy'],
      ['/legal/terms', 'Terms and conditions'],
    ] as const) {
      const { unmount } = renderRoute(path);
      expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument();
      expect(screen.getByText('Draft: not a published policy')).toBeInTheDocument();
      expect(screen.getByText(/reviewed by qualified legal counsel/i)).toBeInTheDocument();
      await waitFor(() => expect(document.title).toBe(`${title} | Wayora`));
      unmount();
    }
  });

  it('answers help questions in an accordion and offers no invented contact details', async () => {
    renderRoute('/help');
    const q = await screen.findByRole('button', { name: 'Can I book travel on Wayora?' });
    expect(q).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(q);
    expect(q).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByText(/only as a demo\. each service page has a demo search/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/there's no support contact yet/i)).toBeInTheDocument();
    expect(screen.getByRole('main').textContent).not.toMatch(/@\w|mailto:|tel:|\+\d{2}/);
  });

  it('describes Wayora without market or customer claims', async () => {
    renderRoute('/about');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'About Wayora' }),
    ).toBeInTheDocument();
    const text = screen.getByRole('main').textContent ?? '';
    expect(text).toMatch(/in development/i);
    expect(text).not.toMatch(/million|leading|#1|trusted by|customers/i);
  });
});
