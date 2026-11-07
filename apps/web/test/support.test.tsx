import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFakeAccountApi } from './fake-account-api';
import { installFakeAdminApi } from './fake-admin-api';
import { demoBooking, installFakeBookingApi } from './fake-booking-api';
import {
  REF,
  customerTicket,
  installFakeAdminSupportApi,
  installFakeSupportApi,
  staffTicket,
} from './fake-support-api';
import { renderRoute } from './render';
import { hotel } from './search-fixtures';

/*
 * Customer support in the web app (Phase 27): the Help Center, a customer's
 * requests and conversation, booking-linked help, and the staff workspace.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const JOURNEY = { timeout: 20_000 };

describe('Help Center', () => {
  it('searches articles, browses topics and opens an article with its provider note and related links', async () => {
    renderRoute('/help');
    await screen.findByRole('heading', { level: 1, name: 'How can we help?' });
    const topics = screen.getByRole('heading', { name: 'Browse by topic' }).closest('section')!;
    expect(within(topics).getAllByRole('link')).toHaveLength(9);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search help articles' }), {
      target: { value: 'refund' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(
      await screen.findByRole('heading', { name: /articles? for “refund”/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('link', { name: /Refund states explained/ })[0]!);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Refund states explained' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Demo bookings')).toBeInTheDocument();
    const related = screen.getByRole('heading', { name: 'Related articles' }).closest('section')!;
    expect(within(related).getByRole('link', { name: /Cancelling a booking/ })).toHaveAttribute(
      'href',
      '/help/articles/cancelling-a-booking',
    );
    expect(screen.getByRole('link', { name: 'Contact support' })).toHaveAttribute(
      'href',
      '/support/new?category=refund&article=refund-states',
    );
  });

  it('marks provider rules as the provider’s, and says so when nothing matches', async () => {
    renderRoute('/help/articles/travel-id-and-visas');
    expect(await screen.findByText('Set by the provider, not Wayora')).toBeInTheDocument();
    const nav = renderRoute('/help?q=zzzqqq');
    expect(
      await nav.findByRole('heading', { name: 'No articles match “zzzqqq”' }),
    ).toBeInTheDocument();
    expect(nav.getAllByRole('link', { name: 'Contact support instead' })[0]).toHaveAttribute(
      'href',
      '/support/new',
    );
  });

  it('lists a topic’s articles', async () => {
    renderRoute('/help/topics/promotions');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Coupons and promotions' }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Coupons and promotions articles' })).getAllByRole(
        'listitem',
      ),
    ).toHaveLength(3);
    expect(
      screen.getByRole('link', { name: 'Coupons and promotions', current: 'page' }),
    ).toBeInTheDocument();
  });

  it('an unknown article is not found', async () => {
    renderRoute('/help/articles/not-a-real-article');
    expect(
      await screen.findAllByRole('heading', { name: /This page isn't on the map/ }),
    ).not.toHaveLength(0);
  });
});

describe('customer support', JOURNEY, () => {
  it('opens a request about a booking: validates, suggests articles, sends only what was written', async () => {
    const booking = demoBooking(hotel, { status: 'confirmed' });
    installFakeBookingApi({ results: [hotel], bookings: [booking] });
    const api = installFakeSupportApi({ tickets: [] });
    renderRoute(`/support/new?booking=${booking.reference}`);
    await screen.findByRole('heading', { level: 1, name: 'New support request' });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText('Choose what your request is about.')).toBeInTheDocument();
    expect(screen.getByText(/Describe what happened/)).toBeInTheDocument();
    expect(api.posts).toHaveLength(0);

    fireEvent.change(screen.getByRole('combobox', { name: 'Topic' }), {
      target: { value: 'refund' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Subject' }), {
      target: { value: 'Where is my refund' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /What happened/ }), {
      target: { value: 'I cancelled my hotel booking and want to know about the refund.' },
    });
    const suggestions = await screen.findByRole('region', {
      name: 'These articles might answer it',
    });
    expect(
      within(suggestions).getByRole('link', { name: /Refund states explained/ }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Booking' })).toHaveValue(booking.reference),
    );
    fireEvent.click(screen.getByRole('radio', { name: 'High' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText('Request sent')).toBeInTheDocument();
    expect(api.posts).toHaveLength(1);
    expect(api.posts[0]!.body).toEqual({
      subject: 'Where is my refund',
      category: 'refund',
      description: 'I cancelled my hotel booking and want to know about the refund.',
      priority: 'high',
      bookingReference: booking.reference,
      clientKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it('shows server-side field errors', async () => {
    installFakeAccountApi({ signedIn: true });
    installFakeSupportApi({ tickets: [] });
    renderRoute('/support/new?category=technical');
    await screen.findByRole('heading', { level: 1, name: 'New support request' });
    expect(screen.getByRole('combobox', { name: 'Topic' })).toHaveValue('technical');
    fireEvent.change(screen.getByRole('textbox', { name: 'Subject' }), {
      target: { value: 'Please fail this' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /What happened/ }), {
      target: { value: 'The page keeps showing an error when I open it.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText('Server says no.')).toBeInTheDocument();
  });

  it('lists requests, shows the conversation, marks replies read, replies and closes', async () => {
    installFakeAccountApi({ signedIn: true });
    const api = installFakeSupportApi();
    renderRoute('/support');
    const list = await screen.findByRole('list', { name: 'Your support requests' });
    expect(within(list).getByText('1 new reply')).toBeInTheDocument();
    fireEvent.click(within(list).getByRole('link', { name: /Payment taken twice/ }));

    const messages = await screen.findByRole('list', { name: 'Messages' });
    expect(within(messages).getAllByRole('listitem')).toHaveLength(3);
    expect(within(messages).getByText(/automatic message/)).toBeInTheDocument();
    expect(within(messages).getByText('Seen by support')).toBeInTheDocument();
    await waitFor(() =>
      expect(api.posts.find((p) => p.path.endsWith('/read'))?.body).toEqual({ seq: 3 }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Write a message first.')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Your reply' }), {
      target: { value: 'Thanks, any update?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Thanks, any update?');
    const sent = api.posts.find((p) => p.path.endsWith('/messages'))!;
    expect(sent.body).toEqual({ body: 'Thanks, any update?', clientKey: expect.any(String) });

    fireEvent.click(screen.getByRole('button', { name: 'I no longer need help' }));
    const dialog = await screen.findByRole('dialog', { name: 'Close this request?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close request' }));
    expect(await screen.findByText('This request is closed')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Your reply' })).toBeNull();
  });

  it('an unknown or someone else’s reference is "not found"; the empty list points to help', async () => {
    installFakeAccountApi({ signedIn: true });
    installFakeSupportApi({ tickets: [] });
    renderRoute('/support/WYS-2222-3333');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Request not found' }),
    ).toBeInTheDocument();
    renderRoute('/support');
    expect(await screen.findByText('No open requests')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Search the Help Center' })[0]).toHaveAttribute(
      'href',
      '/help',
    );
  });

  it('a booking’s page links to help with that booking and lists its requests', async () => {
    const booking = demoBooking(hotel, { status: 'confirmed' });
    installFakeBookingApi({ results: [hotel], bookings: [booking] });
    installFakeSupportApi({ tickets: [customerTicket({ bookingReference: booking.reference })] });
    renderRoute(`/trips/${booking.reference}`);
    const panel = await screen.findByRole('region', { name: 'Help with this booking' });
    expect(within(panel).getByRole('link', { name: 'Get help' })).toHaveAttribute(
      'href',
      `/support/new?booking=${booking.reference}`,
    );
    expect(await within(panel).findByRole('link', { name: 'Payment taken twice' })).toHaveAttribute(
      'href',
      `/support/${REF}`,
    );
  });
});

describe('support workspace', JOURNEY, () => {
  it('shows metrics with their definitions', async () => {
    installFakeAdminApi({ role: 'support' });
    installFakeAdminSupportApi('support');
    renderRoute('/admin/support');
    expect(await screen.findByText('First response (median)')).toBeInTheDocument();
    expect(screen.getByText('1.6 h')).toBeInTheDocument();
    expect(screen.getByText(/automatic acknowledgement doesn’t count/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Workload table' })).toHaveTextContent('Ravi Kumar');
  });

  it('support staff work a ticket: notes are marked staff-only, no assigning others, AI drafts need review', async () => {
    installFakeAdminApi({ role: 'support' });
    const api = installFakeAdminSupportApi('support');
    renderRoute(`/admin/support/tickets/${REF}`);
    const messages = await screen.findByRole('list', { name: 'Messages' });
    expect(within(messages).getByText('Internal note: staff only')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assign to me' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Assign to/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Suggest a reply' }));
    const draft = await screen.findByRole('region', { name: 'Suggested reply' });
    expect(draft).toHaveTextContent('Template (not AI)');
    expect(draft).toHaveTextContent('nothing has been sent');
    expect(within(draft).getByRole('list', { name: 'Check before using' })).toHaveTextContent(
      'Mentions a refund',
    );
    expect(api.posts.filter((p) => p.path.endsWith('/messages'))).toHaveLength(0);
    fireEvent.click(within(draft).getByRole('button', { name: 'Edit in the reply box' }));
    const box = screen.getByRole('textbox', { name: /^Reply/ });
    expect(box).toHaveValue(
      'Hello Asha, demo payments never take real money, so there is nothing to refund.',
    );
    fireEvent.change(box, { target: { value: 'Hello Asha, there was one demo payment only.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(api.posts.find((p) => p.path.endsWith('/messages'))).toBeDefined());
    expect(api.posts.find((p) => p.path.endsWith('/messages'))!.body).toMatchObject({
      body: 'Hello Asha, there was one demo payment only.',
      internal: false,
      aiAssisted: true,
    });

    fireEvent.click(screen.getByRole('radio', { name: 'Internal note' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Note \(staff only\)/ }), {
      target: { value: 'Checked the ledger' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() =>
      expect(api.posts.filter((p) => p.path.endsWith('/messages'))).toHaveLength(2),
    );
    expect(api.posts.filter((p) => p.path.endsWith('/messages'))[1]!.body).toMatchObject({
      internal: true,
      aiAssisted: false,
    });

    fireEvent.change(screen.getByRole('combobox', { name: 'Change to' }), {
      target: { value: 'resolved' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update status' }));
    await waitFor(() =>
      expect(api.posts.find((p) => p.path.endsWith('/status'))?.body).toMatchObject({
        status: 'resolved',
        revision: 6,
      }),
    );
  });

  it('administrators can assign to others; escalated tickets only to administrators', async () => {
    installFakeAdminApi({ role: 'admin' });
    installFakeAdminSupportApi('admin', {
      escalated: true,
      allowed: { ...staffTicket('admin').allowed, escalate: false, deEscalate: true },
    });
    renderRoute(`/admin/support/tickets/${REF}`);
    const select = await screen.findByRole('combobox', { name: /Assign to/ });
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2));
    expect(within(select).getByRole('option', { name: 'Meera Admin (admin)' })).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: /Ravi Kumar/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'De-escalate' })).toBeInTheDocument();
  });

  it('history shows status and priority labels, not stored codes, and names as they are', async () => {
    installFakeAdminApi({ role: 'admin' });
    const base = staffTicket('admin');
    const event = (seq: number, type: string, from: string | null, to: string | null) => ({
      seq,
      type,
      actor: { kind: 'staff', name: 'Meera Admin' },
      from,
      to,
      reason: null,
      internal: type !== 'status_changed',
      at: base.history[0]!.at,
    });
    installFakeAdminSupportApi('admin', {
      history: [
        ...base.history,
        event(2, 'status_changed', 'OPEN', 'WAITING_FOR_CUSTOMER'),
        event(3, 'priority_changed', 'NORMAL', 'HIGH'),
        event(4, 'assigned', null, 'Ravi Kumar'),
      ] as typeof base.history,
    });
    renderRoute(`/admin/support/tickets/${REF}`);
    const history = await screen.findByRole('list', { name: 'Ticket history' });
    expect(history).toHaveTextContent(': — → Open');
    expect(history).toHaveTextContent('Status changed: Open → Waiting for customer');
    expect(history).toHaveTextContent('Priority changed: Normal → High');
    expect(history).toHaveTextContent('Assigned: — → Ravi Kumar');
    expect(history).not.toHaveTextContent(/WAITING_FOR|OPEN|HIGH/);
  });

  it('the queue shows status, priority, assignee and waiting customers', async () => {
    installFakeAdminApi({ role: 'support' });
    installFakeAdminSupportApi('support');
    renderRoute('/admin/support/tickets');
    const table = await screen.findByRole('region', { name: 'Tickets table' });
    expect(table).toHaveTextContent('Payment taken twice');
    expect(table).toHaveTextContent('Customer waiting');
    expect(table).toHaveTextContent('Unassigned');
    expect(table).not.toHaveTextContent('asha@example.com');
  });
});
