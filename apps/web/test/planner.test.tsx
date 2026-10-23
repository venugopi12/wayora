import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { utcDateFromToday } from '@wayora/contracts';
import { demoBooking } from './fake-booking-api';
import { installFakePlannerApi, item, plannedTrip } from './fake-planner-api';
import { renderRoute } from './render';
import { hotel } from './search-fixtures';

/*
 * Trip planner pages (docs/planner.md#web) against a fake API: list, create
 * (validation, idempotency, unsaved-change protection), the day-by-day plan
 * (empty, loading, error and save states, keyboard reordering with rollback,
 * suggestions, warnings, delete with confirmation) and plan isolation.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const JOURNEY = { timeout: 30_000 };
const D1 = '2026-11-12';
const D2 = '2026-11-13';

function threeItemTrip() {
  return plannedTrip({
    items: [
      item({
        title: 'Breakfast',
        day: D1,
        position: 0,
        startTime: '08:00',
        durationMinutes: 60,
        endTime: '09:00',
        category: 'food',
      }),
      item({ title: 'Fort Aguada', day: D1, position: 1, startTime: '10:00' }),
      item({ title: 'Beach walk', day: D1, position: 2, category: 'beach', location: 'Candolim' }),
    ],
  });
}

const dayList = () => screen.getByRole('list', { name: /^Day 1/ });
const titlesInDay = () =>
  within(dayList())
    .getAllByRole('heading', { level: 4 })
    .map((h) => h.textContent);

describe('the plan list', JOURNEY, () => {
  it('shows the user’s plans, with dates and counts, apart from bookings', async () => {
    const api = installFakePlannerApi({
      trips: [
        threeItemTrip(),
        plannedTrip({ title: 'Kyoto in spring', startDate: '2027-04-02', endDate: '2027-04-02' }),
      ],
    });
    const release = api.hold('GET', /^\/planner\/trips$/);
    renderRoute('/plans');
    expect(await screen.findByRole('status', { name: 'Loading your plans' })).toBeInTheDocument();
    release();
    const list = await screen.findByRole('list', { name: 'Your plans' });
    const links = within(list).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      expect.stringContaining('Goa with friends'),
      expect.stringContaining('Kyoto in spring'),
    ]);
    expect(links[0]).toHaveTextContent('12 – 14 Nov 2026');
    expect(links[0]).toHaveTextContent('3 days · 3 activities');
    expect(links[1]).toHaveTextContent('2 Apr 2027');
    expect(screen.getByText(/They are not bookings/)).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Account' });
    expect(within(nav).getByRole('link', { name: 'Trip planner' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'My trips' })).not.toHaveAttribute('aria-current');
  });

  it('has an empty state that leads to a new plan', async () => {
    installFakePlannerApi();
    renderRoute('/plans');
    expect(await screen.findByText('No plans yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Start a plan/ })).toHaveAttribute(
      'href',
      '/plans/new',
    );
  });

  it('shows an error with a retry', async () => {
    const api = installFakePlannerApi({ trips: [threeItemTrip()] });
    api.failNext('GET', /^\/planner\/trips$/, 503, 'SERVICE_UNAVAILABLE');
    renderRoute('/plans');
    expect(await screen.findByText("We couldn't load your plans")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByRole('list', { name: 'Your plans' })).toBeInTheDocument();
  });
});

describe('creating a plan', JOURNEY, () => {
  it('validates, creates once with an idempotency key, and opens the new plan', async () => {
    const api = installFakePlannerApi();
    renderRoute('/plans/new?destination=goa');
    const title = await screen.findByLabelText(/Trip name/);
    expect(screen.getByLabelText(/^Destination/)).toHaveValue('goa');

    fireEvent.click(screen.getByRole('button', { name: 'Create plan' }));
    expect(await screen.findByText('Enter a trip name.')).toBeInTheDocument();
    expect(title).toHaveFocus();
    expect(api.writes()).toHaveLength(0);

    const start = utcDateFromToday(20);
    type(title, 'Goa long weekend');
    fireEvent.change(screen.getByLabelText(/First day/), { target: { value: start } });
    fireEvent.change(screen.getByLabelText(/Last day/), {
      target: { value: utcDateFromToday(18) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create plan' }));
    expect(
      await screen.findByText('The end date must be on or after the start date.'),
    ).toBeInTheDocument();
    expect(api.writes()).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(/Last day/), {
      target: { value: utcDateFromToday(22) },
    });
    fireEvent.click(screen.getByRole('radio', { name: /Relaxed/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Food' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create plan' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Goa long weekend' }),
    ).toBeInTheDocument();
    const posts = api.writes();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      method: 'POST',
      path: '/planner/trips',
      body: {
        title: 'Goa long weekend',
        destinationId: 'goa',
        startDate: start,
        preferences: { pace: 'relaxed', budget: null, group: null, interests: ['food'] },
      },
    });
    expect(posts[0]!.key).toMatch(/^[\w-]{16,}$/);
    expect(screen.getByRole('tab', { name: /Day 1/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Nothing planned for day 1 yet')).toBeInTheDocument();
  });

  it('can start from a sample destination page', async () => {
    installFakePlannerApi();
    renderRoute('/discover/goa');
    expect(await screen.findByRole('link', { name: 'Plan this trip' })).toHaveAttribute(
      'href',
      '/plans/new?destination=goa',
    );
  });

  it('accepts a destination outside the sample list', async () => {
    installFakePlannerApi();
    renderRoute('/plans/new');
    type(await screen.findByLabelText(/Trip name/), 'Hampi');
    fireEvent.change(screen.getByLabelText(/^Destination/), { target: { value: '__other' } });
    type(screen.getByLabelText(/Where are you going/), 'Hampi');
    fireEvent.change(screen.getByLabelText(/First day/), {
      target: { value: utcDateFromToday(5) },
    });
    fireEvent.change(screen.getByLabelText(/Last day/), { target: { value: utcDateFromToday(6) } });
    fireEvent.click(screen.getByRole('button', { name: 'Create plan' }));
    await screen.findByRole('heading', { level: 1, name: 'Hampi' });
    expect(await screen.findByText('No sample suggestions for Hampi')).toBeInTheDocument();
  });

  it('asks before leaving with unsaved changes', async () => {
    installFakePlannerApi();
    const { router } = renderRoute('/plans/new');
    type(await screen.findByLabelText(/Trip name/), 'Half-typed');
    const nav = screen.getByRole('navigation', { name: 'Account' });
    fireEvent.click(within(nav).getByRole('link', { name: 'My trips' }));
    const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stay on this page' }));
    expect(router.state.location.pathname).toBe('/plans/new');
    expect(screen.getByLabelText(/Trip name/)).toHaveValue('Half-typed');

    fireEvent.click(within(nav).getByRole('link', { name: 'My trips' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Leave without saving?' })).getByRole(
        'button',
        {
          name: 'Leave and discard',
        },
      ),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/trips'));
  });
});

describe('a plan', JOURNEY, () => {
  it('shows days, the schedule in saved order, notices and warnings in text', async () => {
    const trip = plannedTrip({
      items: [
        item({
          title: 'Breakfast',
          day: D1,
          position: 0,
          startTime: '09:00',
          durationMinutes: 60,
          endTime: '10:00',
          category: 'food',
        }),
        item({ title: 'Market', day: D1, position: 1, startTime: '09:30' }),
      ],
    });
    const [a, b] = trip.days[0]!.items;
    trip.warnings = [
      {
        code: 'overlap',
        day: D1,
        itemIds: [a!.id, b!.id],
        message: '“Breakfast” (09:00–10:00) overlaps “Market” (from 09:30).',
      },
    ];
    const api = installFakePlannerApi({ trips: [trip] });
    const release = api.hold('GET', new RegExp(`${trip.id}$`));
    renderRoute(`/plans/${trip.id}`);
    expect(await screen.findByRole('status', { name: 'Loading your plan' })).toBeInTheDocument();
    release();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Goa with friends' }),
    ).toBeInTheDocument();

    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      expect.stringContaining('Day 1Thu 12 Nov2'),
      expect.stringContaining('Day 2Fri 13 Nov0'),
      expect.stringContaining('Day 3Sat 14 Nov0'),
    ]);
    expect(screen.getByText('Plan · not booked')).toBeInTheDocument();
    expect(screen.getByText(/Not travel-time-validated:/)).toBeInTheDocument();
    expect(screen.getByText(/Times are local to Goa \(Asia\/Kolkata\)/)).toBeInTheDocument();

    expect(titlesInDay()).toEqual(['Breakfast', 'Market']);
    const first = within(dayList()).getAllByRole('listitem')[0]!;
    expect(first).toHaveTextContent('09:00–10:00');
    expect(first).toHaveTextContent('1 h');
    expect(first).toHaveTextContent('Warning: Overlaps another activity');

    const warnings = screen.getByRole('region', { name: '1 thing to check' });
    expect(warnings).toHaveTextContent('“Breakfast” (09:00–10:00) overlaps “Market” (from 09:30).');
    expect(warnings).toHaveTextContent('Your plan is saved either way.');

    const day2 = screen.getByRole('tab', { name: /Day 2/ });
    fireEvent.mouseDown(day2);
    fireEvent.click(day2);
    expect(await screen.findByText('Nothing planned for day 2 yet')).toBeInTheDocument();
  });

  it('adds an activity with validation and a save state', async () => {
    const trip = plannedTrip();
    const api = installFakePlannerApi({ trips: [trip] });
    renderRoute(`/plans/${trip.id}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Add the first activity' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add an activity' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add activity' }));
    expect(await within(dialog).findByText('Enter a name for the activity.')).toBeInTheDocument();
    expect(within(dialog).getByText('Choose a category.')).toBeInTheDocument();

    type(within(dialog).getByLabelText(/^What/), 'Sunset cruise');
    fireEvent.change(within(dialog).getByLabelText(/^Category/), {
      target: { value: 'sightseeing' },
    });
    fireEvent.change(within(dialog).getByLabelText(/Start time/), { target: { value: '18:00' } });
    type(within(dialog).getByLabelText(/Duration/), '90');

    const release = api.hold('POST', /\/items$/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add activity' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: /Add activity/ })).toBeDisabled(),
    );
    // A second click while saving sends nothing more.
    fireEvent.click(within(dialog).getByRole('button', { name: /Add activity/ }));
    release();

    expect(await screen.findByText('Added “Sunset cruise”')).toBeInTheDocument();
    expect(titlesInDay()).toEqual(['Sunset cruise']);
    expect(within(dayList()).getByRole('listitem')).toHaveTextContent('18:00–19:30');
    const posts = api.writes().filter((r) => r.path.endsWith('/items'));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({
      day: D1,
      title: 'Sunset cruise',
      startTime: '18:00',
      durationMinutes: 90,
    });
  });

  it('keeps the dialog open with the error when saving fails, and asks before discarding', async () => {
    const trip = plannedTrip();
    const api = installFakePlannerApi({ trips: [trip] });
    renderRoute(`/plans/${trip.id}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Add the first activity' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add an activity' });
    type(within(dialog).getByLabelText(/^What/), 'Museum');
    fireEvent.change(within(dialog).getByLabelText(/^Category/), { target: { value: 'culture' } });
    api.failNext(
      'POST',
      /\/items$/,
      409,
      'PLAN_LIMIT_REACHED',
      'A day can hold up to 20 activities. Choose another day.',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add activity' }));
    expect(
      await within(dialog).findByText('A day can hold up to 20 activities. Choose another day.'),
    ).toBeInTheDocument();

    escape();
    expect(await within(dialog).findByText('Discard your changes?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(within(dialog).getByLabelText(/^What/)).toHaveValue('Museum');
    escape();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('reorders with keyboard-operable buttons: shown at once, saved in one request, focus kept', async () => {
    const trip = threeItemTrip();
    const api = installFakePlannerApi({ trips: [trip] });
    renderRoute(`/plans/${trip.id}`);
    await screen.findByRole('heading', { level: 1 });
    expect(titlesInDay()).toEqual(['Breakfast', 'Fort Aguada', 'Beach walk']);
    expect(screen.getByRole('button', { name: 'Move “Breakfast” up' })).toBeDisabled();

    const down = screen.getByRole('button', { name: 'Move “Breakfast” down' });
    down.focus();
    fireEvent.click(down);
    expect(titlesInDay()).toEqual(['Fort Aguada', 'Breakfast', 'Beach walk']);
    expect(screen.getByRole('button', { name: 'Move “Breakfast” down' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Move “Breakfast” down' }));
    expect(titlesInDay()).toEqual(['Fort Aguada', 'Beach walk', 'Breakfast']);
    // At the end, focus moves to its other button.
    expect(screen.getByRole('button', { name: 'Move “Breakfast” up' })).toHaveFocus();
    expect(screen.getByText(/Moved “Breakfast” to position 3 of 3/)).toBeInTheDocument();

    await waitFor(() => expect(api.writes()).toHaveLength(1));
    const [ids] = [trip.days[0]!.items.map((i) => i.id)];
    expect(api.writes()[0]).toMatchObject({
      method: 'PUT',
      path: `/planner/trips/${trip.id}/days/${D1}/order`,
      body: { itemIds: [ids[1], ids[2], ids[0]] },
    });
    await waitFor(() => expect(screen.queryByText('Saving order…')).toBeNull());
    expect(titlesInDay()).toEqual(['Fort Aguada', 'Beach walk', 'Breakfast']);
  });

  it('puts the previous order back when saving the new one fails', async () => {
    const trip = threeItemTrip();
    const api = installFakePlannerApi({ trips: [trip] });
    renderRoute(`/plans/${trip.id}`);
    await screen.findByRole('heading', { level: 1 });
    api.failNext('PUT', /\/order$/, 503, 'SERVICE_UNAVAILABLE', 'Try again shortly.');
    fireEvent.click(screen.getByRole('button', { name: 'Move “Beach walk” up' }));
    expect(titlesInDay()).toEqual(['Breakfast', 'Beach walk', 'Fort Aguada']);
    expect(await screen.findByText('We couldn’t save the new order')).toBeInTheDocument();
    await waitFor(() => expect(titlesInDay()).toEqual(['Breakfast', 'Fort Aguada', 'Beach walk']));
  });

  it('suggests labelled sample activities with reasons and adds one to the selected day', async () => {
    const trip = plannedTrip();
    const api = installFakePlannerApi({ trips: [trip] });
    renderRoute(`/plans/${trip.id}?day=${D2}`);
    const panel = await screen.findByRole('complementary', { name: 'Sample suggestions' });
    expect(panel).toHaveTextContent('not AI and not live data');
    const list = await within(panel).findByRole('list', { name: 'Suggested activities' });
    const beach = within(list).getAllByRole('listitem')[0]!;
    expect(beach).toHaveTextContent('Palolem Beach');
    expect(beach).toHaveTextContent('Allow about 3 h (estimate)');
    expect(beach).toHaveTextContent('Usually free or low cost — check before you go');
    expect(beach).toHaveTextContent('Matches your interest in beach');

    fireEvent.click(within(beach).getByRole('button', { name: /Add to day 2.*Palolem Beach/ }));
    expect(await screen.findByText('Added “Palolem Beach” to day 2')).toBeInTheDocument();
    const post = api.writes().find((r) => r.path.endsWith('/items'))!;
    expect(post.body).toMatchObject({
      day: D2,
      suggestionId: 'goa:palolem-beach',
      durationMinutes: 180,
    });
    // Added suggestions aren't suggested again.
    await waitFor(() => expect(within(panel).queryByText('Palolem Beach')).toBeNull());
    expect(titlesInDay2()).toEqual(['Palolem Beach']);
  });

  it('moves, duplicates and deletes activities through the menu', async () => {
    const trip = threeItemTrip();
    const api = installFakePlannerApi({ trips: [trip] });
    renderRoute(`/plans/${trip.id}`);
    await screen.findByRole('heading', { level: 1 });

    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions for “Beach walk”' }), {
      key: 'Enter',
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to another day' }));
    const move = await screen.findByRole('dialog', { name: 'Move to another day' });
    fireEvent.change(within(move).getByLabelText('Day'), { target: { value: D2 } });
    fireEvent.click(within(move).getByRole('button', { name: 'Move activity' }));
    expect(await screen.findByText('Moved “Beach walk” to day 2')).toBeInTheDocument();
    expect(titlesInDay()).toEqual(['Breakfast', 'Fort Aguada']);

    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions for “Fort Aguada”' }), {
      key: 'Enter',
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    expect(await screen.findByText('Duplicated “Fort Aguada”')).toBeInTheDocument();
    expect(titlesInDay()).toEqual(['Breakfast', 'Fort Aguada', 'Fort Aguada']);
    expect(api.writes().find((r) => r.path.endsWith('/duplicate'))!.key).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions for “Breakfast”' }), {
      key: 'Enter',
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete this activity?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete activity' }));
    expect(await screen.findByText('Deleted “Breakfast”')).toBeInTheDocument();
    expect(titlesInDay()).toEqual(['Fort Aguada', 'Fort Aguada']);
  });

  it('deletes the plan only after confirmation', async () => {
    const trip = threeItemTrip();
    const api = installFakePlannerApi({ trips: [trip] });
    const { router } = renderRoute(`/plans/${trip.id}`);
    fireEvent.click(await screen.findByRole('button', { name: /Delete plan/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this plan?' });
    expect(dialog).toHaveTextContent('and its 3 activities will be deleted');
    expect(dialog).toHaveTextContent('Bookings aren’t affected.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep plan' }));
    expect(api.store.has(trip.id)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Delete plan/ }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Delete this plan?' })).getByRole('button', {
        name: 'Delete plan',
      }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/plans'));
    expect(api.store.has(trip.id)).toBe(false);
    expect(await screen.findByText('No plans yet')).toBeInTheDocument();
    // Nothing asks for the deleted plan afterwards.
    const deletedAt = api.requests.findIndex((r) => r.method === 'DELETE');
    expect(api.requests.slice(deletedAt + 1).filter((r) => r.path.includes(trip.id))).toEqual([]);
  });

  it('edits details, links a confirmed booking by choice, and explains a conflicting edit', async () => {
    const booking = demoBooking(hotel);
    const trip = threeItemTrip();
    const api = installFakePlannerApi({ trips: [trip], bookings: [booking] });
    renderRoute(`/plans/${trip.id}`);
    fireEvent.click(await screen.findByRole('button', { name: /Edit details/ }));
    let dialog = await screen.findByRole('dialog', { name: 'Edit plan details' });
    const title = await within(dialog).findByLabelText(/Trip name/);
    fireEvent.change(title, { target: { value: '' } });
    type(title, 'Goa, slowly');
    await waitFor(() =>
      expect(
        within(dialog).getByRole('option', { name: new RegExp(booking.reference) }),
      ).toBeInTheDocument(),
    );
    fireEvent.change(within(dialog).getByLabelText('Linked booking'), {
      target: { value: booking.reference },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save details' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Goa, slowly' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: booking.reference })).toHaveAttribute(
      'href',
      `/trips/${booking.reference}`,
    );
    expect(api.writes().at(-1)!.body).toMatchObject({
      version: 1,
      title: 'Goa, slowly',
      bookingReference: booking.reference,
    });

    // Someone else changed the plan meanwhile.
    api.store.set(trip.id, { ...api.store.get(trip.id)!, version: 9 });
    fireEvent.click(screen.getByRole('button', { name: /Edit details/ }));
    dialog = await screen.findByRole('dialog', { name: 'Edit plan details' });
    type(await within(dialog).findByLabelText(/Notes/), 'Pack sunscreen');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save details' }));
    expect(await within(dialog).findByText(/changed somewhere else/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Reload the plan' })).toBeInTheDocument();
  });

  it('says when a plan can’t be found, or fails to load', async () => {
    const api = installFakePlannerApi();
    const missing = renderRoute('/plans/01890000-0000-7000-a000-999999999999');
    expect(
      await screen.findByRole('heading', { level: 1, name: "We couldn't find that plan" }),
    ).toBeInTheDocument();
    missing.unmount();
    const bad = renderRoute('/plans/not-a-plan');
    expect(await screen.findByText("We couldn't find that plan")).toBeInTheDocument();
    bad.unmount();
    expect(api.requests.some((r) => r.path.includes('not-a-plan'))).toBe(false);

    const trip = plannedTrip();
    api.store.set(trip.id, trip);
    api.failNext('GET', new RegExp(`${trip.id}$`), 503, 'SERVICE_UNAVAILABLE');
    renderRoute(`/plans/${trip.id}`);
    expect(await screen.findByText("We couldn't load this plan")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Goa with friends' }),
    ).toBeInTheDocument();
  });

  it('uses touch-sized controls and renders text as text', async () => {
    const trip = plannedTrip({
      title: '<img src=x onerror=alert(1)>',
      items: [item({ title: '<b>bold?</b>', day: D1, notes: 'Line one\nLine two' })],
    });
    installFakePlannerApi({ trips: [trip] });
    renderRoute(`/plans/${trip.id}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: '<img src=x onerror=alert(1)>' }),
    ).toBeInTheDocument();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(screen.getByRole('heading', { level: 4, name: '<b>bold?</b>' })).toBeInTheDocument();
    for (const name of [/Move “<b>bold\?<\/b>” up/, /Edit “<b>bold\?<\/b>”/, /More actions/]) {
      expect(screen.getByRole('button', { name })).toHaveClass('size-11'); // 44 px
    }
  });
});

/** Sets a text field's whole value, as typing it would. */
function type(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
}

function escape() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
}

function titlesInDay2() {
  return within(screen.getByRole('list', { name: /^Day 2/ }))
    .getAllByRole('heading', { level: 4 })
    .map((h) => h.textContent);
}
