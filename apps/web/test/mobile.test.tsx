import { onlineManager } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bookPath } from '../src/features/bookings/paths';
import { activeTab, showsTabBar } from '../src/features/navigation/MobileTabBar';
import { captureInstallPrompt, resetInstallState } from '../src/pwa/install';
import { InstallOfferCard, UpdatePrompt } from '../src/pwa/PwaNotices';
import { setUpdateStateForTests } from '../src/pwa/register';
import { demoBooking, installFakeBookingApi } from './fake-booking-api';
import { renderRoute } from './render';
import { DATE, hotel } from './search-fixtures';

/*
 * Phase 30 app-like behaviour (docs/pwa.md): the phone navigation bar,
 * connection notices, offline protection on booking and payment steps, the
 * install offer and the update prompt.
 */

const setOnline = (online: boolean) => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
  act(() => {
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  });
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetInstallState();
  setUpdateStateForTests('none');
  // React Query follows the online/offline events: leave it online for the next test.
  onlineManager.setOnline(true);
});

describe('phone navigation bar', () => {
  it('links the places people come back to, with the current one marked', async () => {
    renderRoute('/');
    const bar = await screen.findByRole('navigation', { name: 'Quick links' });
    const links = within(bar).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Home', 'Trips', 'Rewards', 'Account']);
    expect(within(bar).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(within(bar).getByRole('link', { name: 'Trips' })).toHaveAttribute('href', '/trips');
    // Signed out, Account leads to sign-in and back.
    expect(within(bar).getByRole('link', { name: 'Account' })).toHaveAttribute('href', '/login');
    // Search opens a sheet with every travel service.
    fireEvent.click(within(bar).getByRole('button', { name: 'Search travel' }));
    const sheet = await screen.findByRole('dialog', { name: 'Search travel' });
    const services = within(sheet).getByRole('navigation', { name: 'Travel services' });
    expect(
      within(services)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual([
      'Flights',
      'Hotels',
      'Trains',
      'Buses',
      'Metro',
      'Cabs',
      'Holiday packages',
      'Destinations',
    ]);
  });

  it('knows which section a page belongs to, and steps aside on checkout and payment', () => {
    expect(activeTab('/flights')).toBe('search');
    expect(activeTab('/offers/hotels/x')).toBe('search');
    expect(activeTab('/trips/WYD-1')).toBe('trips');
    expect(activeTab('/rewards')).toBe('rewards');
    expect(activeTab('/profile/travellers')).toBe('account');
    expect(activeTab('/notifications')).toBe('account');
    expect(activeTab('/discover/goa')).toBeNull();
    expect(showsTabBar('/')).toBe(true);
    expect(showsTabBar('/trips/WYD-1')).toBe(true);
    expect(showsTabBar('/book/hotels/r1')).toBe(false);
    expect(showsTabBar('/trips/WYD-1/pay')).toBe(false);
    expect(showsTabBar('/trips/WYD-1/payments/p1')).toBe(false);
  });

  it('keeps the page clear of the bar and the home indicator', async () => {
    const { container } = renderRoute('/');
    await screen.findByRole('navigation', { name: 'Quick links' });
    const bar = screen.getByRole('navigation', { name: 'Quick links' });
    expect(bar.className).toContain('pb-[env(safe-area-inset-bottom)]');
    expect(bar.className).toContain('lg:hidden');
    const spacer = container.querySelector(
      '[aria-hidden="true"].h-\\[calc\\(var\\(--tab-bar-h\\)\\+env\\(safe-area-inset-bottom\\)\\)\\]',
    );
    expect(spacer).not.toBeNull();
  });
});

describe('connection notices', () => {
  it('says when the device is offline, and when it’s back', async () => {
    renderRoute('/');
    await screen.findByRole('navigation', { name: 'Quick links' });
    setOnline(false);
    expect(await screen.findByText(/You’re offline\./)).toBeInTheDocument();
    expect(screen.getByText(/nothing is sent until you’re back online/i)).toBeInTheDocument();
    setOnline(true);
    expect(await screen.findByText('Back online.')).toBeInTheDocument();
    expect(screen.queryByText(/You’re offline\./)).toBeNull();
  });
});

describe('offline protection on bookings and payments', { timeout: 20_000 }, () => {
  it('won’t confirm a booking offline, and says nothing was sent', async () => {
    const api = installFakeBookingApi({ results: [hotel] });
    renderRoute(
      bookPath('hotels', hotel.id, api.response.searchId, `location=city%3Agoa&checkIn=${DATE}`),
    );
    // The phone price bar shows the total with a link to the details.
    expect(await screen.findByRole('link', { name: 'Price details' })).toHaveAttribute(
      'href',
      '#booking-summary',
    );
    fireEvent.click(await screen.findByRole('button', { name: /continue/i }));
    await screen.findByRole('heading', { level: 2, name: 'Who is travelling?' });
    fireEvent.change(screen.getByRole('textbox', { name: /first name/i }), {
      target: { value: 'Asha' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /last name/i }), {
      target: { value: 'Rao' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue to review' }));
    await screen.findByRole('heading', { level: 2, name: 'Review and confirm' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'I understand this is a demo booking' }));
    const confirm = screen.getByRole('button', { name: 'Confirm demo booking' });
    expect(confirm).toBeEnabled();

    setOnline(false);
    await waitFor(() => expect(confirm).toBeDisabled());
    expect(
      screen.getByText(/Reconnect to confirm: nothing is sent until then/),
    ).toBeInTheDocument();
    const writes = () => api.posts.length;
    fireEvent.click(confirm);
    expect(writes()).toBe(0);

    // Back online: enabled again; nothing was queued in the meantime.
    setOnline(true);
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(writes()).toBe(0);
  });

  it('labels a booking loaded before the connection dropped as possibly out of date', async () => {
    const booking = demoBooking(hotel);
    installFakeBookingApi({ results: [hotel], bookings: [booking] });
    renderRoute(`/trips/${booking.reference}`);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/This booking is shown as loaded at/)).toBeNull();
    setOnline(false);
    expect(await screen.findByText(/This booking is shown as loaded at/)).toBeInTheDocument();
    expect(screen.getByText(/it may have changed since/)).toBeInTheDocument();
  });
});

describe('install offer', () => {
  it('shows nothing when the browser can’t install', () => {
    render(<InstallOfferCard />);
    expect(screen.queryByRole('region', { name: 'Install the Wayora app' })).toBeNull();
  });

  it('uses the browser’s own prompt, and stays away for 30 days once dismissed', async () => {
    captureInstallPrompt(window);
    const prompt = vi.fn(() => Promise.resolve());
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt,
      userChoice: Promise.resolve({ outcome: 'dismissed' as const }),
    });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    const { unmount } = render(<InstallOfferCard />);
    const card = screen.getByRole('region', { name: 'Install the Wayora app' });
    fireEvent.click(within(card).getByRole('button', { name: 'Install' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install the Wayora app' });
    expect(within(dialog).getByText(/No app store/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    unmount();
    // Dismissed in the browser's dialog: not offered again for now.
    render(<InstallOfferCard />);
    expect(screen.queryByRole('region', { name: 'Install the Wayora app' })).toBeNull();
  });

  it('gives the manual steps on iPhone Safari', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    );
    render(<InstallOfferCard />);
    fireEvent.click(screen.getByRole('button', { name: 'How to install' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install the Wayora app' });
    expect(within(dialog).getByText('Add to Home Screen')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Install' })).toBeNull();
  });
});

describe('update prompt', () => {
  it('appears when a new version is waiting and reloads only when asked', () => {
    const apply = vi.fn();
    render(<UpdatePrompt />);
    expect(screen.queryByText('A new version of Wayora is ready.')).toBeNull();
    act(() => setUpdateStateForTests('ready', apply));
    expect(screen.getByText('A new version of Wayora is ready.')).toBeInTheDocument();
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('“Not now” hides it for this visit', () => {
    render(<UpdatePrompt />);
    act(() => setUpdateStateForTests('ready', vi.fn()));
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByText('A new version of Wayora is ready.')).toBeNull();
  });
});

describe('push notifications on this device', { timeout: 20_000 }, () => {
  const KEY = `B${'A'.repeat(86)}`;

  /** The booking fake, with push switched on server-side and the push endpoints answered. */
  function withPushServer(active: boolean) {
    installFakeBookingApi({ results: [] });
    const next = globalThis.fetch;
    const saved: unknown[] = [];
    const removed: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const path = url.pathname.replace('/api/v1', '');
        const json = (data: unknown, status = 200) =>
          new Response(JSON.stringify({ data, meta: { requestId: 'r' } }), {
            status,
            headers: { 'Content-Type': 'application/json' },
          });
        if (path === '/notifications/push/subscriptions') {
          const body = JSON.parse(String(init?.body));
          if (init?.method === 'POST') saved.push(body);
          else removed.push(body);
          return json({ subscribed: init?.method === 'POST' }, init?.method === 'POST' ? 201 : 200);
        }
        const res = await next(input, init);
        if (path === '/notifications/preferences' && active) {
          const body = (await res.json()) as { data: Record<string, unknown> };
          return json({
            ...body.data,
            push: { active: true, status: 'Devices where you turn push on…', publicKey: KEY },
          });
        }
        return res;
      }),
    );
    return { saved, removed };
  }

  function browserWithPush(permission: NotificationPermission) {
    const subscription = {
      endpoint: 'https://push.example.test/send/abc',
      toJSON: () => ({
        endpoint: 'https://push.example.test/send/abc',
        expirationTime: null,
        keys: { p256dh: `B${'x'.repeat(86)}`, auth: 'a1b2c3d4e5f6g7h8i9j0kw' },
      }),
      unsubscribe: vi.fn(() => Promise.resolve(true)),
    };
    let current: typeof subscription | null = null;
    const pushManager = {
      getSubscription: vi.fn(async () => current),
      subscribe: vi.fn(async () => {
        current = subscription;
        return subscription;
      }),
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: async () => ({ pushManager }), controller: null },
    });
    vi.stubGlobal('PushManager', class {});
    const requestPermission = vi.fn(async () => permission);
    vi.stubGlobal(
      'Notification',
      Object.assign(class {}, { permission: 'default', requestPermission }),
    );
    vi.stubGlobal('isSecureContext', true);
    return { pushManager, requestPermission, subscription };
  }

  afterEach(() => {
    // @ts-expect-error -- removing the test double
    delete navigator.serviceWorker;
  });

  it('says so when the server has no push set up (and asks nothing)', async () => {
    withPushServer(false);
    const { requestPermission } = browserWithPush('granted');
    renderRoute('/notifications');
    expect(await screen.findByText('Push notifications aren’t active')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /turn on/i })).toBeNull();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('asks for permission only when turned on, then saves this device', async () => {
    const server = withPushServer(true);
    const { requestPermission, pushManager } = browserWithPush('granted');
    renderRoute('/notifications');
    const button = await screen.findByRole('button', { name: 'Turn on for this device' });
    expect(requestPermission).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(
      await screen.findByText('Push notifications are on for this device.'),
    ).toBeInTheDocument();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(pushManager.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    expect(server.saved).toEqual([
      {
        endpoint: 'https://push.example.test/send/abc',
        expirationTime: null,
        keys: { p256dh: `B${'x'.repeat(86)}`, auth: 'a1b2c3d4e5f6g7h8i9j0kw' },
      },
    ]);
    // Topic choices are there too.
    expect(screen.getByRole('group', { name: 'Notify this device about' })).toBeInTheDocument();
  });

  it('respects a refusal', async () => {
    const server = withPushServer(true);
    const { pushManager } = browserWithPush('denied');
    renderRoute('/notifications');
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on for this device' }));
    expect(await screen.findByText(/Notifications are blocked for Wayora/)).toBeInTheDocument();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(server.saved).toEqual([]);
  });
});
