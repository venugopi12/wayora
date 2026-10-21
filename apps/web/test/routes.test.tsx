import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRAVEL_CATEGORIES } from '@wayora/contracts';
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
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/v1/catalog/categories')) {
        return jsonResponse({ data: TRAVEL_CATEGORIES, meta: { requestId: 'r1' } });
      }
      return jsonResponse({
        data: { status: 'ready', timestamp: new Date().toISOString(), dependencies: [] },
        meta: { requestId: 'r2' },
      });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('home page', () => {
  it('renders the brand and the hero', () => {
    stubApi();
    renderRoute('/');
    expect(screen.getByRole('link', { name: 'Wayora, home' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      /some journeys change everything/i,
    );
  });

  it('offers mobile navigation through a labelled menu button', async () => {
    stubApi();
    renderRoute('/');
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const menu = await screen.findByRole('dialog', { name: 'Main menu' });
    expect(within(menu).getByRole('link', { name: /^Flights/ })).toHaveAttribute(
      'href',
      '/flights',
    );
  });
});

describe('not found', () => {
  it('renders the not-found page for unknown paths', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderRoute('/flights/search');
    expect(await screen.findByRole('heading', { name: /isn't on the map/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go to the home page/i })).toHaveAttribute('href', '/');
    expect(document.title).toBe('Page not found | Wayora');
  });
});

describe('design-system route', () => {
  it('renders the showcase when development routes are included', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderRoute('/design-system', { includeDevRoutes: true });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Wayora design system' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Development only')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Design system sections' })).toBeInTheDocument();
    for (const name of [
      'Brand',
      'Colour',
      'Typography',
      'Buttons',
      'Form controls',
      'Travel components',
    ]) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
    }
  });

  it('is a 404 when development routes are excluded (production)', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderRoute('/design-system', { includeDevRoutes: false });
    expect(await screen.findByRole('heading', { name: /isn't on the map/i })).toBeInTheDocument();
    expect(screen.queryByText('Wayora design system')).not.toBeInTheDocument();
  });

  it('is not linked from public navigation', async () => {
    stubApi();
    renderRoute('/', { includeDevRoutes: false });
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).queryByRole('link', { name: /design system/i })).not.toBeInTheDocument();
  });
});
