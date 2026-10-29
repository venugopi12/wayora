import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_BOOKING_NOTICE, SUPPLIER_BOOKING_NOTICE } from '@wayora/contracts';
import { tripPath } from '../src/features/bookings/paths';
import { offerPath } from '../src/features/offers/paths';
import { installFakeAdminApi } from './fake-admin-api';
import { demoBooking, installFakeBookingApi, supplierBooking } from './fake-booking-api';
import { renderRoute } from './render';
import { hotel, supplierFlight } from './search-fixtures';

/*
 * Supplier bookings in the web app (Phase 23, docs/bookings.md#web): the
 * request flow, the separate statuses, honest pending and failure states,
 * cancellation through the supplier, and the staff view. The supplier is the
 * TEST-ONLY fixture supplier; no real supplier is integrated.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const JOURNEY = { timeout: 20_000 };
const SEARCH = 'from=airport%3ABLR&to=airport%3ADEL';
const stepHeading = (name: string | RegExp) => screen.findByRole('heading', { level: 2, name });
const statusPanel = () => screen.getByRole('region', { name: 'Booking status' });
const row = (label: string) => within(statusPanel()).getByText(label).nextElementSibling!;

async function requestBooking(outcome: 'confirmed' | 'unknown' | 'failed') {
  const offer = supplierFlight(4520);
  const api = installFakeBookingApi({ results: [offer], supplier: { bookable: true, outcome } });
  const view = renderRoute(offerPath('flights', offer.id, api.response.searchId, SEARCH));
  const price = await screen.findByRole('complementary', { name: 'Price' });
  expect(price).toHaveTextContent(SUPPLIER_BOOKING_NOTICE);
  expect(within(price).queryByRole('link', { name: /demo/i })).toBeNull();
  fireEvent.click(within(price).getByRole('link', { name: 'Request this booking' }));

  await stepHeading('Check the offer');
  expect(screen.getByText(SUPPLIER_BOOKING_NOTICE)).toBeInTheDocument();
  expect(screen.queryByText(DEMO_BOOKING_NOTICE)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Continue to traveller details' }));
  await stepHeading('Who is travelling?');
  expect(
    screen.getByText(/Names are sent to the supplier for this reservation only/),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: /first name/i }), {
    target: { value: 'Asha' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: /last name/i }), {
    target: { value: 'Rao' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue to review' }));
  await stepHeading('Review and confirm');
  expect(screen.getByRole('heading', { name: 'How this booking works' })).toBeInTheDocument();
  const send = screen.getByRole('button', { name: 'Send booking request' });
  expect(send).toBeDisabled();
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'I understand how this supplier booking works' }),
  );
  fireEvent.click(send);
  return { api, offer, ...view };
}

describe('requesting a supplier booking', JOURNEY, () => {
  it('confirmed only by the supplier: its reference, never a demo label; the request carries the supplier terms', async () => {
    const { api, offer } = await requestBooking('confirmed');
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Fixture Air (test supplier) confirmed your booking',
      }),
    ).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main).toHaveTextContent('Fixture Air (test supplier) reference FXR00001');
    expect(main).toHaveTextContent('Wayora took no payment');
    expect(main.textContent).not.toMatch(/demo/i);
    expect(api.posts).toHaveLength(1);
    expect(api.posts[0]!.body).toEqual({
      serviceType: 'flights',
      searchId: api.response.searchId,
      offerId: offer.id,
      travellers: [{ firstName: 'Asha', lastName: 'Rao' }],
      acceptedPrice: offer.price,
      acceptSupplierTerms: true,
    });
  });

  it('an unclear answer: sent, not confirmed, and no second request', async () => {
    const { api } = await requestBooking('unknown');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your booking request was sent' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Checking with the supplier')).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveTextContent('won’t send another request');
    expect(screen.getByText('Wayora’s own reference, not the supplier’s.')).toBeInTheDocument();
    expect(screen.queryByText(/FXR/)).toBeNull();
    expect(api.posts).toHaveLength(1);
  });

  it('a refusal: not booked, said plainly', async () => {
    await requestBooking('failed');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your booking wasn’t confirmed' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveTextContent('nothing is booked. Wayora took no payment');
  });

  it('a supplier offer the server can’t book offers no booking at all', async () => {
    const offer = supplierFlight(4520);
    const api = installFakeBookingApi({ results: [offer] });
    renderRoute(offerPath('flights', offer.id, api.response.searchId, SEARCH));
    const price = await screen.findByRole('complementary', { name: 'Price' });
    expect(within(price).queryByRole('link', { name: /book/i })).toBeNull();
    expect(price).toHaveTextContent('isn’t available yet');
  });
});

describe('a supplier booking’s page', JOURNEY, () => {
  it('shows each status separately: reservation, payment, tickets, cancellation, refund', async () => {
    const booking = supplierBooking(supplierFlight(4520), { state: 'confirmed' });
    installFakeBookingApi({ results: [], bookings: [booking] });
    renderRoute(tripPath(booking.reference));
    await screen.findByRole('heading', { level: 1, name: 'Bengaluru to Delhi' });
    expect(screen.getByText('Supplier booking')).toBeInTheDocument();
    expect(screen.queryByText('Demo booking')).toBeNull();
    expect(screen.getByText(/Wayora reference/)).toBeInTheDocument();
    expect(row('Supplier reservation')).toHaveTextContent('Confirmed by the supplier');
    expect(row('Supplier reservation')).toHaveTextContent('reference FXR00001');
    expect(row('Payment')).toHaveTextContent('Wayora takes no payment');
    expect(row('Tickets and vouchers')).toHaveTextContent('Ticket 098000010001 · Asha Rao');
    expect(row('Cancellation')).toHaveTextContent('it is cancelled only when');
    expect(row('Refund')).toHaveTextContent('follows its terms');
    expect(within(statusPanel()).queryByRole('button', { name: 'Check again' })).toBeNull();
  });

  it('while the outcome is unknown: says so, keeps checking, offers only a safe re-check', async () => {
    const booking = supplierBooking(supplierFlight(4520), {
      state: 'unknown',
      needsAttention: true,
    });
    const api = installFakeBookingApi({ results: [], bookings: [booking] });
    renderRoute(tripPath(booking.reference));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Not confirmed yet');
    expect(alert).toHaveTextContent('Our team is confirming it');
    expect(row('Supplier reservation')).toHaveTextContent('Checking with the supplier');
    expect(row('Tickets and vouchers')).toHaveTextContent('only after');
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
    const reads = () => api.requests.filter((r) => r === `GET /bookings/${booking.reference}`);
    const before = reads().length;
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(reads().length).toBe(before + 1));
    // Only reads: nothing was posted.
    expect(api.posts).toHaveLength(0);
  });

  it('a failed reservation is shown as not booked', async () => {
    const booking = supplierBooking(supplierFlight(4520), { state: 'failed' });
    installFakeBookingApi({ results: [], bookings: [booking] });
    renderRoute(tripPath(booking.reference));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Not booked');
    expect(screen.getAllByText('Not booked').length).toBeGreaterThan(0);
  });

  it('cancelling asks the supplier: cancelled, pending, or refused', async () => {
    for (const [cancel, expected] of [
      ['cancelled', 'Booking cancelled'],
      ['pending', 'Cancellation requested'],
      ['refused', 'refused to cancel this booking'],
    ] as const) {
      vi.unstubAllGlobals();
      document.body.innerHTML = '';
      const booking = supplierBooking(supplierFlight(4520), { state: 'confirmed' });
      installFakeBookingApi({ results: [], bookings: [booking], supplier: { cancel } });
      const { unmount } = renderRoute(tripPath(booking.reference));
      fireEvent.click(await screen.findByRole('button', { name: 'Request cancellation' }));
      const dialog = await screen.findByRole('dialog', { name: 'Ask the supplier to cancel?' });
      expect(dialog).toHaveTextContent('cancelled only when Fixture Air (test supplier) confirms');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Request cancellation' }));
      if (cancel === 'refused') {
        expect(await within(dialog).findByText(new RegExp(expected))).toBeInTheDocument();
      } else {
        expect((await screen.findAllByText(expected)).length).toBeGreaterThan(0);
        if (cancel === 'pending') {
          expect(row('Supplier reservation')).toHaveTextContent('Cancellation requested');
        }
      }
      unmount();
    }
  });

  it('a demo booking says plainly that no supplier, ticket or refund is involved', async () => {
    const booking = demoBooking(hotel);
    installFakeBookingApi({ results: [], bookings: [booking] });
    renderRoute(tripPath(booking.reference));
    await screen.findByRole('heading', { level: 1, name: 'Casa Lagoa (demo)' });
    expect(screen.getByText(DEMO_BOOKING_NOTICE)).toBeInTheDocument();
    expect(row('Supplier reservation')).toHaveTextContent(
      'Demo booking: no supplier reservation was made.',
    );
    expect(row('Tickets and vouchers')).toHaveTextContent('no ticket, voucher or PNR exists');
    expect(row('Refund')).toHaveTextContent('nothing to refund');
  });
});

describe('staff view of supplier reservations', JOURNEY, () => {
  it('admins find reservations needing attention and record an outcome; nothing is sent to the supplier', async () => {
    const api = installFakeAdminApi({ withSupplierBooking: true });
    renderRoute('/admin/bookings?attention=true');
    const table = await screen.findByRole('region', { name: 'Bookings table' });
    const line = within(table).getByRole('link', { name: 'WY-DDDD-DDDD' }).closest('tr')!;
    expect(line).toHaveTextContent('Checking with the supplier');
    expect(line).toHaveTextContent('Needs attention');
    expect(within(table).getAllByRole('row')).toHaveLength(2); // header + the one needing attention

    fireEvent.click(within(table).getByRole('link', { name: 'WY-DDDD-DDDD' }));
    const panel = await screen.findByRole('region', { name: 'Supplier reservation' });
    expect(panel).toHaveTextContent('Automatic recovery stopped');
    expect(panel).toHaveTextContent('req-reserve-1');
    expect(panel).toHaveTextContent('Timeout');
    // No lookup at this supplier: no re-check offered.
    expect(within(panel).queryByRole('button', { name: 'Check with the supplier now' })).toBeNull();

    const form = within(panel).getByRole('form', { name: 'Record the outcome' });
    fireEvent.change(within(form).getByRole('combobox'), { target: { value: 'confirmed' } });
    fireEvent.change(within(form).getByRole('textbox', { name: /Supplier reference/ }), {
      target: { value: 'FXR00001' },
    });
    const record = within(form).getByRole('button', { name: 'Record outcome' });
    expect(record).toBeDisabled(); // a reason is required
    fireEvent.change(within(form).getByRole('textbox', { name: /How you confirmed it/ }), {
      target: { value: 'Confirmed by phone with the supplier desk.' },
    });
    fireEvent.click(record);
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Supplier reservation' })).toHaveTextContent(
        'Confirmed by the supplier',
      ),
    );
    expect(api.resolutions).toEqual([
      {
        outcome: 'confirmed',
        supplierReference: 'FXR00001',
        reason: 'Confirmed by phone with the supplier desk.',
      },
    ]);
    expect(screen.queryByRole('form', { name: 'Record the outcome' })).toBeNull();
  });

  it('support staff see the reservation but no actions', async () => {
    installFakeAdminApi({ role: 'support', withSupplierBooking: true });
    renderRoute('/admin/bookings/WY-DDDD-DDDD');
    const panel = await screen.findByRole('region', { name: 'Supplier reservation' });
    expect(panel).toHaveTextContent('Checking with the supplier');
    expect(within(panel).queryByRole('form')).toBeNull();
    expect(within(panel).queryByRole('button')).toBeNull();
  });
});
