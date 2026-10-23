import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_PAYMENT_NOTICE, type Booking } from '@wayora/contracts';
import { bookPath, payPath, paymentPath, tripPath } from '../src/features/bookings/paths';
import { demoBooking, installFakeBookingApi, unpaidDemo } from './fake-booking-api';
import { renderRoute } from './render';
import { DATE, hotel } from './search-fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SEARCH = `location=city%3Agoa&checkIn=${DATE}`;
// Whole journeys through the real route table: slower than unit tests in jsdom.
const JOURNEY = { timeout: 20_000 };

/** A hotel booking waiting for its demo payment, and the API around it. */
function setup(booking: Partial<Parameters<typeof demoBooking>[1]> = {}) {
  const pending: Booking = demoBooking(hotel, {
    status: 'pending',
    payment: unpaidDemo(hotel),
    ...booking,
  });
  const api = installFakeBookingApi({ results: [hotel], bookings: [pending], payments: 'demo' });
  return { api, booking: pending };
}

/** The payment page's live region (the header bell has its own). */
const paymentStatusRegion = () =>
  screen.getAllByRole('status').find((el) => el.textContent?.startsWith('Payment status:'))!;

const payButton = () => screen.findByRole('button', { name: 'Pay ₹23,400 (demo)' });

describe('the demo payment step', JOURNEY, () => {
  it('a booking that needs a payment goes from checkout to the payment review', async () => {
    const api = installFakeBookingApi({ results: [hotel], payments: 'demo' });
    const { router } = renderRoute(
      `${bookPath('hotels', hotel.id, api.response.searchId, SEARCH)}&step=details`,
    );
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
    fireEvent.click(screen.getByRole('button', { name: 'Confirm demo booking' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Pay for your demo booking' }),
    ).toBeInTheDocument();
    const reference = api.store[0]!.reference;
    expect(router.state.location.pathname).toBe(payPath(reference));
    // Nothing was paid by booking.
    expect(api.paymentPosts).toHaveLength(0);
  });

  it('the review shows the booking, the server’s amount and the demo disclosure, and no card form', async () => {
    const { booking } = setup();
    renderRoute(payPath(booking.reference));
    await payButton();
    const main = screen.getByRole('main');
    expect(main).toHaveTextContent(booking.reference);
    expect(main).toHaveTextContent('Casa Lagoa (demo)');
    expect(screen.getByRole('complementary', { name: 'Amount and payment' })).toHaveTextContent(
      '₹23,400',
    );
    expect(screen.getByText('This is a demo payment')).toBeInTheDocument();
    expect(main).toHaveTextContent(/no real money is charged/i);
    expect(main).toHaveTextContent('Simulated');
    // No payment-detail fields of any kind.
    expect(within(main).queryByRole('textbox')).toBeNull();
    expect(main.querySelector('input[autocomplete^="cc-"]')).toBeNull();
    expect(main.textContent).not.toMatch(/card number|cvv|expiry/i);
    // Demo outcomes, only because the server offers them.
    const outcomes = screen.getByRole('group', { name: /demo outcome/i });
    expect(within(outcomes).getAllByRole('radio')).toHaveLength(4);
    expect(within(outcomes).getByRole('radio', { name: 'Approve' })).toBeChecked();
  });

  it('pays once however often it is clicked, then shows the server’s result', async () => {
    const { api, booking } = setup();
    const { router } = renderRoute(payPath(booking.reference));
    const button = await payButton();
    const release = api.holdNext();
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    const posts = () => api.requests.filter((r) => /^POST \/bookings\/.+\/payments$/.test(r));
    expect(posts()).toHaveLength(1);
    release();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Demo payment successful' }),
    ).toBeInTheDocument();
    expect(api.paymentPosts).toHaveLength(1);
    expect(api.paymentPosts[0]!.body).toEqual({
      amount: { amountMinor: '2340000', currency: 'INR' },
      demoScenario: 'succeed',
    });
    expect(api.paymentPosts[0]!.key).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    const [payment] = [...api.payments.values()];
    expect(router.state.location.pathname).toBe(paymentPath(booking.reference, payment!.id));
    expect(screen.getByText(DEMO_PAYMENT_NOTICE)).toBeInTheDocument();
    expect(paymentStatusRegion()).toHaveTextContent('Payment status: Demo payment succeeded.');

    fireEvent.click(screen.getByRole('link', { name: 'View confirmation' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your demo booking is saved' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveTextContent(/paid with a demo payment: no real money/i);
    expect(screen.getByText('Demo confirmed')).toBeInTheDocument();
  });

  it('a declined demo payment says so and offers another attempt', async () => {
    const { api, booking } = setup();
    renderRoute(payPath(booking.reference));
    await payButton();
    fireEvent.click(screen.getByRole('radio', { name: 'Decline' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pay ₹23,400 (demo)' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Demo payment declined' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/declined \(simulated\)/)).toBeInTheDocument();
    expect(screen.queryByText(DEMO_PAYMENT_NOTICE)).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'Try again' }));
    await payButton();
    expect(api.store[0]!.payment).toMatchObject({ canPay: true, state: 'unpaid' });
  });

  it('follows a pending payment until it settles, announcing the change', async () => {
    const { api, booking } = setup();
    renderRoute(payPath(booking.reference));
    await payButton();
    fireEvent.click(screen.getByRole('radio', { name: 'Pending, then approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pay ₹23,400 (demo)' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Processing your demo payment' }),
    ).toBeInTheDocument();
    expect(paymentStatusRegion()).toHaveTextContent('Payment status: Processing (demo).');
    expect(screen.queryByText(DEMO_PAYMENT_NOTICE)).toBeNull();
    const [payment] = [...api.payments.values()];
    api.settle(payment!.id, 'succeeded');
    expect(
      await screen.findByRole(
        'heading',
        { level: 1, name: 'Demo payment successful' },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(paymentStatusRegion()).toHaveTextContent('Demo payment succeeded');
  });

  it('cancels a pending payment; it is shown as cancelled, never refunded', async () => {
    const { api, booking } = setup();
    renderRoute(payPath(booking.reference));
    await payButton();
    fireEvent.click(screen.getByRole('radio', { name: 'Pending, then approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pay ₹23,400 (demo)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel payment' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Payment cancelled' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('main').textContent).not.toMatch(/refunded/i);
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute(
      'href',
      payPath(booking.reference),
    );
    expect([...api.payments.values()][0]!.status).toBe('cancelled');
    // Back to the review (not to the cancelled payment a cached booking still named).
    fireEvent.click(screen.getByRole('link', { name: 'Try again' }));
    expect(await payButton()).toBeEnabled();
  });

  it('when the status can’t be read, says so and checks again on request', async () => {
    const { api, booking } = setup();
    renderRoute(payPath(booking.reference));
    await payButton();
    fireEvent.click(screen.getByRole('radio', { name: 'Pending, then approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pay ₹23,400 (demo)' }));
    await screen.findByRole('heading', { level: 1, name: 'Processing your demo payment' });
    // The next three status checks fail (the first try and two retries).
    for (let i = 0; i < 3; i += 1) api.failNext(503, 'SERVICE_UNAVAILABLE', 'Down.');
    const [payment] = [...api.payments.values()];
    api.settle(payment!.id, 'failed');
    expect(
      await screen.findByText("We couldn't check this payment", {}, { timeout: 12_000 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/checking again is safe/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Demo payment declined' }),
    ).toBeInTheDocument();
  });

  it('a stale amount is refused by the server and explained', async () => {
    const { api, booking } = setup();
    renderRoute(payPath(booking.reference));
    await payButton();
    api.failNext(409, 'PAYMENT_AMOUNT_MISMATCH', 'The amount doesn’t match this booking.');
    fireEvent.click(screen.getByRole('button', { name: 'Pay ₹23,400 (demo)' }));
    expect(await screen.findByText('The amount doesn’t match')).toBeInTheDocument();
    expect(api.payments.size).toBe(0);
  });

  it('bookings that can’t be paid say why, and the pay page never offers a payment', async () => {
    const expired = demoBooking(hotel, {
      status: 'expired',
      payment: { ...unpaidDemo(hotel), state: 'closed', canPay: false, demoScenarios: null },
    });
    installFakeBookingApi({ results: [hotel], bookings: [expired], payments: 'demo' });
    renderRoute(payPath(expired.reference));
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'This booking expired before it was paid',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pay/i })).toBeNull();
  });

  it('an unknown payment is “not found”', async () => {
    const { booking } = setup();
    const { unmount } = renderRoute(
      paymentPath(booking.reference, '01890000-0000-7000-9000-000000009999'),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: "We couldn't find that payment" }),
    ).toBeInTheDocument();
    unmount();
    renderRoute(paymentPath(booking.reference, 'not-an-id'));
    expect(
      await screen.findByRole('heading', { level: 1, name: "We couldn't find that payment" }),
    ).toBeInTheDocument();
  });

  it('the booking page shows what is due and the payment attempts', async () => {
    const { booking } = setup();
    const { unmount } = renderRoute(tripPath(booking.reference));
    const panel = await screen.findByRole('region', { name: 'Payment' });
    expect(panel).toHaveTextContent(/waiting for a demo payment/i);
    expect(within(panel).getByRole('link', { name: 'Pay ₹23,400 (demo)' })).toHaveAttribute(
      'href',
      payPath(booking.reference),
    );
    expect(screen.getByText('Awaiting demo payment')).toBeInTheDocument();
    unmount();

    renderRoute(payPath(booking.reference));
    fireEvent.click(await payButton());
    await screen.findByRole('heading', { level: 1, name: 'Demo payment successful' });
    fireEvent.click(screen.getByRole('link', { name: 'View booking' }));
    await screen.findByRole('heading', { level: 1, name: 'Casa Lagoa (demo)' });
    const after = await screen.findByRole('region', { name: 'Payment' });
    expect(after).toHaveTextContent(/paid with a demo payment/i);
    const attempts = await within(after).findByRole('list', { name: 'Payment attempts' });
    expect(attempts).toHaveTextContent('Attempt 1');
    expect(attempts).toHaveTextContent('Demo payment succeeded');
  });
});
