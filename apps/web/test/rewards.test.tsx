import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOYALTY_RULES,
  ROLE_PERMISSIONS,
  adminUserRewardsSchema,
  type AdminUserRewards,
  type Booking,
  type RewardTransaction,
  type UserRole,
} from '@wayora/contracts';
import { payPath } from '../src/features/bookings/paths';
import { toMinor } from '../src/features/rewards/CheckoutRewards';
import { installFakeAccountApi } from './fake-account-api';
import { installFakeAdminApi } from './fake-admin-api';
import { demoBooking, installFakeBookingApi, unpaidDemo } from './fake-booking-api';
import { installFakeRewardsApi } from './fake-rewards-api';
import { renderRoute } from './render';
import { hotel } from './search-fixtures';

/*
 * Rewards in the web app (Phase 25): the dashboard, checkout redemption and
 * the admin views. The client only shows what the server calculated.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const JOURNEY = { timeout: 20_000 };

const tx = (i: number, over: Partial<RewardTransaction> = {}): RewardTransaction => ({
  id: `01890000-0000-7000-8000-${String(i).padStart(12, '0')}`,
  mode: 'demo',
  type: 'points_earned',
  origin: 'automated',
  points: 100 + i,
  balanceAfter: 1000 + i,
  amount: null,
  description: `Earned ${100 + i} points on booking WYD-AAAA-BBB${i % 10}`,
  bookingReference: null,
  creditReference: null,
  ruleVersion: 1,
  createdAt: '2026-10-20T10:00:00.000Z',
  ...over,
});

describe('rewards dashboard', () => {
  it('shows the balance, tier progress, credit, history and the rules, all labelled demo', async () => {
    installFakeAccountApi({ signedIn: true });
    const rewards = installFakeRewardsApi({
      balance: 1_234,
      credit: '50000',
      credits: [
        {
          reference: 'WYC-7KQ2-M9XD',
          mode: 'demo',
          original: { amountMinor: '50000', currency: 'INR' },
          remaining: { amountMinor: '50000', currency: 'INR' },
          reason: 'support_compensation',
          note: 'Sorry about the delay',
          status: 'active',
          issuedAt: '2026-10-01T00:00:00.000Z',
          expiresAt: null,
          bookingReference: null,
        },
      ],
      history: Array.from({ length: 20 }, (_, i) => tx(i + 1)),
    });
    renderRoute('/rewards');
    expect(await screen.findByRole('heading', { level: 1, name: 'Rewards' })).toBeInTheDocument();
    expect(await screen.findByText('1,234 pts')).toBeInTheDocument();
    expect(screen.getByText('Demo rewards')).toBeInTheDocument();
    expect(screen.getByText(/no cash value/)).toBeInTheDocument();
    expect(screen.getByText(/Worth ₹308.50 off/)).toBeInTheDocument();
    const progress = screen.getByRole('progressbar', { name: 'Progress to Silver' });
    expect(progress).toHaveAttribute('aria-valuenow', '500');
    expect(progress).toHaveAttribute('aria-valuemax', '2000');
    expect(screen.getByText(/1,500 pts more qualifying to reach Silver/)).toBeInTheDocument();
    expect(screen.getAllByText('₹500').length).toBeGreaterThan(0);
    expect(screen.getByText('WYC-7KQ2-M9XD')).toBeInTheDocument();
    expect(screen.getByText(/Not a cash refund/)).toBeInTheDocument();

    // Monthly table: only months with activity.
    const months = screen.getByRole('table', { name: 'Points earned and used per month' });
    expect(within(months).getAllByRole('row')).toHaveLength(2);

    // History pages (15 per page) and filters.
    const history = await screen.findByRole('list', { name: 'Rewards history' });
    expect(within(history).getAllByRole('listitem')).toHaveLength(15);
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Rewards history' })).getAllByRole('listitem'),
      ).toHaveLength(5),
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Show' }), {
      target: { value: 'credits' },
    });
    expect(await screen.findByText('Nothing here yet')).toBeInTheDocument();
    expect(rewards.requests.some((r) => r.includes('kind=credits'))).toBe(true);

    // The rules, as the server states them.
    const rules = screen.getByRole('region', { name: 'How rewards work' });
    expect(rules).toHaveTextContent('1 point per ₹10 actually paid');
    expect(rules).toHaveTextContent('1 point = ₹0.25 off');
    expect(within(rules).getAllByRole('row')).toHaveLength(DEFAULT_LOYALTY_RULES.tiers.length + 1);
    expect(rules).toHaveTextContent(/no other perks are promised/);
  });

  it('is in the account navigation, and recovers from a failed load', async () => {
    installFakeAccountApi({ signedIn: true });
    const rewards = installFakeRewardsApi();
    rewards.failNext(/^\/rewards$/);
    renderRoute('/rewards');
    expect(await screen.findByText("We couldn't load your rewards")).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Account' });
    expect(within(nav).getByRole('link', { name: 'Rewards' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('0 pts')).toBeInTheDocument();
    expect(screen.getByText(/Earn points on paid demo bookings/)).toBeInTheDocument();
  });
});

describe('rewards at checkout', JOURNEY, () => {
  function setup(options: Parameters<typeof installFakeRewardsApi>[0] = {}) {
    const pending: Booking = demoBooking(hotel, { status: 'pending', payment: unpaidDemo(hotel) });
    const api = installFakeBookingApi({ results: [hotel], bookings: [pending], payments: 'demo' });
    const rewards = installFakeRewardsApi({ bookings: api.store, ...options });
    return { api, rewards, booking: pending };
  }

  it('needs an explicit confirmation, sends only the choice, and pays what the server says is left', async () => {
    const { api, rewards, booking } = setup({ balance: 5_000 });
    renderRoute(payPath(booking.reference));
    const panel = await screen.findByRole('region', { name: 'Rewards' });
    await within(panel).findByText(/You have 5,000 pts/);
    expect(panel).toHaveTextContent('you can use 200 pts to 5,000 pts');

    const pointsBox = within(panel).getByRole('textbox', { name: /Points to use/ });
    fireEvent.change(pointsBox, { target: { value: '2000' } });
    expect(panel).toHaveTextContent('≈ ₹500 off');
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply rewards' }));
    expect(
      await within(panel).findByText('Confirm that you want to use these rewards.'),
    ).toBeInTheDocument();
    expect(rewards.puts).toHaveLength(0);

    fireEvent.click(
      within(panel).getByRole('checkbox', { name: /Use these rewards on this booking/ }),
    );
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply rewards' }));
    await within(panel).findByText(/Applied:/);
    expect(rewards.puts).toEqual([{ points: 2000, creditAmountMinor: '0', confirm: true }]);
    // The amount to pay comes back from the server (₹23,400 − ₹500).
    const pay = await screen.findByRole('button', { name: 'Pay ₹22,900 (demo)' });
    expect(screen.getByRole('complementary', { name: 'Amount and payment' })).toHaveTextContent(
      '−₹500',
    );
    fireEvent.click(pay);
    await waitFor(() => expect(api.paymentPosts).toHaveLength(1));
    expect(api.paymentPosts[0]!.body).toMatchObject({
      amount: { amountMinor: '2290000', currency: 'INR' },
    });
  });

  it('shows the server’s refusal, and gives rewards back on Remove', async () => {
    const { rewards, booking } = setup({ balance: 5_000 });
    renderRoute(payPath(booking.reference));
    const panel = await screen.findByRole('region', { name: 'Rewards' });
    const box = await within(panel).findByRole('textbox', { name: /Points to use/ });
    fireEvent.change(box, { target: { value: '150' } });
    fireEvent.click(within(panel).getByRole('checkbox', { name: /Use these rewards/ }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply rewards' }));
    expect(await within(panel).findByText('Use at least 200 points, or none.')).toBeInTheDocument();
    // Not a number at all: refused before asking the server.
    fireEvent.change(box, { target: { value: '12.5' } });
    fireEvent.click(within(panel).getByRole('checkbox', { name: /Use these rewards/ }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply rewards' }));
    expect(await within(panel).findByText('Enter a whole number of points.')).toBeInTheDocument();
    expect(rewards.puts).toHaveLength(1);

    fireEvent.click(within(panel).getByRole('button', { name: 'Use the most points allowed' }));
    fireEvent.click(within(panel).getByRole('checkbox', { name: /Use these rewards/ }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply rewards' }));
    await within(panel).findByText(/Applied:/);
    expect(rewards.balance).toBe(0);
    fireEvent.click(within(panel).getByRole('button', { name: 'Remove' }));
    await screen.findByRole('button', { name: 'Pay ₹23,400 (demo)' });
    expect(rewards.balance).toBe(5_000);
  });

  it('says so when there is nothing to use, and keeps the payment usable if rewards fail to load', async () => {
    const { rewards, booking } = setup();
    rewards.failNext(/rewards$/);
    renderRoute(payPath(booking.reference));
    expect(await screen.findByText(/You can still pay without them/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Pay ₹23,400 (demo)' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByText(/You don’t have any points or travel credit to use yet/),
    ).toBeInTheDocument();
  });
});

describe('money input without floating point', () => {
  it('converts whole units to minor units exactly', () => {
    expect(toMinor('250')).toBe(25_000n);
    expect(toMinor('250.5')).toBe(25_050n);
    expect(toMinor('₹1,234.05')).toBe(123_405n);
    expect(toMinor('0.1')).toBe(10n);
    expect(toMinor('')).toBe(0n);
    expect(toMinor('1.234')).toBeNull();
    expect(toMinor('-5')).toBeNull();
    expect(toMinor('1e3')).toBeNull();
  });
});

describe('admin rewards', JOURNEY, () => {
  const USER = '01890000-0000-7000-8000-000000000001';
  function setup(role: UserRole) {
    const base = installFakeAdminApi({ role });
    const next = globalThis.fetch;
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    let view: AdminUserRewards = adminUserRewardsSchema.parse({
      userId: USER,
      name: 'Asha Rao',
      accounts: [
        {
          mode: 'demo',
          pointsBalance: 700,
          ledgerSum: 700,
          tier: {
            id: 'explorer',
            name: 'Explorer',
            earnMultiplierBps: 10_000,
            qualifyingPoints: 0,
            keptUntil: null,
            next: null,
          },
        },
      ],
      credits: [],
      recent: [{ ...tx(1), userId: USER, reason: null, actorType: 'system' }],
    });
    const allowed = (p: 'admin.rewards.read' | 'admin.rewards.manage') =>
      ROLE_PERMISSIONS[role].includes(p);
    const res = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const path = url.pathname.replace('/api/v1', '');
        if (!path.startsWith('/admin/rewards')) return next(input, init);
        const write = (init?.method ?? 'GET') !== 'GET';
        if (!allowed(write ? 'admin.rewards.manage' : 'admin.rewards.read')) {
          return res(403, {
            error: { code: 'FORBIDDEN', message: 'You don’t have access to this.', requestId: 'r' },
          });
        }
        const meta = { requestId: 'r' };
        if (path === `/admin/rewards/users/${USER}` && !write)
          return res(200, { data: view, meta });
        if (path === `/admin/rewards/users/${USER}/adjustments`) {
          const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
          posts.push({ path, body });
          view = {
            ...view,
            accounts: [
              {
                ...view.accounts[0]!,
                pointsBalance: 700 + Number(body.points),
                ledgerSum: 700 + Number(body.points),
              },
            ],
          };
          return res(201, { data: view, meta });
        }
        if (path === '/admin/rewards/transactions') {
          return res(200, {
            data: {
              items: view.recent,
              pagination: { page: 1, pageSize: 25, totalResults: 1, totalPages: 1 },
            },
            meta,
          });
        }
        return res(404, { error: { code: 'NOT_FOUND', message: 'Not found.', requestId: 'r' } });
      }),
    );
    return { base, posts };
  }

  it('support staff can read a customer’s rewards but get no forms to change them', async () => {
    setup('support');
    renderRoute(`/admin/rewards/users/${USER}`);
    expect(await screen.findAllByText('700 pts', { selector: 'dd' })).toHaveLength(2); // balance = ledger sum
    expect(screen.getByText(/needs an administrator/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record adjustment' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Issue credit' })).toBeNull();
  });

  it('admins adjust with a reason and a one-time key', async () => {
    const { posts } = setup('admin');
    renderRoute(`/admin/rewards/users/${USER}`);
    const button = await screen.findByRole('button', { name: 'Record adjustment' });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: /^Points/ }), {
      target: { value: '300' },
    });
    const reasons = screen.getAllByRole('textbox', { name: /^Reason/ });
    fireEvent.change(reasons[0]!, { target: { value: 'Goodwill after a support call' } });
    fireEvent.click(button);
    await screen.findByText('300 points recorded.');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({
      mode: 'demo',
      points: 300,
      reason: 'Goodwill after a support call',
    });
    expect(posts[0]!.body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findAllByText('1,000 pts', { selector: 'dd' })).toHaveLength(2);
  });

  it('lists the ledger for support staff with its origin', async () => {
    setup('support');
    renderRoute('/admin/rewards');
    const table = await screen.findByRole('region', { name: 'Reward transactions table' });
    expect(table).toHaveTextContent('Points earned');
    expect(table).toHaveTextContent('Automated');
  });
});
