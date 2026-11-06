import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Booking } from '@wayora/contracts';
import { payPath } from '../src/features/bookings/paths';
import { installFakeAdminApi } from './fake-admin-api';
import { demoBooking, installFakeBookingApi, unpaidDemo } from './fake-booking-api';
import {
  PROMO_ID,
  installFakeAdminPromotionsApi,
  installFakePromotionsApi,
  offer,
} from './fake-promotions-api';
import { installFakeRewardsApi } from './fake-rewards-api';
import { renderRoute } from './render';
import { hotel } from './search-fixtures';

/*
 * Promotions in the web app (Phase 26): checkout coupons and the breakdown,
 * the offers page and homepage section, and the admin views. The client only
 * sends a code and shows what the server calculated.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const JOURNEY = { timeout: 20_000 };

describe('coupons at checkout', JOURNEY, () => {
  function setup(options: Parameters<typeof installFakePromotionsApi>[0] = {}) {
    const pending: Booking = demoBooking(hotel, { status: 'pending', payment: unpaidDemo(hotel) });
    const api = installFakeBookingApi({ results: [hotel], bookings: [pending], payments: 'demo' });
    installFakeRewardsApi({ bookings: api.store });
    const promotions = installFakePromotionsApi({ bookings: api.store, ...options });
    return { api, promotions, booking: pending };
  }

  it('applies a code, shows the server’s breakdown, and pays what is left', async () => {
    const { api, promotions, booking } = setup();
    renderRoute(payPath(booking.reference));
    const panel = await screen.findByRole('region', { name: 'Offers and coupons' });
    const box = await within(panel).findByRole('textbox', { name: 'Coupon code' });
    fireEvent.change(box, { target: { value: ' save10 ' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    const list = await within(panel).findByRole('list', { name: 'Applied offers' });
    expect(list).toHaveTextContent('Coupon SAVE10');
    expect(list).toHaveTextContent('−₹1,000');
    // Only the code goes to the server; no amount, no discount.
    expect(promotions.puts).toEqual([{ code: 'save10' }]);
    expect(await within(panel).findByText(/Coupon SAVE10 applied: ₹1,000 off/)).toHaveAttribute(
      'role',
      'status',
    );

    const dl = await screen.findByLabelText('Price breakdown');
    expect(dl).toHaveTextContent('Original price₹23,400');
    expect(dl).toHaveTextContent('Coupon SAVE10−₹1,000');
    expect(dl).toHaveTextContent('To pay₹22,400');
    // The demo note sits next to the list (a <dl> holds only its rows).
    expect(dl.parentElement).toHaveTextContent(/no real money moves/);

    fireEvent.click(await screen.findByRole('button', { name: 'Pay ₹22,400 (demo)' }));
    await waitFor(() => expect(api.paymentPosts).toHaveLength(1));
    expect(api.paymentPosts[0]!.body).toMatchObject({
      amount: { amountMinor: '2240000', currency: 'INR' },
    });
  });

  it('explains a refused code, and Remove restores the full price', async () => {
    const { promotions, booking } = setup();
    renderRoute(payPath(booking.reference));
    const panel = await screen.findByRole('region', { name: 'Offers and coupons' });
    const box = await within(panel).findByRole('textbox', { name: 'Coupon code' });

    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(await within(panel).findByText('Enter a coupon code.')).toBeInTheDocument();
    expect(promotions.puts).toHaveLength(0);

    fireEvent.change(box, { target: { value: 'OLDDEAL' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(await within(panel).findByText('This coupon has expired.')).toBeInTheDocument();
    expect(box).toHaveAccessibleDescription(/This coupon has expired/);

    fireEvent.change(box, { target: { value: 'SAVE10' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await screen.findByRole('button', { name: 'Pay ₹22,400 (demo)' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Remove coupon SAVE10' }));
    await screen.findByRole('button', { name: 'Pay ₹23,400 (demo)' });
    expect(within(panel).queryByRole('list', { name: 'Applied offers' })).toBeNull();
  });

  it('shows the server’s notice when the price changed before payment', async () => {
    const { booking } = setup({
      notice: {
        code: 'COUPON_EXPIRED',
        message: 'Coupon SAVE10 is no longer valid (this coupon has expired), so it was removed.',
        at: '2026-10-20T10:00:00.000Z',
      },
    });
    renderRoute(payPath(booking.reference));
    const panel = await screen.findByRole('region', { name: 'Offers and coupons' });
    expect(await within(panel).findByText(/Coupon SAVE10 is no longer valid/)).toBeInTheDocument();
    expect(within(panel).getByText('Your price changed')).toBeInTheDocument();
  });
});

describe('offer discovery', () => {
  it('lists real offers with their conditions, terms and code, and no countdown', async () => {
    installFakeBookingApi({ results: [hotel] });
    installFakePromotionsApi({
      offers: [
        offer(),
        offer({
          id: '01890000-0000-7000-8000-00000000a003',
          kind: 'automatic',
          code: null,
          name: 'Weekend stays',
          discountType: 'fixed',
          percentBps: null,
          amount: { amountMinor: '50000', currency: 'INR' },
          maxDiscount: null,
          minAmount: null,
          categories: [],
        }),
      ],
    });
    renderRoute('/promotions');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Offers and coupons' }),
    ).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Current offers' });
    const cards = within(list).getAllByRole('article');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent('Ten off hotels');
    expect(cards[0]).toHaveTextContent('SAVE10');
    expect(cards[0]).toHaveTextContent(/Hotels/);
    expect(cards[1]).toHaveTextContent('No code needed');
    expect(within(cards[0]!).getByText('Terms and conditions')).toBeInTheDocument();
    expect(within(cards[0]!).getByRole('button', { name: 'Copy code SAVE10' })).toBeInTheDocument();
    // No invented urgency.
    expect(list).not.toHaveTextContent(/hurry|left!|hours left|ends in/i);
  });

  it('says so when nothing is running', async () => {
    installFakeBookingApi({ results: [hotel] });
    installFakePromotionsApi({ offers: [] });
    renderRoute('/promotions');
    expect(await screen.findByText('No offers right now')).toBeInTheDocument();
  });

  it('shows running offers on the homepage, and nothing when there are none', async () => {
    installFakeBookingApi({ results: [hotel] });
    installFakePromotionsApi();
    renderRoute('/');
    const section = await screen.findByRole('region', { name: 'Running now' });
    expect(within(section).getByRole('link', { name: /All offers/ })).toHaveAttribute(
      'href',
      '/promotions',
    );
    expect(section).toHaveTextContent('Ten off hotels');
  });
});

describe('admin promotions', JOURNEY, () => {
  it('support staff can read performance and usage but get no forms', async () => {
    installFakeAdminApi({ role: 'support' });
    installFakeAdminPromotionsApi('support');
    renderRoute(`/admin/promotions/${PROMO_ID}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ten off hotels' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Discount given (redeemed)').nextSibling).toHaveTextContent('₹7,000');
    const usage = await screen.findByRole('region', { name: 'Promotion usage table' });
    expect(usage).toHaveTextContent('WYD-7KQ2-M9XD');
    expect(usage).toHaveTextContent('Redeemed');
    expect(screen.getByText(/needs an administrator/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit configuration' })).toBeNull();
  });

  it('lists promotions for support staff without a create link', async () => {
    installFakeAdminApi({ role: 'support' });
    installFakeAdminPromotionsApi('support');
    renderRoute('/admin/promotions');
    const table = await screen.findByRole('region', { name: 'Promotions table' });
    expect(table).toHaveTextContent('SAVE10');
    expect(table).toHaveTextContent('7 redeemed');
    expect(screen.queryByRole('link', { name: 'New promotion' })).toBeNull();
  });

  it('admins deactivate with a reason', async () => {
    installFakeAdminApi({ role: 'admin' });
    const { writes } = installFakeAdminPromotionsApi('admin');
    renderRoute(`/admin/promotions/${PROMO_ID}`);
    fireEvent.change(await screen.findByRole('textbox', { name: /^Reason/ }), {
      target: { value: 'Budget for this campaign is used up' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(await screen.findByRole('button', { name: 'Activate' })).toBeInTheDocument();
    expect(writes).toEqual([
      {
        method: 'POST',
        path: `/admin/promotions/${PROMO_ID}/status`,
        body: { active: false, reason: 'Budget for this campaign is used up' },
      },
    ]);
  });

  it('admins create a coupon; amounts go as minor units and percent as basis points', async () => {
    installFakeAdminApi({ role: 'admin' });
    const { writes } = installFakeAdminPromotionsApi('admin');
    renderRoute('/admin/promotions/new');
    await screen.findByRole('heading', { level: 1, name: 'New promotion' });
    const set = (name: RegExp, value: string) =>
      fireEvent.change(screen.getByLabelText(name), { target: { value } });
    set(/^Code/, 'monsoon15');
    set(/^Name/, 'Monsoon stays');
    set(/^Description/, '12.5% off hotels');
    set(/^Terms and conditions/, 'One use per customer while the campaign runs.');
    set(/^Percent off/, '12.5');
    set(/^Maximum discount/, '1500.50');
    set(/^Minimum booking/, '5000');
    set(/^Starts/, '2026-11-01T00:00');
    set(/^Ends/, '2026-11-30T23:59');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hotels' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create promotion' }));
    await screen.findByRole('heading', { level: 1, name: 'Monsoon stays' });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toMatchObject({
      kind: 'coupon',
      code: 'monsoon15',
      discountType: 'percentage',
      percentBps: 1_250,
      maxDiscountMinor: '150050',
      minAmountMinor: '500000',
      currency: 'INR',
      categories: ['hotels'],
      startsAt: '2026-11-01T00:00:00+05:30',
      endsAt: '2026-11-30T23:59:00+05:30',
      perUserLimit: 1,
      usageLimit: null,
    });
  });

  it('shows the server’s refusal when a code is taken', async () => {
    installFakeAdminApi({ role: 'admin' });
    installFakeAdminPromotionsApi('admin');
    renderRoute('/admin/promotions/new');
    await screen.findByRole('heading', { level: 1, name: 'New promotion' });
    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: 'TAKEN' } });
    fireEvent.change(screen.getByLabelText(/^Percent off/), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create promotion' }));
    expect(await screen.findByText('That code is already used.')).toBeInTheDocument();
  });
});
