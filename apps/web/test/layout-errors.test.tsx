import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRoute } from './render';

// Simulate a page chunk that fails to load (e.g. a deploy replaced it).
vi.mock('../src/features/info/routes', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('page errors', () => {
  it('render inside the layout, keeping the header and footer usable', async () => {
    renderRoute('/about');
    expect(
      await screen.findByRole('heading', { level: 1, name: "This page didn't load" }),
    ).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Go to the home page' })).toHaveAttribute('href', '/');
  });
});
