import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findDestination } from '../src/features/discover/search';
import { SERVICE_NAV } from '../src/features/navigation/config';
import { renderRoute } from './render';

beforeEach(() => {
  // Home page queries the API; navigation tests don't need it.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
});
afterEach(() => vi.unstubAllGlobals());

const primaryNav = () => screen.getByRole('navigation', { name: 'Primary' });
/** The site header (Testing Library also maps in-page <header> elements to "banner"). */
const siteHeader = () => primaryNav().closest('header')!;

describe('desktop navigation', () => {
  it('links the logo home and every primary item to a real route', () => {
    renderRoute('/hotels');
    expect(screen.getByRole('link', { name: 'Wayora, home' })).toHaveAttribute('href', '/');
    const nav = primaryNav();
    for (const [name, href] of [
      ['Discover', '/discover'],
      ['Flights', '/flights'],
      ['Hotels', '/hotels'],
      ['Trains', '/trains'],
      ['Buses', '/buses'],
    ]) {
      expect(within(nav).getByRole('link', { name })).toHaveAttribute('href', href);
    }
    expect(within(nav).getByRole('link', { name: 'Hotels' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Flights' })).not.toHaveAttribute('aria-current');
  });

  it('opens the More mega menu on click with services, descriptions and the featured panel', async () => {
    renderRoute('/');
    const more = within(primaryNav()).getByRole('button', { name: 'More' });
    expect(more).toHaveAttribute('aria-expanded', 'false');

    fireEvent.pointerDown(more);
    fireEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(more).toHaveAttribute('aria-controls');

    const nav = primaryNav();
    for (const name of ['Metro', 'Cabs', 'Holiday packages']) {
      expect(within(nav).getByRole('link', { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }
    expect(within(nav).getByText('Urban transport and city travel.')).toBeInTheDocument();
    expect(within(nav).getByText('Your next journey starts here.')).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /explore destinations/i })).toHaveAttribute(
      'href',
      '/discover',
    );
    // Every service in the panel is visibly marked as demo search (catalog: beta).
    expect(within(nav).getAllByText('Demo').length).toBeGreaterThanOrEqual(3);
    expect(within(nav).queryByText('Soon')).toBeNull();
  });

  it('closes the mega menu on Escape and returns focus to the trigger', async () => {
    renderRoute('/');
    const more = within(primaryNav()).getByRole('button', { name: 'More' });
    more.focus();
    fireEvent.keyDown(more, { key: 'Enter' });
    fireEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');

    const panelLink = within(primaryNav()).getByRole('link', { name: /^Metro/ });
    fireEvent.keyDown(panelLink, { key: 'Escape' });
    await waitFor(() => expect(more).toHaveAttribute('aria-expanded', 'false'));
    expect(more).toHaveFocus();
  });

  it('closes the mega menu on an outside click', async () => {
    renderRoute('/');
    const more = within(primaryNav()).getByRole('button', { name: 'More' });
    fireEvent.pointerDown(more);
    fireEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');

    // Radix attaches its outside-pointer listener on the next tick after opening.
    await act(() => new Promise((r) => setTimeout(r, 0)));
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(more).toHaveAttribute('aria-expanded', 'false'));
  });

  it('closes the mega menu and navigates when a menu link is selected', async () => {
    renderRoute('/');
    const more = within(primaryNav()).getByRole('button', { name: 'More' });
    fireEvent.pointerDown(more);
    fireEvent.click(more);
    fireEvent.click(within(primaryNav()).getByRole('link', { name: /^Cabs/ }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Cabs' })).toBeInTheDocument();
    await waitFor(() => expect(more).toHaveAttribute('aria-expanded', 'false'));
    expect(more).toHaveAttribute('data-section-active');
  });
});

describe('service search pages', () => {
  it('keeps the header on screen while a lazily loaded page loads', async () => {
    renderRoute('/metro');
    // Synchronously, before the page chunk resolves: header present, loader in <main>,
    // footer held back so it can't jump when the page arrives.
    expect(screen.getByRole('link', { name: 'Wayora, home' })).toBeInTheDocument();
    expect(within(screen.getByRole('main')).getByRole('status')).toHaveTextContent('Loading page');
    expect(screen.queryByRole('contentinfo')).toBeNull();
    expect(await screen.findByRole('heading', { level: 1, name: 'Metro' })).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it.each(SERVICE_NAV.map((s) => [s.path, s.name] as const))(
    '%s renders a clearly labelled demo search page',
    async (path, name) => {
      renderRoute(path);
      expect(await screen.findByRole('heading', { level: 1, name })).toBeInTheDocument();
      const main = screen.getByRole('main');
      expect(within(main).getByText('Demo data only')).toBeInTheDocument();
      expect(
        within(main).getByText(
          /bookings are demo bookings: no real reservation, ticket or payment/i,
        ),
      ).toBeInTheDocument();
      expect(within(main).getByRole('form')).toBeInTheDocument();
      expect(within(main).queryByRole('button', { name: /book|pay|reserve/i })).toBeNull();
    },
  );

  it('names a destination from Discover the demo does not cover, with a way back', async () => {
    renderRoute('/hotels?to=kyoto');
    expect(await screen.findByRole('heading', { level: 1, name: 'Hotels' })).toBeInTheDocument();
    expect(screen.getByText(/The demo doesn't cover hotels for Kyoto yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Kyoto' })).toHaveAttribute(
      'href',
      '/discover/kyoto',
    );
  });

  it('prefills a destination from Discover that the demo covers', async () => {
    renderRoute('/hotels?to=goa');
    expect(await screen.findByRole('combobox', { name: /destination/i })).toHaveValue('city:goa');
    expect(screen.getByText(/Planning a trip to Goa/)).toBeInTheDocument();
  });

  it('ignores an unknown destination on a service page', async () => {
    renderRoute('/flights?to=atlantis');
    expect(await screen.findByRole('heading', { level: 1, name: 'Flights' })).toBeInTheDocument();
  });

  it('the old /sign-in path redirects to the real sign-in page', async () => {
    const { router } = renderRoute('/sign-in?redirect=%2Fprofile');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Welcome back' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toBe('?redirect=%2Fprofile');
  });

  it('keeps unknown routes on the not-found page', async () => {
    renderRoute('/flights/search');
    expect(await screen.findByRole('heading', { name: /isn't on the map/i })).toBeInTheDocument();
  });
});

describe('destination search', () => {
  it('opens, focuses the field, filters, shows no-results, clears and selects with the keyboard', async () => {
    const { router } = renderRoute('/');
    fireEvent.click(screen.getByRole('button', { name: 'Search destinations' }));

    const input = await screen.findByRole('combobox', { name: 'Search sample destinations' });
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.getByText('Sample data')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(12);

    fireEvent.change(input, { target: { value: 'hyd' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'HyderabadTelangana, India',
    ]);

    fireEvent.change(input, { target: { value: 'qqq' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/no sample destination matches “qqq”/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: 'd' } });
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options[0]!.id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const active = screen
      .getAllByRole('option')
      .find((o) => o.getAttribute('aria-selected') === 'true')!;
    expect(input).toHaveAttribute('aria-activedescendant', active.id);

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/discover\/[a-z-]+$/));
    const slug = router.state.location.pathname.split('/').pop()!;
    const chosen = findDestination(slug)!;
    expect(active.textContent).toContain(chosen.name);
    expect(await screen.findByRole('heading', { level: 1, name: chosen.name })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Search sample destinations' })).toBeNull();
  });

  it('closes on Escape and opens with the "/" shortcut', async () => {
    renderRoute('/');
    fireEvent.keyDown(document.body, { key: '/' });
    const input = await screen.findByRole('combobox', { name: 'Search sample destinations' });
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('combobox', { name: 'Search sample destinations' })).toBeNull(),
    );
  });

  it('closes on an outside click', async () => {
    renderRoute('/');
    fireEvent.click(screen.getByRole('button', { name: 'Search destinations' }));
    await screen.findByRole('combobox', { name: 'Search sample destinations' });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    fireEvent.pointerDown(document.body);
    await waitFor(() =>
      expect(screen.queryByRole('combobox', { name: 'Search sample destinations' })).toBeNull(),
    );
  });
});

describe('currency preference', () => {
  it('defaults to INR and updates the header when changed', async () => {
    renderRoute('/');
    const header = siteHeader();
    const trigger = within(header).getByRole('button', { name: 'Display currency: INR' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const usd = await screen.findByRole('menuitemradio', { name: /USD/ });
    expect(screen.getByRole('menuitemradio', { name: /INR/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByText(/prices aren't converted/i)).toBeInTheDocument();
    fireEvent.click(usd);
    expect(
      await within(header).findByRole('button', { name: 'Display currency: USD' }),
    ).toBeInTheDocument();
  });
});

describe('mobile navigation drawer', () => {
  it('opens with all seven services, Discover, currency and account actions; closes via the close button', async () => {
    renderRoute('/');
    const menuButton = screen.getByRole('button', { name: 'Open menu' });
    expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(menuButton);

    const drawer = await screen.findByRole('dialog', { name: 'Main menu' });
    for (const s of SERVICE_NAV) {
      expect(within(drawer).getByRole('link', { name: new RegExp(`^${s.name}`) })).toHaveAttribute(
        'href',
        s.path,
      );
    }
    expect(within(drawer).getByRole('link', { name: /^Discover/ })).toHaveAttribute(
      'href',
      '/discover',
    );
    // Services are badged from the catalog ("Demo" while beta); Discover, a
    // working page rather than a catalog service, carries no badge.
    expect(within(drawer).getAllByText('Demo')).toHaveLength(SERVICE_NAV.length);
    expect(within(drawer).getByRole('link', { name: /^Discover/ })).not.toHaveTextContent(
      /Soon|Demo/,
    );
    // Signed out (the /auth/session check fails offline): sign-in and registration.
    expect(await within(drawer).findByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login',
    );
    expect(within(drawer).getByRole('link', { name: 'Create account' })).toHaveAttribute(
      'href',
      '/register',
    );
    expect(within(drawer).getByRole('combobox', { name: 'Display currency' })).toHaveValue('INR');

    fireEvent.click(within(drawer).getByRole('button', { name: 'Close menu' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open menu' })).toHaveFocus());
  });

  it('renders drawer rows fully visible under reduced motion and marks the current page', async () => {
    renderRoute('/cabs', { reducedMotion: 'always' });
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Main menu' });
    for (const item of within(drawer).getAllByRole('listitem'))
      expect(item.getAttribute('style') ?? '').not.toMatch(/opacity:\s*0(?![.\d])/);
    expect(within(drawer).getByRole('link', { name: /^Cabs/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('closes with Escape, and when a link is chosen (navigating there)', async () => {
    const { router } = renderRoute('/');
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    let drawer = await screen.findByRole('dialog', { name: 'Main menu' });
    fireEvent.keyDown(drawer, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    drawer = await screen.findByRole('dialog', { name: 'Main menu' });
    await act(async () => {
      fireEvent.click(within(drawer).getByRole('link', { name: /^Metro/ }));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/metro');
  });

  it('shares the currency preference with the header', async () => {
    renderRoute('/');
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Main menu' });
    fireEvent.change(within(drawer).getByRole('combobox', { name: 'Display currency' }), {
      target: { value: 'EUR' },
    });
    fireEvent.keyDown(drawer, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      within(siteHeader()).getByRole('button', { name: 'Display currency: EUR' }),
    ).toBeInTheDocument();
    // The footer's selector shows the same shared preference.
    expect(
      within(screen.getByRole('contentinfo')).getByRole('button', {
        name: 'Display currency: EUR',
      }),
    ).toBeInTheDocument();
  });
});
