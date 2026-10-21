import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button, MediaFrame, MobileNav, Tabs, TabsContent, TabsList, TabsTrigger } from '../src';

describe('MediaFrame', () => {
  it('lazy-loads by default and reserves its aspect ratio', () => {
    const { container } = render(
      <MediaFrame src="/a.svg" alt="A calm sea" aspect="4/5" focalPoint="30% 60%" />,
    );
    const img = screen.getByRole('img', { name: 'A calm sea' });
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
    expect(img.style.objectPosition).toBe('30% 60%');
    expect(container.firstElementChild?.className).toContain('aspect-[4/5]');
  });

  it('loads priority (hero) media eagerly with high fetch priority', () => {
    render(<MediaFrame src="/hero.svg" alt="" priority aspect="fill" />);
    const img = document.querySelector('img')!;
    expect(img).toHaveAttribute('loading', 'eager');
    expect(img).toHaveAttribute('fetchpriority', 'high');
    // Decorative: empty alt removes it from the accessibility tree.
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('hides a broken image instead of showing the broken-image icon', () => {
    render(<MediaFrame src="/missing.svg" alt="Missing" />);
    const img = screen.getByRole('img', { name: 'Missing' });
    fireEvent.error(img);
    expect(img).toHaveAttribute('data-failed', 'true');
    expect(img.className).toContain('invisible');
  });

  it('supports art-directed sources', () => {
    const { container } = render(
      <MediaFrame
        src="/wide.svg"
        alt=""
        sources={[{ media: '(max-width: 767px)', srcSet: '/tall.svg' }]}
      />,
    );
    const source = container.querySelector('picture source');
    expect(source).toHaveAttribute('media', '(max-width: 767px)');
    expect(source).toHaveAttribute('srcset', '/tall.svg');
  });
});

describe('Tabs', () => {
  function Example() {
    return (
      <Tabs defaultValue="flights">
        <TabsList label="Travel services">
          <TabsTrigger value="flights">Flights</TabsTrigger>
          <TabsTrigger value="hotels">Hotels</TabsTrigger>
          <TabsTrigger value="cabs" disabled>
            Cabs
          </TabsTrigger>
        </TabsList>
        <TabsContent value="flights">Flights panel</TabsContent>
        <TabsContent value="hotels">Hotels panel</TabsContent>
        <TabsContent value="cabs">Cabs panel</TabsContent>
      </Tabs>
    );
  }

  it('exposes a named tablist with one selected tab and its panel', () => {
    render(<Example />);
    expect(screen.getByRole('tablist', { name: 'Travel services' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Flights' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Flights' })).toHaveTextContent('Flights panel');
  });

  it('selects with arrow keys and skips disabled tabs', async () => {
    render(<Example />);
    const flights = screen.getByRole('tab', { name: 'Flights' });
    act(() => flights.focus());
    fireEvent.keyDown(flights, { key: 'ArrowRight' });
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Hotels' })).toHaveAttribute('aria-selected', 'true'),
    );
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Hotels' }), { key: 'ArrowRight' });
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Flights' })).toHaveAttribute('aria-selected', 'true'),
    );
    expect(screen.getByRole('tab', { name: 'Cabs' })).toBeDisabled();
  });
});

describe('inverse variants for dark surfaces', () => {
  it('Button ghost-inverse keeps the focus ring visible on dark backgrounds', () => {
    render(<Button variant="ghost-inverse">Sign in</Button>);
    const button = screen.getByRole('button', { name: 'Sign in' });
    expect(button.className).toContain('text-ink-inverse');
    expect(button.className).toContain('focus-ring-inverse');
  });

  it('MobileNav accepts a trigger variant', () => {
    render(
      <MobileNav title="Wayora" triggerVariant="ghost-inverse">
        <p>Menu</p>
      </MobileNav>,
    );
    expect(screen.getByRole('button', { name: 'Open menu' }).className).toContain(
      'text-ink-inverse',
    );
  });
});
