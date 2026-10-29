import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_BOOKING_NOTICE, type SearchResult, type Traveller } from '@wayora/contracts';
import { bookPath } from '../src/features/bookings/paths';
import { offerPath } from '../src/features/offers/paths';
import { demoBooking, installFakeBookingApi } from './fake-booking-api';
import { renderRoute } from './render';
import { DATE, cab, flight, hotel, metro, supplierFlight } from './search-fixtures';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const SEARCH = `location=city%3Agoa&checkIn=${DATE}`;

function setup(results: SearchResult[], options: { travellers?: Traveller[] } = {}) {
  const api = installFakeBookingApi({ results, ...options });
  const checkout = (result: SearchResult) =>
    bookPath(result.serviceType, result.id, api.response.searchId, SEARCH);
  return { api, checkout };
}

const SAVED: Traveller = {
  id: '01890000-0000-7000-8000-000000000900',
  firstName: 'Meera',
  lastName: 'Iyer',
  dateOfBirth: null,
  nationality: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
};

const stepHeading = (name: string | RegExp) => screen.findByRole('heading', { level: 2, name });

async function fillHotelGuest(first = 'Asha', last = 'Rao') {
  await stepHeading('Who is travelling?');
  fireEvent.change(screen.getByRole('textbox', { name: /first name/i }), {
    target: { value: first },
  });
  fireEvent.change(screen.getByRole('textbox', { name: /last name/i }), {
    target: { value: last },
  });
}

async function toReview() {
  fireEvent.click(screen.getByRole('button', { name: 'Continue to review' }));
  await stepHeading('Review and confirm');
}

function acceptAndConfirm() {
  fireEvent.click(screen.getByRole('checkbox', { name: 'I understand this is a demo booking' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm demo booking' }));
}

// Whole journeys through the real route table: slower than unit tests in jsdom.
const JOURNEY = { timeout: 20_000 };

describe('booking a demo offer', JOURNEY, () => {
  it('goes from the offer page through the steps to a saved booking and My trips', async () => {
    const { api } = setup([hotel]);
    const { router } = renderRoute(offerPath('hotels', hotel.id, api.response.searchId, SEARCH));

    const price = await screen.findByRole('complementary', { name: 'Price' });
    fireEvent.click(within(price).getByRole('link', { name: 'Book this demo offer' }));

    // Step 1: the offer, with the demo notice and the server's price.
    await stepHeading('Check the offer');
    expect(router.state.location.pathname).toBe(`/book/hotels/${encodeURIComponent(hotel.id)}`);
    const steps = screen.getByRole('navigation', { name: 'Booking steps' });
    expect(within(steps).getAllByRole('listitem')[0]).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText(DEMO_BOOKING_NOTICE)).toBeInTheDocument();
    const summary = screen.getByRole('complementary', { name: 'Booking summary' });
    expect(summary).toHaveTextContent('₹23,400');
    expect(summary).toHaveTextContent('Not itemised');
    // Opening the checkout books nothing.
    expect(api.posts).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Continue to traveller details' }));
    await fillHotelGuest();
    expect(screen.getByText(/one lead guest checks in for all 2 guests/i)).toBeInTheDocument();
    await toReview();
    expect(router.state.location.search).toContain('step=review');
    // Personal details are never put in the URL.
    expect(router.state.location.search).not.toMatch(/Asha|Rao/);

    const confirm = screen.getByRole('button', { name: 'Confirm demo booking' });
    expect(confirm).toBeDisabled();
    expect(screen.getByRole('main')).toHaveTextContent('Asha Rao');
    expect(summary).toHaveTextContent('₹23,400');
    acceptAndConfirm();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your demo booking is saved' }),
    ).toBeInTheDocument();
    const [booking] = api.store;
    expect(router.state.location.pathname).toBe(`/trips/${booking!.reference}/confirmation`);
    expect(screen.getByText(booking!.reference)).toBeInTheDocument();
    expect(screen.getByText(/not a supplier, airline or hotel reference/i)).toBeInTheDocument();
    expect(screen.getByText('Demo confirmed')).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveTextContent('₹23,400');
    expect(screen.getByRole('main').textContent).not.toMatch(/PNR|e-ticket|download ticket/i);

    // The request: ids, names and the price the visitor saw (only checked by the server).
    expect(api.posts).toHaveLength(1);
    const [post] = api.posts;
    expect(post!.key).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(post!.body).toEqual({
      serviceType: 'hotels',
      searchId: api.response.searchId,
      offerId: hotel.id,
      travellers: [{ firstName: 'Asha', lastName: 'Rao' }],
      acceptedPrice: hotel.price,
      acceptDemoTerms: true,
    });
    expect(JSON.stringify(post!.body)).not.toMatch(/userId|total"?:\s*\d/);

    fireEvent.click(screen.getByRole('link', { name: 'Go to My trips' }));
    const list = await screen.findByRole('list', { name: 'Upcoming trips' });
    expect(within(list).getByRole('link')).toHaveTextContent('Casa Lagoa (demo)');
    expect(within(list).getByRole('link')).toHaveTextContent(booking!.reference);
  });

  it('validates details, keeps them when going back, and guards the review step', async () => {
    const { checkout } = setup([hotel]);
    const { router } = renderRoute(`${checkout(hotel)}&step=review`);
    // Review without details falls back to the details step.
    await stepHeading('Who is travelling?');
    expect(router.state.location.search).toContain('step=details');

    fireEvent.click(screen.getByRole('button', { name: 'Continue to review' }));
    const first = screen.getByRole('textbox', { name: /first name/i });
    await waitFor(() => expect(first).toHaveAccessibleDescription(/./));
    expect(first).toHaveAttribute('aria-invalid', 'true');

    await fillHotelGuest('Asha', 'Rao');
    await toReview();
    fireEvent.click(screen.getByRole('button', { name: 'Back to details' }));
    await stepHeading('Who is travelling?');
    expect(screen.getByRole('textbox', { name: /first name/i })).toHaveValue('Asha');
    expect(screen.getByRole('textbox', { name: /last name/i })).toHaveValue('Rao');

    // Browser back and forward move between steps without losing anything.
    fireEvent.click(screen.getByRole('button', { name: /back to the offer/i }));
    await stepHeading('Check the offer');
    await act(() => router.navigate(-1));
    await stepHeading('Who is travelling?');
    expect(screen.getByRole('textbox', { name: /first name/i })).toHaveValue('Asha');
  });

  it('fills names from a saved traveller', async () => {
    const { checkout } = setup([hotel], { travellers: [SAVED] });
    renderRoute(`${checkout(hotel)}&step=details`);
    await stepHeading('Who is travelling?');
    const picker = await screen.findByRole('combobox', { name: /fill from a saved traveller/i });
    fireEvent.change(picker, { target: { value: SAVED.id } });
    expect(screen.getByRole('textbox', { name: /first name/i })).toHaveValue('Meera');
    expect(screen.getByRole('textbox', { name: /last name/i })).toHaveValue('Iyer');
  });

  it('asks for every flight passenger by type', async () => {
    const offer = {
      ...flight('CDA 101', 370, 5420),
      passengers: { adults: 2, children: 1, infants: 0 },
    };
    const { checkout } = setup([offer]);
    renderRoute(`${checkout(offer)}&step=details`);
    await stepHeading('Who is travelling?');
    expect(screen.getAllByRole('textbox', { name: /first name/i })).toHaveLength(3);
    expect(screen.getByRole('group', { name: 'Adult 1' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Adult 2' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Child' })).toBeInTheDocument();
  });

  it('needs a mobile number for cabs', async () => {
    const { api, checkout } = setup([cab]);
    renderRoute(`${checkout(cab)}&step=details`);
    await stepHeading('Who is travelling?');
    fireEvent.change(screen.getByRole('textbox', { name: /first name/i }), {
      target: { value: 'Ravi' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /last name/i }), {
      target: { value: 'Kumar' },
    });
    const phone = screen.getByRole('textbox', { name: /mobile number/i });
    fireEvent.change(phone, { target: { value: '98765' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue to review' }));
    await waitFor(() => expect(phone).toHaveAttribute('aria-invalid', 'true'));
    fireEvent.change(phone, { target: { value: '+919876543210' } });
    await toReview();
    // A range is an estimate, not a total.
    expect(screen.getByRole('complementary', { name: 'Booking summary' })).toHaveTextContent(
      /estimated fare/i,
    );
    acceptAndConfirm();
    await screen.findByRole('heading', { level: 1, name: 'Your demo booking is saved' });
    expect(api.posts[0]!.body).toMatchObject({ contactPhone: '+919876543210' });
  });

  it('needs no names for metro', async () => {
    const { api, checkout } = setup([metro]);
    renderRoute(`${checkout(metro)}&step=details`);
    await stepHeading('No traveller details needed');
    expect(screen.queryByRole('textbox')).toBeNull();
    await toReview();
    acceptAndConfirm();
    await screen.findByRole('heading', { level: 1, name: 'Your demo booking is saved' });
    expect(api.posts[0]!.body).toMatchObject({ serviceType: 'metro', travellers: [] });
  });

  it('sends one booking request however often Confirm is pressed', async () => {
    const { api, checkout } = setup([hotel]);
    renderRoute(`${checkout(hotel)}&step=details`);
    await fillHotelGuest();
    await toReview();
    const release = api.holdNext();
    acceptAndConfirm();
    // More clicks and an Enter-key submit in the same tick, before any re-render.
    const confirm = screen.getByRole('button', { name: /confirm demo booking/i });
    fireEvent.click(confirm);
    fireEvent.submit(confirm.closest('form')!);
    await waitFor(() => expect(confirm).toBeDisabled());
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(confirm);
    expect(api.posts).toHaveLength(1);
    release();
    await screen.findByRole('heading', { level: 1, name: 'Your demo booking is saved' });
    expect(api.posts).toHaveLength(1);
    expect(api.store).toHaveLength(1);
  });

  it('retries a failed attempt with the same idempotency key, so it books once', async () => {
    const { api, checkout } = setup([hotel]);
    renderRoute(`${checkout(hotel)}&step=details`);
    await fillHotelGuest();
    await toReview();
    api.failNext(500, 'INTERNAL_ERROR');
    acceptAndConfirm();
    expect(
      await screen.findByText("We couldn't confirm whether your booking was saved"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm demo booking' }));
    await screen.findByRole('heading', { level: 1, name: 'Your demo booking is saved' });
    // The failed request and the retry carry the same key and body.
    expect(api.posts).toHaveLength(2);
    expect(api.posts[1]!.key).toBe(api.posts[0]!.key);
    expect(api.posts[1]!.body).toEqual(api.posts[0]!.body);
    expect(api.store).toHaveLength(1);
  });

  it('asks again, with the same key, while an earlier request is still being saved', async () => {
    const { api, checkout } = setup([hotel]);
    renderRoute(`${checkout(hotel)}&step=details`);
    await fillHotelGuest();
    await toReview();
    api.failNext(409, 'IDEMPOTENCY_IN_PROGRESS', 'This booking is already being created.');
    acceptAndConfirm();
    expect(await screen.findByText('Still saving your booking…')).toBeInTheDocument();
    await screen.findByRole(
      'heading',
      { level: 1, name: 'Your demo booking is saved' },
      { timeout: 5000 },
    );
    expect(api.posts).toHaveLength(2);
    expect(api.posts[1]!.key).toBe(api.posts[0]!.key);
    expect(api.store).toHaveLength(1);
  });

  it('shows the server’s field errors on the details step', async () => {
    const { api, checkout } = setup([hotel]);
    const { router } = renderRoute(`${checkout(hotel)}&step=details`);
    await fillHotelGuest();
    await toReview();
    api.failNext(400, 'VALIDATION_FAILED', 'Check the highlighted fields.', [
      {
        path: 'body.travellers.0.lastName',
        message: 'Use letters for the last name.',
        code: 'custom',
      },
    ]);
    acceptAndConfirm();
    await stepHeading('Who is travelling?');
    expect(router.state.location.search).toContain('step=details');
    expect(screen.getByRole('textbox', { name: /last name/i })).toHaveAccessibleDescription(
      /use letters for the last name/i,
    );
    expect(api.store).toHaveLength(0);
  });

  it('stops when the server says the price changed, and asks to confirm again', async () => {
    const { api, checkout } = setup([hotel]);
    renderRoute(`${checkout(hotel)}&step=details`);
    await fillHotelGuest();
    await toReview();
    api.failNext(409, 'PRICE_CHANGED', 'The price has changed.');
    acceptAndConfirm();
    expect(await screen.findByText('The price has changed')).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: 'I understand this is a demo booking' }),
    ).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Confirm demo booking' })).toBeDisabled();
    expect(api.store).toHaveLength(0);
  });

  it('says so when the search has expired', async () => {
    const { checkout } = setup([hotel]);
    const url = checkout(hotel).replace(/sid=[^&]+/, 'sid=01890000-0000-7000-8000-00000000dead');
    renderRoute(url);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This offer can no longer be booked' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Search again' })).toBeInTheDocument();
  });

  it('sends signed-out visitors to sign in first, keeping the checkout to return to', async () => {
    const api = installFakeBookingApi({ results: [hotel], signedIn: false });
    const { router } = renderRoute(bookPath('hotels', hotel.id, api.response.searchId, SEARCH));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toContain(encodeURIComponent('/book/hotels/'));
    expect(api.posts).toHaveLength(0);
  });
});

describe('My trips', JOURNEY, () => {
  it('shows an empty state with a way to start', async () => {
    installFakeBookingApi({ results: [] });
    renderRoute('/trips');
    expect(await screen.findByText('No upcoming trips')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Search travel' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /upcoming/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows an error with a retry', async () => {
    const api = installFakeBookingApi({ results: [] });
    api.failNext(503, 'SERVICE_UNAVAILABLE');
    renderRoute('/trips');
    expect(await screen.findByText("We couldn't load your trips")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No upcoming trips')).toBeInTheDocument();
  });

  it('pages through trips and switches tabs with counts', async () => {
    const bookings = Array.from({ length: 12 }, () => demoBooking(hotel));
    bookings.push(demoBooking(hotel, { status: 'cancelled' }));
    installFakeBookingApi({ results: [], bookings });
    const { router } = renderRoute('/trips');
    const list = await screen.findByRole('list', { name: 'Upcoming trips' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByRole('tab', { name: /upcoming/i })).toHaveTextContent('12');
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(router.state.location.search).toBe('?page=2'));
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Upcoming trips' })).getAllByRole('listitem'),
      ).toHaveLength(2),
    );

    fireEvent.mouseDown(screen.getByRole('tab', { name: /cancelled/i }));
    fireEvent.click(screen.getByRole('tab', { name: /cancelled/i }));
    const cancelled = await screen.findByRole('list', { name: 'Cancelled trips' });
    expect(within(cancelled).getAllByRole('listitem')).toHaveLength(1);
    expect(router.state.location.search).toBe('?view=cancelled');
  });

  it('cancels a booking after confirming, and keeps it as cancelled', async () => {
    const booking = demoBooking(hotel, {
      travellers: [{ firstName: 'Asha', lastName: 'Rao' }],
    });
    const api = installFakeBookingApi({ results: [], bookings: [booking] });
    renderRoute(`/trips/${booking.reference}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Casa Lagoa (demo)' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveTextContent('Asha Rao');
    expect(screen.getByRole('main')).toHaveTextContent('Demo confirmed');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel demo booking' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this demo booking?' });
    expect(dialog).toHaveTextContent(/nothing is refunded because nothing was paid/i);
    // Keeping it changes nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep booking' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.requests.filter((r) => r.endsWith('/cancel'))).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel demo booking' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel booking' }),
    );
    expect(await screen.findByText('Booking cancelled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel demo booking' })).toBeNull();
    expect(screen.getByText(/this booking is cancelled/i)).toBeInTheDocument();
    expect(api.requests.filter((r) => r.endsWith('/cancel'))).toHaveLength(1);
    expect(api.store[0]!.status).toBe('cancelled');
  });

  it('shows a not-found page for an unknown or malformed reference', async () => {
    installFakeBookingApi({ results: [] });
    const { unmount } = renderRoute('/trips/WYD-2222-2222');
    expect(
      await screen.findByRole('heading', { level: 1, name: "We couldn't find that booking" }),
    ).toBeInTheDocument();
    unmount();
    renderRoute('/trips/not-a-reference');
    expect(
      await screen.findByRole('heading', { level: 1, name: "We couldn't find that booking" }),
    ).toBeInTheDocument();
  });

  it('is linked from the account menu', async () => {
    installFakeBookingApi({ results: [] });
    renderRoute('/profile');
    const nav = await screen.findByRole('navigation', { name: /account/i });
    expect(within(nav).getByRole('link', { name: /my trips/i })).toHaveAttribute('href', '/trips');
  });
});

describe('supplier offers (Phase 22)', JOURNEY, () => {
  it('checkout refuses a supplier offer before asking for any details', async () => {
    const result = supplierFlight(4520);
    const { checkout } = setup([result]);
    renderRoute(checkout(result));
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'This supplier offer can’t be booked on Wayora yet',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /confirm/i })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to the offer' })).toBeInTheDocument();
  });
});
