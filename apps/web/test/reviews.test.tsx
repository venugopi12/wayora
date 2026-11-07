import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BookingReviewState } from '@wayora/contracts';
import { installFakeAccountApi } from './fake-account-api';
import { installFakeAdminApi } from './fake-admin-api';
import { demoBooking, installFakeBookingApi } from './fake-booking-api';
import {
  REVIEW_ID,
  installFakeAdminReviewsApi,
  installFakeReviewsApi,
  ownReview,
  publicReview,
} from './fake-reviews-api';
import { renderRoute } from './render';
import { hotel } from './search-fixtures';

/*
 * Reviews in the web app (Phase 28): public reviews with their summary,
 * writing (stars, validation, preview, what is sent), editing, your
 * reviews, the booking panel, and moderation for staff. Rules and
 * aggregates are the server's (tested in apps/api).
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const JOURNEY = { timeout: 20_000 };

const eligible = (over: Partial<BookingReviewState> = {}): BookingReviewState => ({
  bookingReference: 'WYD-7KQ2-M9XD',
  subject: { type: 'hotel', key: 'demo-hotels:goa-casa-lagoa' },
  subjectName: 'Casa Lagoa (demo), Goa',
  state: 'eligible',
  reason: null,
  eligibleFrom: null,
  verification: 'demo_booking',
  reviewId: null,
  ...over,
});

describe('public reviews', JOURNEY, () => {
  it('shows a destination’s summary, labels, distribution, sorting, filtering and paging', async () => {
    installFakeAccountApi();
    const reviews = installFakeReviewsApi({
      published: {
        goa: Array.from({ length: 12 }, (_, i) =>
          publicReview(i, { rating: [5, 4, 2][i % 3]!, title: `Visit ${i}` }),
        ),
      },
    });
    renderRoute('/discover/goa');
    const section = await screen.findByRole('region', { name: 'Traveller feedback on Goa' });
    expect(section).toHaveTextContent('marked “Not verified”');
    // 12 reviews: 4 × 5, 4 × 4, 4 × 2 → 3.7 out of 5, from the server's summary.
    expect(await within(section).findByText(/Rated 3\.7 out of 5/)).toBeInTheDocument();
    expect(within(section).getByLabelText('Rating distribution')).toHaveTextContent('5 stars4');
    const list = within(section).getByRole('list', { name: /page 1/ });
    expect(within(list).getAllByRole('article')).toHaveLength(10);
    expect(within(list).getAllByText('Not verified').length).toBe(10);
    expect(
      within(section).getAllByRole('img', { name: '5 out of 5 stars' }).length,
    ).toBeGreaterThan(0);

    fireEvent.change(within(section).getByRole('combobox', { name: 'Sort by' }), {
      target: { value: 'lowest' },
    });
    await waitFor(() => expect(reviews.reads.some((r) => r.includes('sort=lowest'))).toBe(true));
    fireEvent.change(within(section).getByRole('combobox', { name: 'Show' }), {
      target: { value: '5' },
    });
    await waitFor(() => expect(reviews.reads.some((r) => r.includes('rating=5'))).toBe(true));
    expect(await within(section).findByRole('list', { name: /page 1/ })).toBeInTheDocument();
    await waitFor(() => expect(within(section).getAllByRole('article')).toHaveLength(4));

    fireEvent.change(within(section).getByRole('combobox', { name: 'Show' }), {
      target: { value: '' },
    });
    fireEvent.click(await within(section).findByRole('button', { name: 'Next' }));
    await waitFor(() => expect(reviews.reads.some((r) => r.includes('page=2'))).toBe(true));
    // Signed out: no voting or reporting, a sign-in prompt instead.
    expect(within(section).queryByRole('button', { name: 'Helpful' })).toBeNull();
    expect(within(section).getByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(
      within(section).getByRole('link', { name: 'Sign in to share feedback' }),
    ).toBeInTheDocument();
  });

  it('shows the count but no average below three reviews, and an honest empty state', async () => {
    installFakeAccountApi();
    installFakeReviewsApi({
      published: { jaipur: [publicReview(1, { rating: 5 }), publicReview(2, { rating: 1 })] },
    });
    renderRoute('/discover/jaipur');
    const section = await screen.findByRole('region', { name: 'Traveller feedback on Jaipur' });
    expect(
      await within(section).findByText('2 published reviews. An average appears from 3.'),
    ).toBeInTheDocument();
    expect(within(section).queryByText(/Rated .* out of 5/)).toBeNull();

    vi.unstubAllGlobals();
    installFakeAccountApi();
    installFakeReviewsApi();
    renderRoute('/discover/kerala');
    const empty = await screen.findByRole('region', { name: 'Traveller feedback on Kerala' });
    expect(await within(empty).findByText('No reviews yet')).toBeInTheDocument();
  });

  it('signed-in readers mark reviews helpful and report them; never their own', async () => {
    installFakeAccountApi({ signedIn: true });
    const reviews = installFakeReviewsApi({
      published: {
        goa: [
          publicReview(1, { viewer: { own: false, votedHelpful: false, reported: false } }),
          publicReview(2, {
            title: 'Mine',
            viewer: { own: true, votedHelpful: false, reported: false },
          }),
        ],
      },
    });
    renderRoute('/discover/goa');
    const section = await screen.findByRole('region', { name: 'Traveller feedback on Goa' });
    const [other, mine] = await within(section).findAllByRole('article');
    expect(within(mine!).getByText('Your review')).toBeInTheDocument();
    expect(within(mine!).queryByRole('button', { name: 'Helpful' })).toBeNull();

    const helpful = within(other!).getByRole('button', { name: 'Helpful' });
    expect(helpful).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(helpful);
    await waitFor(() => expect(helpful).toHaveAttribute('aria-pressed', 'true'));
    expect(reviews.writes[0]).toMatchObject({
      method: 'PUT',
      path: `/reviews/${publicReview(1).id}/helpful`,
      body: {},
    });

    fireEvent.click(within(other!).getByRole('button', { name: 'Report' }));
    const dialog = await screen.findByRole('dialog', { name: 'Report this review' });
    const send = within(dialog).getByRole('button', { name: 'Send report' });
    expect(send).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Reason' }), {
      target: { value: 'other' },
    });
    expect(send).toBeDisabled(); // "Something else" needs details
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Details/ }), {
      target: { value: 'It advertises another hotel.' },
    });
    fireEvent.click(send);
    expect(await within(other!).findByText(/Reported\. Thanks/)).toBeInTheDocument();
    expect(reviews.writes.at(-1)).toMatchObject({
      method: 'POST',
      body: { reason: 'other', details: 'It advertises another hotel.' },
    });
  });
});

describe('writing and editing', JOURNEY, () => {
  it('needs a rating and enough text, previews it, and sends only what the customer wrote', async () => {
    installFakeAccountApi({ signedIn: true });
    const reviews = installFakeReviewsApi({ bookingStates: [eligible()] });
    renderRoute('/reviews/write?booking=WYD-7KQ2-M9XD');
    const panel = await screen.findByRole('region', { name: 'Casa Lagoa (demo), Goa' });
    expect(panel).toHaveTextContent('demo booking');

    fireEvent.click(within(panel).getByRole('button', { name: 'Send review' }));
    expect(
      await within(panel).findByText('Choose a rating from 1 to 5 stars.'),
    ).toBeInTheDocument();
    expect(within(panel).getByText('The title needs at least 4 characters.')).toBeInTheDocument();
    expect(
      within(panel).getByText('Your review needs at least 30 characters.'),
    ).toBeInTheDocument();
    expect(reviews.writes).toHaveLength(0);

    const overall = within(panel).getByRole('group', { name: /Overall rating/ });
    // No star is chosen until the customer chooses one.
    expect(
      within(overall)
        .getAllByRole('radio')
        .filter((r) => (r as HTMLInputElement).checked),
    ).toHaveLength(0);
    fireEvent.click(within(overall).getByRole('radio', { name: '2 stars: Poor' }));
    fireEvent.click(
      within(within(panel).getByRole('group', { name: 'Cleanliness' })).getByRole('radio', {
        name: /^4 stars/,
      }),
    );
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Noisy but clean' },
    });
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Your review' }), {
      target: { value: 'Rooms were spotless, but the bar next door played music until 2 am.' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Preview' }));
    const preview = within(panel).getByRole('region', { name: 'Preview' });
    expect(preview).toHaveTextContent('Noisy but clean');
    expect(preview).toHaveTextContent('Demo booking');
    expect(within(preview).getByRole('img', { name: '2 out of 5 stars' })).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: 'Send review' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your reviews' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Review sent')).toBeInTheDocument();
    expect(reviews.writes).toEqual([
      {
        method: 'POST',
        path: '/reviews',
        body: {
          kind: 'booking',
          bookingReference: 'WYD-7KQ2-M9XD',
          rating: 2,
          aspects: { cleanliness: 4 },
          title: 'Noisy but clean',
          body: 'Rooms were spotless, but the bar next door played music until 2 am.',
        },
      },
    ]);
  });

  it('shows the server’s reason when a booking can’t be reviewed yet, and links to an existing review', async () => {
    installFakeAccountApi({ signedIn: true });
    installFakeReviewsApi({
      bookingStates: [
        eligible({
          state: 'not_yet',
          reason: 'You can review your stay from the day after you check out.',
          eligibleFrom: '2026-12-02',
          verification: null,
        }),
        eligible({ bookingReference: 'WYD-AAAA-BBBB', state: 'reviewed', reviewId: REVIEW_ID }),
      ],
    });
    renderRoute('/reviews/write?booking=WYD-7KQ2-M9XD');
    expect(await screen.findByText('Not yet')).toBeInTheDocument();
    expect(screen.getByText(/the day after you check out\. From 2 Dec 2026/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send review' })).toBeNull();

    renderRoute('/reviews/write?booking=WYD-AAAA-BBBB');
    expect(await screen.findByRole('link', { name: 'Edit your review' })).toHaveAttribute(
      'href',
      `/reviews/${REVIEW_ID}/edit`,
    );
  });

  it('shows field errors from the server', async () => {
    installFakeAccountApi({ signedIn: true });
    installFakeReviewsApi();
    renderRoute('/reviews/write?destination=goa');
    const panel = await screen.findByRole('region', { name: 'Goa' });
    expect(panel).toHaveTextContent('“Not verified”');
    // Destinations take an overall rating only.
    expect(within(panel).queryByRole('group', { name: /Rate the details/ })).toBeNull();
    fireEvent.click(
      within(within(panel).getByRole('group', { name: /Overall rating/ })).getByRole('radio', {
        name: /^5 stars/,
      }),
    );
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Lovely' },
    });
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Your review' }), {
      target: { value: 'A long enough text, but the server says no to it.' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Send feedback' }));
    expect(await within(panel).findByText('Remove control characters.')).toBeInTheDocument();
  });

  it('lists your reviews with their status and note, and edits send the revision', async () => {
    installFakeAccountApi({ signedIn: true });
    const reviews = installFakeReviewsApi({
      mine: [
        ownReview({
          status: 'rejected',
          moderationNote: 'Mentions another guest by name',
          revision: 2,
        }),
        ownReview({
          id: '01890000-0000-7000-8000-00000000c002',
          status: 'removed',
          moderationNote: 'Contains a phone number',
          editableUntil: null,
          title: 'Removed one',
        }),
      ],
      bookingStates: [eligible({ bookingReference: 'WYD-CCCC-DDDD' })],
    });
    renderRoute('/reviews');
    const list = await screen.findByRole('list', { name: 'Your reviews' });
    const [rejected, removed] = within(list).getAllByRole('article');
    expect(rejected).toHaveTextContent('Not published');
    expect(rejected).toHaveTextContent('Mentions another guest by name');
    expect(removed).toHaveTextContent('Removed');
    expect(within(removed!).queryByRole('link', { name: 'Edit' })).toBeNull();
    const ready = screen.getByRole('region', { name: 'Ready to review' });
    expect(within(ready).getByRole('link', { name: 'Write a review' })).toHaveAttribute(
      'href',
      '/reviews/write?booking=WYD-CCCC-DDDD',
    );

    fireEvent.click(within(rejected!).getByRole('link', { name: 'Edit' }));
    const title = await screen.findByRole('textbox', { name: 'Title' });
    expect(title).toHaveValue('Review number 1');
    fireEvent.change(title, { target: { value: 'Fair, after a second look' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Changes sent')).toBeInTheDocument();
    expect(reviews.writes.at(-1)).toMatchObject({
      method: 'PATCH',
      path: `/reviews/${REVIEW_ID}`,
      body: { title: 'Fair, after a second look', revision: 2 },
    });
  });

  it('a hotel booking’s page offers a review once the stay is over', async () => {
    const booking = demoBooking(hotel, { status: 'confirmed' });
    installFakeBookingApi({ results: [hotel], bookings: [booking] });
    installFakeReviewsApi({ bookingStates: [eligible({ bookingReference: booking.reference })] });
    renderRoute(`/trips/${booking.reference}`);
    const panel = await screen.findByRole('region', { name: 'Your review' });
    expect(await within(panel).findByRole('link', { name: 'Write a review' })).toHaveAttribute(
      'href',
      `/reviews/write?booking=${booking.reference}`,
    );
    expect(panel).toHaveTextContent('labelled “Demo booking”');
  });
});

describe('moderation', JOURNEY, () => {
  it('support staff publish, reject or flag (with a reason), never remove', async () => {
    installFakeAdminApi({ role: 'support' });
    const api = installFakeAdminReviewsApi('support');
    renderRoute(`/admin/reviews/${REVIEW_ID}`);
    await screen.findByRole('heading', { level: 1, name: 'Noisy at night' });
    const decision = screen.getByRole('region', { name: 'Decision' });
    const actions = within(decision)
      .getAllByRole('radio')
      .map((r) => (r as HTMLInputElement).value);
    expect(actions).toEqual(['publish', 'reject', 'flag']);
    // Reports are shown without who sent them.
    const reports = screen.getByRole('region', { name: 'Reports' });
    expect(reports).toHaveTextContent('Not about this place');
    expect(reports).toHaveTextContent('Reporters are never shown');

    fireEvent.click(within(decision).getByRole('radio', { name: /Reject/ }));
    const submit = within(decision).getByRole('button', { name: 'Reject' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(decision).getByRole('textbox', { name: 'Reason' }), {
      target: { value: 'About a neighbouring bar' },
    });
    fireEvent.click(submit);
    expect(await screen.findByText(/Reject: done\. Status is now rejected/)).toBeInTheDocument();
    expect(api.writes).toEqual([
      {
        path: `/admin/reviews/${REVIEW_ID}/moderate`,
        body: { action: 'reject', reason: 'About a neighbouring bar', revision: 1 },
      },
    ]);
  });

  it('staff can’t act on their own review', async () => {
    installFakeAdminApi({ role: 'admin' });
    installFakeAdminReviewsApi('admin', {
      allowed: { actions: [], dismissReports: false, ownReview: true },
    });
    renderRoute(`/admin/reviews/${REVIEW_ID}`);
    expect(await screen.findByText(/This is your own review/)).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('the dashboard shows counts with their definitions, and the queue lists reviews', async () => {
    installFakeAdminApi({ role: 'support' });
    installFakeAdminReviewsApi('support');
    renderRoute('/admin/reviews');
    expect(
      await screen.findByText('Waiting for moderation', { selector: 'dt' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Published counts and ratings include only reviews the public can see/),
    ).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Moderation decisions' })).toHaveTextContent(
      'Meera Admin',
    );
    expect(await screen.findByRole('table', { name: 'Reviewed places' })).toHaveTextContent(
      'Casa Lagoa (demo), Goa',
    );

    renderRoute('/admin/reviews/queue?status=pending');
    const table = await screen.findByRole('table', { name: 'Reviews' });
    expect(within(table).getByRole('link', { name: 'Noisy at night' })).toHaveAttribute(
      'href',
      `/admin/reviews/${REVIEW_ID}`,
    );
    expect(table).toHaveTextContent('1 open');
  });

  it('customers can’t open the moderation pages', async () => {
    installFakeAdminApi({ role: 'user' });
    installFakeAdminReviewsApi('user');
    renderRoute('/admin/reviews');
    expect(
      (await screen.findAllByRole('heading', { name: /you don’t have access/i })).length,
    ).toBeGreaterThan(0);
  });
});
