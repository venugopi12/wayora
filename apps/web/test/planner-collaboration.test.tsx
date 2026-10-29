import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  notificationSchema,
  receivedInvitationSchema,
  type PlannedTrip,
  type TripMembers,
} from '@wayora/contracts';
import { linkFor } from '../src/features/notifications/shared';
import { installFakePlannerApi, item, membersOf, plannedTrip, uuid } from './fake-planner-api';
import { renderRoute } from './render';

/*
 * Plan collaboration in the web app (docs/planner.md#collaboration): controls
 * follow the role (the API enforces it too), sharing and member management,
 * invitations, conflict explanations, history, and live updates with their
 * polling fallback and cleanup.
 */

/** A minimal EventSource the tests drive by hand. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CLOSED = 2;
  readyState = 1;
  closed = false;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(
    readonly url: string,
    readonly init?: { withCredentials?: boolean },
  ) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown = {}) {
    for (const fn of this.listeners.get(type) ?? [])
      fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const JOURNEY = { timeout: 30_000 };
const D1 = '2026-11-12';

const owner = { name: 'Asha Rao', isYou: false };
function sharedTrip(role: 'editor' | 'viewer', overrides: Partial<PlannedTrip> = {}) {
  return plannedTrip({
    access: { role, canEdit: role === 'editor', canManage: false },
    owner,
    memberCount: 2,
    items: [
      item({
        title: 'Fort Aguada',
        day: D1,
        position: 0,
        addedBy: { name: 'Asha Rao', isYou: false },
      }),
      item({ title: 'Beach', day: D1, position: 1, addedBy: { name: 'Ravi Kumar', isYou: true } }),
    ],
    ...overrides,
  });
}

function teamOf(trip: PlannedTrip, you: 'owner' | 'ravi' | 'meera'): TripMembers {
  return membersOf(trip, {
    owner: { name: 'Asha Rao', initials: 'AR', isYou: you === 'owner' },
    members: [
      {
        id: uuid(),
        name: 'Ravi Kumar',
        initials: 'RK',
        isYou: you === 'ravi',
        role: 'editor',
        joinedAt: '2026-10-20T10:00:00.000Z',
      },
      {
        id: uuid(),
        name: 'Meera Iyer',
        initials: 'MI',
        isYou: you === 'meera',
        role: 'viewer',
        joinedAt: '2026-10-21T10:00:00.000Z',
      },
    ],
    limits: { maxMembers: 20, used: 2 },
  });
}

const dayList = () => screen.getByRole('list', { name: /^Day 1/ });
const titles = () =>
  within(dayList())
    .getAllByRole('heading', { level: 4 })
    .map((h) => h.textContent);

describe('controls follow the role', JOURNEY, () => {
  it('a viewer can browse everything but sees no edit controls', async () => {
    const trip = sharedTrip('viewer');
    installFakePlannerApi({ trips: [trip], members: { [trip.id]: teamOf(trip, 'meera') } });
    renderRoute(`/plans/${trip.id}`);
    await screen.findByRole('heading', { level: 1, name: 'Goa with friends' });
    expect(screen.getByText('View only')).toBeInTheDocument();
    expect(screen.getByText('Owner: Asha Rao')).toBeInTheDocument();
    expect(
      screen.getByText(/You can view this plan. Ask Asha Rao for editor access/),
    ).toBeInTheDocument();
    expect(titles()).toEqual(['Fort Aguada', 'Beach']);
    for (const name of [
      /^Add activity/,
      /^Edit details/,
      /^Delete plan/,
      /^Move “/,
      /^Edit “/,
      /^More actions/,
    ]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    const panel = screen.getByRole('complementary', { name: 'Sample suggestions' });
    await within(panel).findByRole('list', { name: 'Suggested activities' });
    expect(within(panel).queryByRole('button', { name: /Add to day/ })).toBeNull();
    // Browsing is fine: members and history open.
    fireEvent.click(screen.getByRole('button', { name: /^Members/ }));
    const dialog = await screen.findByRole('dialog', { name: 'People on this plan' });
    expect(await within(dialog).findByText('Ravi Kumar')).toBeInTheDocument();
    expect(within(dialog).queryByRole('heading', { name: 'Invite someone' })).toBeNull();
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(within(dialog).getByRole('button', { name: /Leave plan/ })).toBeInTheDocument();
  });

  it('an editor edits the itinerary and details, but can’t delete, share or link a booking', async () => {
    const trip = sharedTrip('editor');
    installFakePlannerApi({ trips: [trip], members: { [trip.id]: teamOf(trip, 'ravi') } });
    renderRoute(`/plans/${trip.id}`);
    await screen.findByRole('heading', { level: 1, name: 'Goa with friends' });
    expect(screen.getByText('Shared · Editor')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Add activity/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move “Fort Aguada” down' })).toBeInTheDocument();
    expect(screen.getByText('Added by Asha Rao')).toBeInTheDocument();
    expect(screen.getByText('Added by you')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete plan/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Edit details/ }));
    const edit = await screen.findByRole('dialog', { name: 'Edit plan details' });
    await within(edit).findByLabelText(/Trip name/);
    expect(within(edit).queryByLabelText('Linked booking')).toBeNull();
  });
});

describe('sharing a plan', JOURNEY, () => {
  it('the owner invites by email (in-app, with a link only the invitee can use), changes roles and removes members', async () => {
    const trip = plannedTrip({ memberCount: 2 });
    const team = teamOf(trip, 'owner');
    const api = installFakePlannerApi({
      trips: [trip],
      members: {
        [trip.id]: { ...team, access: { role: 'owner', canEdit: true, canManage: true } },
      },
    });
    const clipboard = { writeText: vi.fn(() => Promise.resolve()) };
    vi.stubGlobal('navigator', { ...navigator, clipboard });
    renderRoute(`/plans/${trip.id}`);
    fireEvent.click(await screen.findByRole('button', { name: /^Share/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Share this plan' });
    expect(await within(dialog).findByText('Ravi Kumar')).toBeInTheDocument();
    expect(within(dialog).getByText('Owner')).toBeInTheDocument();
    expect(within(dialog).queryByText(/@example/)).toBeNull();

    // Validation, then the API's answer for an unknown account.
    const email = within(dialog).getByLabelText('Their email address');
    fireEvent.click(within(dialog).getByRole('button', { name: /Send invitation/ }));
    expect(
      await within(dialog).findByText(/Enter your email address|valid email/i),
    ).toBeInTheDocument();
    fireEvent.change(email, { target: { value: 'nobody@example.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Send invitation/ }));
    expect(
      await within(dialog).findByText(/There’s no Wayora account with that email/),
    ).toBeInTheDocument();

    fireEvent.change(email, { target: { value: 'zoe@example.com' } });
    fireEvent.change(within(dialog).getByLabelText('Role'), { target: { value: 'viewer' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Send invitation/ }));
    const sent = await within(dialog).findByText(/Invitation sent to Zoe in Wayora/);
    const notice = sent.closest('[role]')!;
    expect(notice).toHaveTextContent('No email is sent.');
    expect(api.writes().at(-1)).toMatchObject({
      method: 'POST',
      path: `/planner/trips/${trip.id}/invitations`,
      body: { email: 'zoe@example.com', role: 'viewer' },
    });
    const invitationId = api.members.get(trip.id)!.invitations[0]!.id;
    expect(notice).toHaveTextContent(`/plans/invitations/${invitationId}`);
    fireEvent.click(within(dialog).getByRole('button', { name: /Copy link/ }));
    await waitFor(() =>
      expect(clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining(`/plans/invitations/${invitationId}`),
      ),
    );
    expect(
      await within(dialog).findByText('z•••@example.com · Viewer · open until 5 Nov', {
        exact: false,
      }),
    ).toBeInTheDocument();

    // Role change.
    fireEvent.change(within(dialog).getByLabelText('Role for Meera Iyer'), {
      target: { value: 'editor' },
    });
    await waitFor(() =>
      expect(api.writes().at(-1)).toMatchObject({ method: 'PATCH', body: { role: 'editor' } }),
    );
    expect(await screen.findByText('Meera Iyer is now editor')).toBeInTheDocument();

    // Removal asks first.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Ravi Kumar' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove Ravi Kumar?' });
    expect(confirm).toHaveTextContent('They’ll lose access to this plan straight away.');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Ravi Kumar was removed from the plan')).toBeInTheDocument();
    expect(api.writes().at(-1)).toMatchObject({
      method: 'DELETE',
      path: expect.stringContaining('/members/'),
    });

    // Withdrawing the open invitation.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw the invitation to Zoe' }));
    fireEvent.click(
      within(
        await screen.findByRole('dialog', { name: /Withdraw the invitation to Zoe/ }),
      ).getByRole('button', {
        name: 'Withdraw',
      }),
    );
    expect(await screen.findByText('Invitation to Zoe withdrawn')).toBeInTheDocument();
  });

  it('a member can leave, after confirming', async () => {
    const trip = sharedTrip('viewer');
    installFakePlannerApi({ trips: [trip], members: { [trip.id]: teamOf(trip, 'meera') } });
    const { router } = renderRoute(`/plans/${trip.id}`);
    fireEvent.click(await screen.findByRole('button', { name: /^Members/ }));
    const dialog = await screen.findByRole('dialog', { name: 'People on this plan' });
    fireEvent.click(await within(dialog).findByRole('button', { name: /Leave plan/ }));
    const confirm = await screen.findByRole('dialog', { name: 'Leave this plan?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Leave plan' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/plans'));
    expect(await screen.findByText(/You left “Goa with friends”/)).toBeInTheDocument();
  });
});

describe('invitations', JOURNEY, () => {
  const invitation = (overrides: Record<string, unknown> = {}) =>
    receivedInvitationSchema.parse({
      id: uuid(),
      trip: {
        id: '01890000-0000-7000-a000-00000000aaaa',
        title: 'Kyoto in spring',
        destinationName: 'Kyoto',
        startDate: '2027-04-02',
        endDate: '2027-04-05',
      },
      invitedBy: { name: 'Asha Rao' },
      role: 'editor',
      status: 'pending',
      createdAt: '2026-10-22T10:00:00.000Z',
      expiresAt: '2026-11-05T10:00:00.000Z',
      ...overrides,
    });

  it('shows open invitations on the plan list; accepting opens the plan', async () => {
    const pending = invitation();
    const kyoto = plannedTrip({
      id: pending.trip.id,
      title: 'Kyoto in spring',
      access: { role: 'editor', canEdit: true, canManage: false },
      owner,
      memberCount: 1,
    });
    const api = installFakePlannerApi({ trips: [kyoto], received: [pending] });
    const { router } = renderRoute('/plans');
    const panel = await screen.findByRole('region', { name: 'An invitation' });
    expect(panel).toHaveTextContent('Kyoto in spring');
    expect(panel).toHaveTextContent('Asha Rao invited you as editor · open until 5 Nov');
    expect(screen.getByText('Shared with you · Editor')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: /Accept/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/plans/${kyoto.id}`));
    expect(api.writes().at(-1)).toMatchObject({
      method: 'POST',
      path: `/planner/invitations/${pending.id}/accept`,
    });
  });

  it('has a page per invitation; closed and unknown ones say so', async () => {
    const declinedOne = invitation();
    const revoked = invitation({ status: 'revoked' });
    const api = installFakePlannerApi({ received: [declinedOne, revoked] });
    const first = renderRoute(`/plans/invitations/${declinedOne.id}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'You’re invited to plan a trip' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Other members will see your name, not your email address/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Decline/ }));
    expect(await screen.findByText('You declined this invitation')).toBeInTheDocument();
    expect(api.writes().at(-1)?.path).toBe(`/planner/invitations/${declinedOne.id}/decline`);
    first.unmount();

    const second = renderRoute(`/plans/invitations/${revoked.id}`);
    expect(await screen.findByText('The owner withdrew this invitation')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Accept/ })).toBeNull();
    second.unmount();

    renderRoute(`/plans/invitations/${uuid()}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: "We couldn't find that invitation" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/only for the account they were sent to/)).toBeInTheDocument();
  });

  it('plan notifications link to the plan or the invitation', () => {
    const base = {
      id: uuid(),
      category: 'plan',
      title: 'x',
      message: 'y',
      demo: false,
      read: false,
      readAt: null,
      createdAt: '2026-10-22T10:00:00.000Z',
    };
    const tripId = uuid();
    const invitationId = uuid();
    expect(
      linkFor(
        notificationSchema.parse({ ...base, type: 'plan_updated', link: { kind: 'plan', tripId } }),
      ),
    ).toEqual({ to: `/plans/${tripId}`, label: 'View plan' });
    expect(
      linkFor(
        notificationSchema.parse({
          ...base,
          type: 'plan_invitation',
          link: { kind: 'plan-invitation', invitationId },
        }),
      ),
    ).toEqual({ to: `/plans/invitations/${invitationId}`, label: 'View invitation' });
  });
});

describe('conflicting edits', JOURNEY, () => {
  it('explains when someone else changed the activity, and loads their version', async () => {
    const trip = sharedTrip('editor');
    const api = installFakePlannerApi({
      trips: [trip],
      members: { [trip.id]: teamOf(trip, 'ravi') },
    });
    renderRoute(`/plans/${trip.id}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit “Fort Aguada”' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit activity' });
    // Meanwhile, Asha renames it (version 2).
    const current = api.store.get(trip.id)!;
    const fort = current.days[0]!.items[0]!;
    api.store.set(trip.id, {
      ...current,
      days: current.days.map((d, i) =>
        i === 0
          ? {
              ...d,
              items: [{ ...fort, title: 'Fort at sunrise', version: 2 }, ...d.items.slice(1)],
            }
          : d,
      ),
    });
    fireEvent.change(within(dialog).getByLabelText(/^What/), { target: { value: 'Fort at noon' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save activity' }));
    expect(
      await within(dialog).findByText('Someone else changed this activity'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/now “Fort at sunrise”/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save activity' })).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Load the latest version' }));
    expect(within(dialog).getByLabelText(/^What/)).toHaveValue('Fort at sunrise');
    fireEvent.change(within(dialog).getByLabelText(/^What/), { target: { value: 'Fort at noon' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save activity' }));
    expect(await screen.findByText('Saved “Fort at noon”')).toBeInTheDocument();
    expect(
      api
        .writes()
        .filter((w) => w.method === 'PATCH')
        .map((w) => w.body?.version),
    ).toEqual([1, 2]);
  });

  it('a reorder based on an old order is refused and the latest order shown', async () => {
    const trip = sharedTrip('editor');
    const api = installFakePlannerApi({
      trips: [trip],
      members: { [trip.id]: teamOf(trip, 'ravi') },
    });
    renderRoute(`/plans/${trip.id}`);
    await screen.findByRole('heading', { level: 1 });
    // Asha swapped them a moment ago.
    const current = api.store.get(trip.id)!;
    const [fort, beach] = current.days[0]!.items;
    api.store.set(trip.id, {
      ...current,
      days: current.days.map((d, i) =>
        i === 0
          ? {
              ...d,
              items: [
                { ...beach!, position: 0 },
                { ...fort!, position: 1 },
              ],
            }
          : d,
      ),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Move “Beach” up' }));
    expect(titles()).toEqual(['Beach', 'Fort Aguada']); // shown at once
    expect(await screen.findByText('Someone else changed this day')).toBeInTheDocument();
    await waitFor(() => expect(titles()).toEqual(['Beach', 'Fort Aguada'])); // the latest saved order
    expect(api.writes().at(-1)).toMatchObject({
      method: 'PUT',
      body: { itemIds: [beach!.id, fort!.id], previousOrder: [fort!.id, beach!.id] },
    });
  });
});

describe('history and live updates', JOURNEY, () => {
  it('shows who changed what, with a way to the day', async () => {
    const trip = sharedTrip('viewer');
    installFakePlannerApi({
      trips: [trip],
      members: { [trip.id]: teamOf(trip, 'meera') },
      activity: {
        [trip.id]: [
          {
            revision: 4,
            type: 'item_added',
            actor: { name: 'Ravi Kumar', initials: 'RK', isYou: false },
            summary: 'Ravi Kumar added “Beach”',
            day: D1,
            createdAt: '2026-10-22T10:05:00.000Z',
          },
          {
            revision: 3,
            type: 'invitation_accepted',
            actor: { name: 'Meera Iyer', initials: 'MI', isYou: true },
            summary: 'You joined the plan as viewer',
            day: null,
            createdAt: '2026-10-22T10:00:00.000Z',
          },
        ],
      },
    });
    renderRoute(`/plans/${trip.id}?day=2026-11-13`);
    fireEvent.click(await screen.findByRole('button', { name: /^History/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Plan history' });
    const list = await within(sheet).findByRole('list', { name: 'Changes, newest first' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringContaining('Ravi Kumar added “Beach”'),
      expect.stringContaining('You joined the plan as viewer'),
    ]);
    fireEvent.click(within(list).getByRole('button', { name: /Day 1 · Thu 12 Nov/ }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Day 1/ })).toHaveAttribute('aria-selected', 'true'),
    );
  });

  it('re-reads the plan when another member changes it (not for repeats), and closes the stream on leave', async () => {
    const trip = sharedTrip('editor');
    const api = installFakePlannerApi({
      trips: [trip],
      members: { [trip.id]: teamOf(trip, 'ravi') },
    });
    const view = renderRoute(`/plans/${trip.id}`);
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe(`http://localhost:4000/api/v1/planner/trips/${trip.id}/events`);
    expect(source.init).toEqual({ withCredentials: true });
    source.emit('ready', { live: true });
    expect(
      await screen.findByText('Live: changes by others appear automatically'),
    ).toBeInTheDocument();

    const reads = () =>
      api.requests.filter((r) => r.method === 'GET' && r.path === `/planner/trips/${trip.id}`)
        .length;
    const before = reads();
    // A repeat of what's shown: nothing to re-read.
    source.emit('plan-changed', { revision: trip.revision, tripId: trip.id });
    await new Promise((r) => setTimeout(r, 50));
    expect(reads()).toBe(before);

    // Asha adds an activity elsewhere.
    const current = api.store.get(trip.id)!;
    api.store.set(trip.id, {
      ...current,
      revision: current.revision + 1,
      days: current.days.map((d, i) =>
        i === 0
          ? { ...d, items: [...d.items, item({ title: 'Sunset cruise', day: D1, position: 2 })] }
          : d,
      ),
    });
    source.emit('plan-changed', { revision: current.revision + 1, tripId: trip.id });
    await waitFor(() => expect(titles()).toEqual(['Fort Aguada', 'Beach', 'Sunset cruise']));
    expect(reads()).toBe(before + 1);

    view.unmount();
    expect(source.closed).toBe(true);
  });

  it('falls back to polling when the stream fails, and stops polling on leave', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const trip = sharedTrip('viewer');
    installFakePlannerApi({ trips: [trip], members: { [trip.id]: teamOf(trip, 'meera') } });
    const view = renderRoute(`/plans/${trip.id}`);
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;
    source.readyState = FakeEventSource.CLOSED;
    source.onerror?.();
    expect(await screen.findByText('Checks for changes every 30 seconds')).toBeInTheDocument();
    const pollCall = setSpy.mock.calls.findIndex((c) => c[1] === 30_000);
    expect(pollCall).toBeGreaterThanOrEqual(0);
    const timer = setSpy.mock.results[pollCall]!.value;
    view.unmount();
    expect(clearSpy).toHaveBeenCalledWith(timer);
  });

  it('personal plans don’t open a live-update stream', async () => {
    const trip = plannedTrip();
    installFakePlannerApi({ trips: [trip] });
    renderRoute(`/plans/${trip.id}`);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByRole('button', { name: /^Share/ })).toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(screen.queryByText(/Live:|Checks for changes/)).toBeNull();
  });
});
