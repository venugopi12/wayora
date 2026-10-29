import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFakeAdminApi } from './fake-admin-api';
import { renderRoute } from './render';

afterEach(() => {
  vi.unstubAllGlobals();
});

const JOURNEY = { timeout: 20_000 };

describe('admin access (presentation follows the server)', JOURNEY, () => {
  it('sends signed-out visitors to sign in, then back to the admin page', async () => {
    installFakeAdminApi({ signedIn: false });
    const { router } = renderRoute('/admin/users');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toBe(`?redirect=${encodeURIComponent('/admin/users')}`);
  });

  it('shows ordinary users "no access" and never asks the admin API', async () => {
    const api = installFakeAdminApi({ role: 'user' });
    renderRoute('/admin');
    expect(
      await screen.findByRole('heading', { name: /you don’t have access/i }),
    ).toBeInTheDocument();
    expect(api.adminRequests()).toEqual([]);
    expect(screen.queryByRole('navigation', { name: 'Admin sections' })).toBeNull();
  });

  it('support staff get operations pages but not the audit log', async () => {
    const api = installFakeAdminApi({ role: 'support' });
    renderRoute('/admin');
    const nav = await screen.findByRole('navigation', { name: 'Admin sections' });
    const links = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent);
    expect(links).toEqual([
      'Overview',
      'Users',
      'Bookings',
      'Payments',
      'Search activity',
      'Notifications',
      'Platform health',
    ]);
    expect(within(nav).queryByRole('link', { name: 'Audit log' })).toBeNull();
    await screen.findByRole('heading', { level: 1, name: 'Overview' });

    // Typing the address doesn't help: the page refuses without even asking.
    const second = renderRoute('/admin/audit');
    expect(
      await second.findAllByRole('heading', { name: /you don’t have access/i }),
    ).not.toHaveLength(0);
    expect(api.adminRequests().some((r) => r.startsWith('/admin/audit-logs'))).toBe(false);
  });

  it('administrators see every section, including the audit log', async () => {
    installFakeAdminApi({ role: 'admin' });
    renderRoute('/admin/audit');
    const nav = await screen.findByRole('navigation', { name: 'Admin sections' });
    expect(within(nav).getByRole('link', { name: 'Audit log' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Audit log' })).toBeInTheDocument();
  });

  it('a role revoked mid-session turns the next page into "no access"', async () => {
    const api = installFakeAdminApi({ role: 'admin' });
    renderRoute('/admin');
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    api.setRole('user');
    fireEvent.click(screen.getByRole('link', { name: 'Users' }));
    expect(
      await screen.findByRole('heading', { name: /you don’t have access/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('the account menu links to the dashboard only for staff', async () => {
    const open = async () => {
      await screen.findByRole('heading', { level: 1 });
      fireEvent.keyDown(await screen.findByRole('button', { name: /account menu/i }), {
        key: 'Enter',
      });
      return screen.findByRole('menu');
    };
    installFakeAdminApi({ role: 'support' });
    const staff = renderRoute('/discover');
    expect(
      within(await open()).getByRole('menuitem', { name: 'Admin dashboard' }),
    ).toBeInTheDocument();
    staff.unmount();

    installFakeAdminApi({ role: 'user' });
    renderRoute('/discover');
    const menu = await open();
    expect(within(menu).getByRole('menuitem', { name: 'My trips' })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Admin dashboard' })).toBeNull();
  });
});

describe('admin pages', JOURNEY, () => {
  it('overview shows database counts, labels the time zone, and never shows demo money as revenue', async () => {
    const api = installFakeAdminApi();
    renderRoute('/admin');
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    expect(screen.getByText(/Last 7 days, in UTC/)).toBeInTheDocument();
    expect(await screen.findByText('42')).toBeInTheDocument();
    expect(screen.getByText('6 demo · 0 real · 17 all time')).toBeInTheDocument();
    const revenue = screen.getByRole('region', { name: 'Real revenue' });
    expect(revenue).toHaveTextContent(/None\. There are no succeeded live payments/);
    expect(screen.getByText(/No live payment provider is configured/)).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Time range'), { target: { value: '30d' } });
    await waitFor(() => expect(api.adminRequests()).toContain('/admin/overview?range=30d'));
    expect(await screen.findByText(/Last 30 days, in UTC/)).toBeInTheDocument();
  });

  it('users: filters live in the URL, pages load on demand, and rows open the detail view', async () => {
    const api = installFakeAdminApi();
    const { router } = renderRoute('/admin/users');
    const table = await screen.findByRole('table', { name: 'Users' });
    expect(within(table).getAllByRole('row')).toHaveLength(26); // header + 25
    expect(screen.getByText(/30 results · page 1 of 2/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(router.state.location.search).toBe('?page=2'));
    await waitFor(() =>
      expect(within(screen.getByRole('table', { name: 'Users' })).getAllByRole('row')).toHaveLength(
        6,
      ),
    );

    fireEvent.change(screen.getByLabelText('Name, email or user id'), {
      target: { value: 'traveller7@' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(router.state.location.search).toBe('?q=traveller7%40'));
    await waitFor(() =>
      expect(api.adminRequests()).toContain('/admin/users?q=traveller7%40&page=1'),
    );
    const filtered = await screen.findByRole('table', { name: 'Users' });
    await waitFor(() => expect(within(filtered).getAllByRole('row')).toHaveLength(2));

    fireEvent.click(within(filtered).getByRole('link', { name: 'Traveller G' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Traveller G' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Viewing this page is recorded in the audit log/)).toBeInTheDocument();
  });

  it('bookings: category and status filters, then a read-only detail view', async () => {
    const api = installFakeAdminApi();
    const { router } = renderRoute('/admin/bookings');
    const table = await screen.findByRole('table', { name: 'Bookings' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getAllByText('Demo')).toHaveLength(3);

    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'hotels' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'confirmed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(router.state.location.search).toBe('?serviceType=hotels&status=confirmed'),
    );
    await waitFor(() =>
      expect(api.adminRequests()).toContain(
        '/admin/bookings?serviceType=hotels&status=confirmed&page=1',
      ),
    );
    const filtered = await screen.findByRole('table', { name: 'Bookings' });
    await waitFor(() => expect(within(filtered).getAllByRole('row')).toHaveLength(2));

    fireEvent.click(within(filtered).getByRole('link', { name: 'WYD-AAAA-AAAA' }));
    await screen.findByRole('region', { name: 'Status history' });
    expect(screen.getByText('None (no supplier was contacted)')).toBeInTheDocument();
    expect(screen.getByText('•••• 3210')).toBeInTheDocument();
    expect(screen.getByText(/no ticket, PNR or real reservation exists/)).toBeInTheDocument();
    expect(within(screen.getByRole('main')).queryAllByRole('button')).toHaveLength(0);
  });

  it('payments: status and mode filters; demo attempts are labelled', async () => {
    const api = installFakeAdminApi();
    const { router } = renderRoute('/admin/payments');
    const table = await screen.findByRole('table', { name: 'Payment attempts' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } });
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'demo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(router.state.location.search).toBe('?status=failed&mode=demo'));
    await waitFor(() =>
      expect(api.adminRequests()).toContain('/admin/payments?status=failed&mode=demo&page=1'),
    );
    const filtered = await screen.findByRole('table', { name: 'Payment attempts' });
    await waitFor(() => expect(within(filtered).getAllByRole('row')).toHaveLength(2));
    expect(within(filtered).getByText('Failed')).toBeInTheDocument();
    expect(within(filtered).getByText('Demo')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'live' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('No payments match')).toBeInTheDocument();
  });

  it('audit log pages through entries', async () => {
    const api = installFakeAdminApi();
    const { router } = renderRoute('/admin/audit');
    const table = await screen.findByRole('table', { name: 'Audit entries' });
    expect(within(table).getAllByRole('row')).toHaveLength(26);
    expect(screen.getByText(/30 results · page 1 of 2/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(router.state.location.search).toBe('?page=2'));
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Audit entries' })).getAllByRole('row'),
      ).toHaveLength(6),
    );
    expect(api.adminRequests()).toContain('/admin/audit-logs?page=2');
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled();
  });

  it('shows an empty state, a not-found state and a retry after an error', async () => {
    const api = installFakeAdminApi({ users: [] });
    renderRoute('/admin/users');
    expect(await screen.findByText('No users match')).toBeInTheDocument();

    const missing = renderRoute('/admin/users/01890000-0000-7000-b000-999999999999');
    expect(await missing.findByText('There is no user with that id.')).toBeInTheDocument();

    api.failNext('/admin/health', 503, 'SERVICE_UNAVAILABLE');
    const broken = renderRoute('/admin/health');
    expect(await broken.findByText(/We couldn’t load platform health/)).toBeInTheDocument();
    fireEvent.click(broken.getAllByRole('button', { name: /Try again/ }).at(-1)!);
    expect(await broken.findByRole('heading', { name: 'Worker' })).toBeInTheDocument();
  });

  it('health shows "unknown" and "down" as such, never as healthy', async () => {
    installFakeAdminApi();
    renderRoute('/admin/health');
    const worker = await screen.findByRole('region', { name: 'Worker' });
    expect(within(worker).getByText('Unknown')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Redis' })).getByText('Down'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Job queue' })).getByText(
        'Queue depth is unknown.',
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Database' })).getByText('Healthy'),
    ).toBeInTheDocument();
    // Phase 21: the assistant's provider, labelled honestly when it's the demo.
    expect(
      within(screen.getByRole('region', { name: 'Travel assistant' })).getByText(
        /rule-based demo answers, not AI/,
      ),
    ).toBeInTheDocument();
  });

  it('on small screens the sections are in a menu', async () => {
    installFakeAdminApi();
    renderRoute('/admin');
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    fireEvent.click(screen.getByRole('button', { name: 'Admin menu' }));
    const dialog = await screen.findByRole('dialog', { name: 'Admin' });
    fireEvent.click(within(dialog).getByRole('link', { name: 'Platform health' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Platform health' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
