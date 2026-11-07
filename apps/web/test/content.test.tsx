import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trackingDeclined } from '../src/services/content';
import { guide } from './content-fixtures';
import { installFakeAdminApi } from './fake-admin-api';
import {
  CONTENT_ID,
  adminEntry,
  installFakeAdminContentApi,
  installFakeContentApi,
} from './fake-content-api';
import { renderRoute } from './render';

/*
 * Phase 29 pages: published content, themes, destination additions, the
 * admin CMS, and the page metadata React applies (docs/seo.md).
 */

const head = (selector: string) => document.head.querySelector(selector);
const robots = () => head('meta[name="robots"]')?.getAttribute('content');
const canonical = () => head('link[rel="canonical"]')?.getAttribute('href');
const jsonLd = () =>
  [...document.head.querySelectorAll('script[type="application/ld+json"]')].map(
    (s) => JSON.parse(s.textContent ?? '') as { '@type': string },
  );

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
});
afterEach(() => vi.unstubAllGlobals());

describe('published guides', () => {
  it('renders a guide semantically, with byline, dates, reading time and metadata', async () => {
    const api = installFakeContentApi({ published: [guide()] });
    renderRoute('/guides/goa-monsoon-guide');
    const article = await screen.findByRole('article', { name: 'Goa in the monsoon' });
    expect(
      within(article).getByRole('heading', { level: 2, name: 'What changes' }),
    ).toBeInTheDocument();
    expect(within(article).getByText('By Asha R., Wayora team')).toBeInTheDocument();
    expect(within(article).getByText('2 min read')).toBeInTheDocument();
    expect(within(article).getAllByRole('listitem').length).toBeGreaterThanOrEqual(2);
    expect(within(article).getByRole('note', { name: 'Tip' })).toBeInTheDocument();
    expect(within(article).getByRole('note', { name: 'Set by the provider' })).toHaveTextContent(
      'Set by the provider, not Wayora',
    );
    for (const img of within(article).getAllByRole('img', {
      name: 'Illustration of the Goa coastline',
    })) {
      expect(img).toHaveAttribute('width', '1600');
      expect(img).toHaveAttribute('height', '1200');
    }
    expect(within(article).getByRole('link', { name: /goa/i })).toHaveAttribute(
      'href',
      '/discover/goa',
    );
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Guides');

    await waitFor(() => expect(document.title).toBe('Goa in the monsoon | Wayora'));
    expect(robots()).toBe('index, follow');
    expect(canonical()).toBe('http://localhost:5173/guides/goa-monsoon-guide');
    expect(head('meta[property="og:type"]')?.getAttribute('content')).toBe('article');
    expect(jsonLd().map((b) => b['@type'])).toEqual(['BreadcrumbList', 'Article']);
    // One cookieless page-view count.
    await waitFor(() => expect(api.events).toHaveLength(1));
    expect(api.events[0]).toEqual({
      body: { event: 'content_view', key: 'goa-monsoon-guide' },
      credentials: 'omit',
    });
  });

  it('shows markup typed into content as text, never as HTML', async () => {
    installFakeContentApi({
      published: [
        guide({
          body: [{ type: 'paragraph', text: '<img src=x onerror="alert(1)"> <b>not bold</b>' }],
        }),
      ],
    });
    const { container } = renderRoute('/guides/goa-monsoon-guide');
    expect(
      await screen.findByText('<img src=x onerror="alert(1)"> <b>not bold</b>'),
    ).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });

  it('is a real not-found page (noindex) for unknown or unpublished slugs', async () => {
    installFakeContentApi({ published: [] });
    renderRoute('/guides/draft-only');
    expect(
      await screen.findByRole('heading', { level: 1, name: /isn't on the map/i }),
    ).toBeInTheDocument();
    await waitFor(() => expect(robots()).toBe('noindex, follow'));
    expect(canonical()).toBeUndefined();
  });

  it('lists guides, and keeps an empty index out of search engines', async () => {
    installFakeContentApi({ published: [] });
    const first = renderRoute('/guides');
    expect(await screen.findByText('No guides yet')).toBeInTheDocument();
    await waitFor(() => expect(robots()).toBe('noindex, follow'));
    first.unmount();

    installFakeContentApi({ published: [guide()] });
    renderRoute('/guides');
    expect(await screen.findByRole('link', { name: /goa in the monsoon/i })).toHaveAttribute(
      'href',
      '/guides/goa-monsoon-guide',
    );
    await waitFor(() => expect(robots()).toBe('index, follow'));
  });

  it('shares the canonical link, copying it when there is no share sheet', async () => {
    installFakeContentApi({ published: [guide()] });
    const clipboard = { writeText: vi.fn(() => Promise.resolve()) };
    vi.stubGlobal('navigator', { ...navigator, clipboard, share: undefined });
    renderRoute('/guides/goa-monsoon-guide');
    fireEvent.click(await screen.findByRole('button', { name: 'Share' }));
    await waitFor(() =>
      expect(clipboard.writeText).toHaveBeenCalledWith(
        'http://localhost:5173/guides/goa-monsoon-guide',
      ),
    );
    expect(await screen.findByRole('button', { name: 'Link copied' })).toBeInTheDocument();
  });
});

describe('privacy of page-view counts', () => {
  it('sends nothing when the browser asks not to be tracked', async () => {
    expect(trackingDeclined({ doNotTrack: '1' } as unknown as Navigator)).toBe(true);
    expect(trackingDeclined({ globalPrivacyControl: true } as unknown as Navigator)).toBe(true);
    expect(trackingDeclined({ doNotTrack: null } as unknown as Navigator)).toBe(false);

    const api = installFakeContentApi({ published: [guide()] });
    vi.stubGlobal('navigator', { ...navigator, globalPrivacyControl: true });
    renderRoute('/guides/goa-monsoon-guide');
    await screen.findByRole('article', { name: 'Goa in the monsoon' });
    await new Promise((r) => setTimeout(r, 50));
    expect(api.events).toEqual([]);
  });
});

describe('themes', () => {
  it('lists the destinations in a theme, says it is editorial, and links other themes', async () => {
    renderRoute('/discover/themes/beach-destinations');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Beach destinations' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/isn’t a ranking/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Goa' })).toHaveAttribute('href', '/discover/goa');
    expect(screen.queryByRole('link', { name: 'Kyoto' })).toBeNull();
    expect(screen.getByRole('link', { name: /heritage and culture/i })).toHaveAttribute(
      'href',
      '/discover/themes/heritage',
    );
    await waitFor(() =>
      expect(jsonLd().map((b) => b['@type'])).toEqual(['BreadcrumbList', 'CollectionPage']),
    );
  });

  it('has no page for a theme without enough destinations', async () => {
    renderRoute('/discover/themes/hill-stations');
    expect(
      await screen.findByRole('heading', { level: 1, name: /isn't on the map/i }),
    ).toBeInTheDocument();
    renderRoute('/discover/themes');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Destination themes' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /hill stations/i })).toBeNull();
  });
});

describe('destination pages', () => {
  it('show things to see and do, linked guides and FAQs, and the destination metadata', async () => {
    const faq = guide({
      type: 'faq',
      slug: 'goa-monsoon-open',
      path: null,
      title: 'Are Goa beaches open in the monsoon?',
      summary: '',
      body: [{ type: 'paragraph', text: 'Beaches stay open, but swimming is often not allowed.' }],
      readingMinutes: null,
    });
    const api = installFakeContentApi({ published: [guide(), faq] });
    renderRoute('/discover/goa');
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Things to see and do in Goa' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/sample planning catalogue/i)).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Guides to Goa' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /goa in the monsoon/i })).toHaveAttribute(
      'href',
      '/guides/goa-monsoon-guide',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Are Goa beaches open in the monsoon?' }));
    expect(await screen.findByText(/swimming is often not allowed/)).toBeInTheDocument();

    await waitFor(() =>
      expect(jsonLd().map((b) => b['@type'])).toEqual(['BreadcrumbList', 'TouristDestination']),
    );
    expect(head('meta[property="og:image"]')?.getAttribute('content')).toBe(
      'http://localhost:5173/media/og/destination-goa.jpg',
    );
    await waitFor(() =>
      expect(api.events).toContainEqual({
        body: { event: 'destination_view', key: 'goa' },
        credentials: 'omit',
      }),
    );
  });

  it('a query string keeps the page out of the index but follows its links', async () => {
    renderRoute('/discover/goa?mode=hotels');
    await screen.findByRole('heading', { level: 1, name: 'Goa' });
    await waitFor(() => expect(robots()).toBe('noindex, follow'));
    expect(canonical()).toBe('http://localhost:5173/discover/goa');
  });
});

describe('discover page', () => {
  it('shows "Most viewed" only when there is enough data, and says what it counts', async () => {
    installFakeContentApi({
      popular: {
        basis: 'destination_page_views',
        days: 30,
        minimumViews: 20,
        items: [{ slug: 'goa' }, { slug: 'kyoto' }, { slug: 'jaipur' }],
      },
    });
    renderRoute('/discover');
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Most viewed on Wayora' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/a count of page views, not a rating/i)).toBeInTheDocument();
  });

  it('hides "Most viewed" without data', async () => {
    installFakeContentApi();
    renderRoute('/discover');
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Browse by theme' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Most viewed on Wayora' })).toBeNull();
  });
});

describe('admin content management', () => {
  it('support staff can read and preview, but not create, edit or publish', async () => {
    installFakeAdminApi({ role: 'support' });
    installFakeAdminContentApi('support', adminEntry(guide()));
    renderRoute('/admin/content');
    expect(await screen.findByRole('heading', { level: 1, name: 'Content' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Goa in the monsoon' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New entry' })).toBeNull();
    expect(await screen.findByText(/no cookies, identifiers or IP addresses/i)).toBeInTheDocument();

    renderRoute(`/admin/content/${CONTENT_ID}`);
    expect(await screen.findByText(/publishing and archiving need/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    // The preview renders the public view.
    expect(screen.getByRole('article', { name: 'Goa in the monsoon' })).toBeInTheDocument();
  });

  it('administrators edit with a new revision, and publish when there are no problems', async () => {
    installFakeAdminApi({ role: 'admin' });
    const api = installFakeAdminContentApi(
      'admin',
      adminEntry(guide(), {
        problems: [{ field: 'body', message: 'Guides need at least 300 words.' }],
      }),
    );
    renderRoute(`/admin/content/${CONTENT_ID}`);
    expect(await screen.findByText('Guides need at least 300 words.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();

    // Label queries: role queries are slow on a form this size in jsdom.
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Goa in the rainy season' },
    });
    // The slug doesn't follow the title once the entry exists.
    expect(screen.getByLabelText('Slug')).toHaveValue('goa-monsoon-guide');
    fireEvent.click(within(screen.getByRole('group', { name: 'Add a block' })).getByText('Tip'));
    const blocks = guide().body.length;
    fireEvent.change(screen.getByLabelText(`Block ${blocks + 1} text`), {
      target: { value: 'Carry cash for ferries.' },
    });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(api.writes).toHaveLength(1));
    expect(api.writes[0]).toMatchObject({
      method: 'PATCH',
      body: { title: 'Goa in the rainy season', revision: 2, slug: 'goa-monsoon-guide' },
    });
    expect((api.writes[0]!.body.body as unknown[]).at(-1)).toEqual({
      type: 'tip',
      text: 'Carry cash for ferries.',
    });
    expect(await screen.findByText(/revision 3/)).toBeInTheDocument();
  });

  it('publishes and archives with the current revision', async () => {
    installFakeAdminApi({ role: 'admin' });
    const api = installFakeAdminContentApi('admin', adminEntry(guide()));
    renderRoute(`/admin/content/${CONTENT_ID}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));
    await waitFor(() =>
      expect(api.writes).toContainEqual({
        method: 'POST',
        path: `/admin/content/${CONTENT_ID}/status`,
        body: { action: 'publish', revision: 2 },
      }),
    );
    expect(
      await screen.findByRole('link', { name: '/guides/goa-monsoon-guide' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(api.writes.at(-1)).toMatchObject({ body: { action: 'archive', revision: 3 } }),
    );
    expect(await screen.findByRole('button', { name: 'Restore as a draft' })).toBeInTheDocument();
  });

  it('admin pages are never indexed', async () => {
    installFakeAdminApi({ role: 'admin' });
    installFakeAdminContentApi('admin', adminEntry(guide()));
    renderRoute('/admin/content');
    await screen.findByRole('heading', { level: 1, name: 'Content' });
    await waitFor(() => expect(robots()).toBe('noindex, nofollow'));
    expect(canonical()).toBeUndefined();
    expect(head('meta[property="og:title"]')).toBeNull();
  });
});
