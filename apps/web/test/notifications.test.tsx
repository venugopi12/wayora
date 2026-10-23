import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { notificationSchema, type Notification } from '@wayora/contracts';
import { demoBooking, installFakeBookingApi } from './fake-booking-api';
import { renderRoute } from './render';
import { hotel } from './search-fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
});

const JOURNEY = { timeout: 20_000 };
const booking = demoBooking(hotel);

let seq = 0;
function note(overrides: Partial<Notification> = {}): Notification {
  seq += 1;
  return notificationSchema.parse({
    id: `01890000-0000-7000-a000-${String(seq).padStart(12, '0')}`,
    type: 'booking_confirmed',
    category: 'booking',
    title: `Demo booking confirmed ${seq}`,
    message: `Booking ${booking.reference} has a demo confirmation. No supplier was contacted.`,
    demo: true,
    read: false,
    readAt: null,
    createdAt: new Date(Date.now() - seq * 60_000).toISOString(),
    link: { kind: 'booking', bookingReference: booking.reference },
    ...overrides,
  });
}

function setup(notifications: Notification[]) {
  return installFakeBookingApi({ results: [hotel], bookings: [booking], notifications });
}

const bell = (name: RegExp = /^Notifications/) => screen.findByRole('button', { name });

describe('the notification bell', JOURNEY, () => {
  it('shows the unread count, capped at 99+, and nothing for signed-out visitors', async () => {
    setup([note(), note(), note({ read: true, readAt: new Date().toISOString() })]);
    const { unmount } = renderRoute('/');
    const button = await bell(/Notifications, 2 unread/);
    expect(button).toHaveTextContent('2');
    unmount();

    setup(Array.from({ length: 120 }, () => note()));
    const second = renderRoute('/');
    expect(await bell(/Notifications, 120 unread/)).toHaveTextContent('99+');
    second.unmount();

    installFakeBookingApi({ results: [hotel], signedIn: false });
    renderRoute('/');
    await screen.findAllByRole('link', { name: /sign in/i });
    expect(screen.queryByRole('button', { name: /^Notifications/ })).toBeNull();
  });

  it('shows no number when the count can’t be loaded', async () => {
    const api = setup([note()]);
    api.failNotifications(/unread-count/, 5);
    renderRoute('/');
    const button = await bell(/unread count unavailable/);
    expect(button.textContent?.trim()).toBe('');
  });

  it('is on the header at every size (not only in the desktop group)', async () => {
    setup([note()]);
    renderRoute('/');
    const button = await bell(/1 unread/);
    expect(button.closest('.hidden')).toBeNull();
  });
});

describe('the notification panel', JOURNEY, () => {
  it('lists the latest notifications as plain text, with unread marks', async () => {
    setup([
      note({ title: '<img src=x onerror="alert(1)">Demo payment succeeded' }),
      note({ read: true, readAt: new Date().toISOString(), title: 'Older one' }),
    ]);
    renderRoute('/');
    fireEvent.click(await bell(/1 unread/));
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    const list = await within(panel).findByRole('list', { name: 'Latest notifications' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    // Text, never HTML.
    expect(panel.querySelector('img')).toBeNull();
    expect(panel).toHaveTextContent('<img src=x onerror="alert(1)">Demo payment succeeded');
    expect(within(list).getAllByRole('article')[0]).toHaveAccessibleName(/\(unread\)/);
    expect(within(list).getAllByRole('article')[1]).not.toHaveAccessibleName(/\(unread\)/);
    expect(within(list).getAllByText('Demo')).toHaveLength(2);
  });

  it('marks one as read and refreshes the count', async () => {
    const api = setup([note({ title: 'First' }), note({ title: 'Second' })]);
    renderRoute('/');
    fireEvent.click(await bell(/2 unread/));
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    fireEvent.click(await within(panel).findByRole('button', { name: 'Mark as read: First' }));
    await waitFor(() => expect(api.notifications[0]!.read).toBe(true));
    expect(await bell(/1 unread/)).toBeInTheDocument();
    await waitFor(() =>
      expect(within(panel).queryByRole('button', { name: 'Mark as read: First' })).toBeNull(),
    );
    expect(screen.getByText('Marked “First” as read.')).toBeInTheDocument();
  });

  it('marks all as read, announces it, and the badge goes', async () => {
    const api = setup([note(), note(), note()]);
    renderRoute('/');
    fireEvent.click(await bell(/3 unread/));
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    const all = within(panel).getByRole('button', { name: 'Mark all as read' });
    await waitFor(() => expect(all).toBeEnabled());
    fireEvent.click(all);
    expect(await bell(/none unread/)).toBeInTheDocument();
    expect(api.notifications.every((n) => n.read)).toBe(true);
    expect(screen.getByText('All notifications marked as read.')).toBeInTheDocument();
    await waitFor(() => expect(all).toBeDisabled());
  });

  it('opens the related booking, marks it read and closes the panel', async () => {
    const api = setup([note({ title: 'Go here' })]);
    const { router } = renderRoute('/');
    fireEvent.click(await bell(/1 unread/));
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    fireEvent.click(await within(panel).findByRole('link', { name: 'View booking: Go here' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/trips/${booking.reference}`));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull());
    await waitFor(() => expect(api.notifications[0]!.read).toBe(true));
  });

  it('links a payment notification to its payment page', async () => {
    const paymentId = '01890000-0000-7000-9000-000000000001';
    setup([
      note({
        type: 'payment_succeeded',
        category: 'payment',
        title: 'Demo payment succeeded',
        link: { kind: 'payment', bookingReference: booking.reference, paymentId },
      }),
    ]);
    renderRoute('/');
    fireEvent.click(await bell(/1 unread/));
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    expect(
      await within(panel).findByRole('link', { name: 'View payment: Demo payment succeeded' }),
    ).toHaveAttribute('href', `/trips/${booking.reference}/payments/${paymentId}`);
  });

  it('has an empty state for new accounts', async () => {
    setup([]);
    renderRoute('/');
    fireEvent.click(await bell(/none unread/));
    expect(await screen.findByText('No notifications yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeDisabled();
  });

  it('shows loading, then an error with a working retry', async () => {
    const api = setup([note({ title: 'Back again' })]);
    api.failNotifications(/^\/notifications$/, 2);
    renderRoute('/');
    fireEvent.click(await bell(/1 unread/));
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    expect(
      within(panel).getByRole('status', { name: 'Loading notifications' }),
    ).toBeInTheDocument();
    expect(
      await within(panel).findByText('We couldn’t load your notifications.', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Try again' }));
    expect(await within(panel).findByText('Back again')).toBeInTheDocument();
  });

  it('moves focus into the panel, and Escape returns it to the bell', async () => {
    setup([note()]);
    renderRoute('/');
    const button = await bell(/1 unread/);
    button.focus();
    fireEvent.click(button);
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button));
  });
});

describe('the notifications page', JOURNEY, () => {
  it('pages through notifications, marks all read, and shows that email isn’t active', async () => {
    const api = setup(Array.from({ length: 25 }, (_, i) => note({ title: `Item ${i + 1}` })));
    renderRoute('/notifications');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Notifications' }),
    ).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Notifications' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(20);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Notifications' })).getAllByRole('listitem'),
      ).toHaveLength(5),
    );
    expect(screen.getByText('Item 25')).toBeInTheDocument();

    expect(await screen.findByText('Email isn’t active')).toBeInTheDocument();
    const payments = screen.getByRole('checkbox', { name: /Payment updates/ });
    expect(payments).toBeChecked();
    fireEvent.click(payments);
    await waitFor(() => expect(api.preferencePatches).toEqual([{ emailPayments: false }]));
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /Payment updates/ })).not.toBeChecked(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));
    expect(await screen.findByText('All read.')).toBeInTheDocument();
    expect(await bell(/none unread/)).toBeInTheDocument();
  });

  it('is in the account navigation', async () => {
    setup([]);
    renderRoute('/notifications');
    const nav = await screen.findByRole('navigation', { name: 'Account' });
    expect(within(nav).getByRole('link', { name: 'Notifications' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await screen.findByText('No notifications yet')).toBeInTheDocument();
  });
});
