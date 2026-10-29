import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bookingRequirementsFor,
  bookingSchema,
  invitationResponseSchema,
  plannedTripListSchema,
  plannedTripSchema,
  plannerActivityListSchema,
  receivedInvitationListSchema,
  sentInvitationSchema,
  tripMembersSchema,
  utcDateFromToday,
  type PlannedTrip,
  type SearchResult,
} from '@wayora/contracts';
import type { Env } from '../../src/config/env.js';
import { PLANNER_EVENTS_CHANNEL } from '../../src/modules/planner/planner.routes.js';
import { PgSignalHub, type SignalHub } from '../../src/services/signal-hub.js';
import { buildTestApp } from '../helpers.js';
import { VALID_INPUTS } from '../search-support.js';
import {
  ORIGIN,
  TEST_DATABASE_URL,
  disconnect,
  resetAccounts,
  testClock,
  testPrisma,
} from './db.js';

/*
 * Plan collaboration against a real PostgreSQL (docs/planner.md#collaboration):
 * roles and what each may do, the invitation lifecycle (accept, decline,
 * revoke, expire, duplicates, concurrency), member management and owner
 * protection, conflicting edits, the activity history, notifications, and
 * live updates over real LISTEN/NOTIFY — and, throughout, that nobody gets
 * in without an invitation addressed to them.
 */

if (process.env.CI && !TEST_DATABASE_URL) {
  throw new Error(
    'CI is set but TEST_DATABASE_URL is not: the collaboration tests would be skipped.',
  );
}

type Agent = ReturnType<typeof request.agent>;
const DAY_MS = 24 * 60 * 60 * 1000;

const BASE_ENV: Partial<Env> = {
  SESSION_IDLE_TIMEOUT_HOURS: 24 * 90,
  SESSION_ABSOLUTE_TIMEOUT_HOURS: 24 * 120,
  BOOKING_RATE_LIMIT_MAX: 1000,
  PAYMENT_RATE_LIMIT_MAX: 1000,
  PLANNER_RATE_LIMIT_MAX: 1000,
  PLANNER_INVITE_RATE_LIMIT_MAX: 1000,
  RATE_LIMIT_MAX: 5000,
  PAYMENT_PROVIDER: 'demo',
};

function app(
  options: {
    env?: Partial<Env>;
    clock?: ReturnType<typeof testClock>;
    hub?: SignalHub;
    stream?: Record<string, number>;
  } = {},
) {
  return buildTestApp({
    prisma: testPrisma(),
    env: { ...BASE_ENV, ...options.env },
    logger: pino({ level: 'silent' }),
    now: (options.clock ?? testClock()).now,
    ...(options.hub ? { plannerEvents: options.hub } : {}),
    ...(options.stream ? { plannerStream: options.stream } : {}),
  });
}

async function signedIn(target: ReturnType<typeof app>, email: string, name: string) {
  const agent = request.agent(target);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('Origin', ORIGIN)
    .send({ name, email, password: 'blue river morning' });
  expect(res.status).toBe(201);
  return agent;
}

const START = utcDateFromToday(10);
const DAY2 = utcDateFromToday(11);
const END = utcDateFromToday(12);

const api = (path: string) => `/api/v1/planner${path}`;
const post = (
  agent: Agent,
  path: string,
  body: unknown = {},
  key: string | null = randomUUID(),
) => {
  const req = agent.post(api(path)).set('Origin', ORIGIN);
  if (key) req.set('Idempotency-Key', key);
  return req.send(body as object);
};
const patch = (agent: Agent, path: string, body: unknown) =>
  agent
    .patch(api(path))
    .set('Origin', ORIGIN)
    .send(body as object);
const put = (agent: Agent, path: string, body: unknown) =>
  agent
    .put(api(path))
    .set('Origin', ORIGIN)
    .send(body as object);
const del = (agent: Agent, path: string) => agent.delete(api(path)).set('Origin', ORIGIN);

async function getTrip(agent: Agent, tripId: string): Promise<PlannedTrip> {
  const res = await agent.get(api(`/trips/${tripId}`));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return plannedTripSchema.parse(res.body.data);
}

/** Asha owns a plan with one activity; Ravi, Meera and Zoe have accounts. */
async function world(options: Parameters<typeof app>[0] = {}) {
  const target = app(options);
  const asha = await signedIn(target, 'asha@example.com', 'Asha Rao');
  const ravi = await signedIn(target, 'ravi@example.com', 'Ravi Kumar');
  const meera = await signedIn(target, 'meera@example.com', 'Meera Iyer');
  const zoe = await signedIn(target, 'zoe@example.com', 'Zoe Das');
  const created = await post(asha, '/trips', {
    title: 'Goa with friends',
    destinationId: 'goa',
    startDate: START,
    endDate: END,
    notes: 'Bring sunscreen',
  });
  expect(created.status).toBe(201);
  const tripId = created.body.data.id as string;
  const added = await post(asha, `/trips/${tripId}/items`, {
    day: START,
    title: 'Fort Aguada',
    category: 'sightseeing',
  });
  expect(added.status).toBe(201);
  return { target, asha, ravi, meera, zoe, tripId };
}

async function invite(owner: Agent, tripId: string, email: string, role: 'editor' | 'viewer') {
  const res = await post(owner, `/trips/${tripId}/invitations`, { email, role }, null);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return sentInvitationSchema.parse(res.body.data);
}

async function join(
  owner: Agent,
  member: Agent,
  tripId: string,
  email: string,
  role: 'editor' | 'viewer',
) {
  const invitation = await invite(owner, tripId, email, role);
  const res = await post(member, `/invitations/${invitation.id}/accept`, {}, null);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return invitation;
}

/** Asha (owner), Ravi (editor) and Meera (viewer) share a plan; Zoe is outside. */
async function shared(options: Parameters<typeof app>[0] = {}) {
  const w = await world(options);
  await join(w.asha, w.ravi, w.tripId, 'ravi@example.com', 'editor');
  await join(w.asha, w.meera, w.tripId, 'Meera@Example.com', 'viewer');
  const members = tripMembersSchema.parse(
    (await w.asha.get(api(`/trips/${w.tripId}/members`))).body.data,
  );
  const memberId = (name: string) => members.members.find((m) => m.name === name)!.id;
  return { ...w, raviMemberId: memberId('Ravi Kumar'), meeraMemberId: memberId('Meera Iyer') };
}

const userId = async (email: string) =>
  (await testPrisma().user.findUniqueOrThrow({ where: { email } })).id;
const notificationsFor = async (email: string) =>
  testPrisma().notification.findMany({
    where: { userId: await userId(email) },
    orderBy: { createdAt: 'asc' },
  });

describe.skipIf(!TEST_DATABASE_URL)('plan collaboration (integration, real PostgreSQL)', () => {
  beforeEach(resetAccounts);
  afterAll(disconnect);

  describe('personal plans keep working', () => {
    it('a plan without members is the owner’s alone, with access and history', async () => {
      const { asha, zoe, tripId } = await world();
      const trip = await getTrip(asha, tripId);
      expect(trip).toMatchObject({
        access: { role: 'owner', canEdit: true, canManage: true },
        owner: { name: 'Asha Rao', isYou: true },
        memberCount: 0,
        revision: 1,
      });
      expect(trip.days[0]!.items[0]).toMatchObject({
        title: 'Fort Aguada',
        version: 1,
        addedBy: { name: 'Asha Rao', isYou: true },
      });
      expect((await zoe.get(api(`/trips/${tripId}`))).status).toBe(404);
      const members = tripMembersSchema.parse(
        (await asha.get(api(`/trips/${tripId}/members`))).body.data,
      );
      expect(members).toMatchObject({ members: [], invitations: [], owner: { name: 'Asha Rao' } });
    });
  });

  describe('invitations', () => {
    it('invites an existing account, which accepts and joins with that role', async () => {
      const { asha, ravi, tripId } = await world();
      const invitation = await invite(asha, tripId, '  RAVI@example.com ', 'editor');
      expect(invitation).toMatchObject({
        invitee: {
          name: 'Ravi Kumar',
          initials: 'RK',
          emailMasked: 'r•••@example.com',
          isYou: false,
        },
        role: 'editor',
        status: 'pending',
      });
      expect(Date.parse(invitation.expiresAt) - Date.parse(invitation.createdAt)).toBe(14 * DAY_MS);
      // Not a member yet: no access, not in the list.
      expect((await ravi.get(api(`/trips/${tripId}`))).status).toBe(404);

      const received = receivedInvitationListSchema.parse(
        (await ravi.get(api('/invitations'))).body.data,
      );
      expect(received.items).toEqual([
        expect.objectContaining({
          id: invitation.id,
          trip: expect.objectContaining({
            id: tripId,
            title: 'Goa with friends',
            destinationName: 'Goa',
          }),
          invitedBy: { name: 'Asha Rao' },
          role: 'editor',
          status: 'pending',
        }),
      ]);
      // In-app notification, linked to the invitation; no email queued (not configured, in-app only).
      const [note] = await notificationsFor('ravi@example.com');
      expect(note).toMatchObject({ type: 'PLAN_INVITATION', tripInvitationId: invitation.id });
      expect(note!.message).toContain(
        'Asha Rao invited you to join the plan “Goa with friends” as an editor',
      );
      expect(note!.message).not.toContain('@');
      expect(await testPrisma().notificationDelivery.count()).toBe(0);
      const list = (await ravi.get('/api/v1/notifications')).body.data;
      expect(list.items[0].link).toEqual({ kind: 'plan-invitation', invitationId: invitation.id });

      const accepted = await post(ravi, `/invitations/${invitation.id}/accept`, {}, null);
      expect(accepted.status).toBe(200);
      expect(invitationResponseSchema.parse(accepted.body.data)).toMatchObject({
        tripId,
        invitation: { status: 'accepted' },
      });
      const trip = await getTrip(ravi, tripId);
      expect(trip.access).toEqual({ role: 'editor', canEdit: true, canManage: false });
      expect(trip.owner).toEqual({ name: 'Asha Rao', isYou: false });
      const plans = plannedTripListSchema.parse((await ravi.get(api('/trips'))).body.data);
      expect(plans.items.map((p) => [p.title, p.access.role])).toEqual([
        ['Goa with friends', 'editor'],
      ]);

      const [accept] = (await notificationsFor('asha@example.com')).filter(
        (n) => n.type === 'PLAN_INVITATION_ACCEPTED',
      );
      expect(accept).toMatchObject({ plannedTripId: tripId });
      expect(accept!.message).toBe('Ravi Kumar joined your plan “Goa with friends”.');
      const ashaLink = (await asha.get('/api/v1/notifications')).body.data.items[0].link;
      expect(ashaLink).toEqual({ kind: 'plan', tripId });
      // Answering again is refused; the membership stays single.
      const again = await post(ravi, `/invitations/${invitation.id}/accept`, {}, null);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('INVITATION_CLOSED');
      expect(await testPrisma().tripMember.count()).toBe(1);
    });

    it('refuses unknown, inactive, own and existing recipients, and duplicate open invitations', async () => {
      const { asha, ravi, tripId } = await world();
      await testPrisma().user.update({
        where: { email: 'zoe@example.com' },
        data: { status: 'SUSPENDED' },
      });
      for (const email of [
        'nobody@example.com',
        'zoe@example.com',
        'asha@example.com',
        'not-an-email',
      ]) {
        const res = await post(
          asha,
          `/trips/${tripId}/invitations`,
          { email, role: 'viewer' },
          null,
        );
        expect(res.status, email).toBe(400);
        expect(res.body.error.details[0].path).toBe('body.email');
      }
      for (const role of ['owner', 'admin', '']) {
        const res = await post(
          asha,
          `/trips/${tripId}/invitations`,
          { email: 'ravi@example.com', role },
          null,
        );
        expect(res.status, role).toBe(400);
      }
      const extra = await post(
        asha,
        `/trips/${tripId}/invitations`,
        { email: 'ravi@example.com', role: 'editor', userId: randomUUID(), status: 'accepted' },
        null,
      );
      expect(extra.status).toBe(400);

      await invite(asha, tripId, 'ravi@example.com', 'viewer');
      const dup = await post(
        asha,
        `/trips/${tripId}/invitations`,
        { email: 'ravi@example.com', role: 'editor' },
        null,
      );
      expect(dup.status).toBe(409);
      expect(await testPrisma().tripInvitation.count({ where: { status: 'PENDING' } })).toBe(1);

      // Once a member, they can't be invited again.
      const [open] = receivedInvitationListSchema.parse(
        (await ravi.get(api('/invitations'))).body.data,
      ).items;
      await post(ravi, `/invitations/${open!.id}/accept`, {}, null).expect(200);
      const member = await post(
        asha,
        `/trips/${tripId}/invitations`,
        { email: 'ravi@example.com', role: 'editor' },
        null,
      );
      expect(member.status).toBe(409);
    });

    it('creates one invitation when the same one is sent twice at once', async () => {
      const { asha, tripId } = await world();
      const body = { email: 'ravi@example.com', role: 'editor' };
      const results = await Promise.all([
        post(asha, `/trips/${tripId}/invitations`, body, null),
        post(asha, `/trips/${tripId}/invitations`, body, null),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await testPrisma().tripInvitation.count()).toBe(1);
      expect(await testPrisma().notification.count({ where: { type: 'PLAN_INVITATION' } })).toBe(1);
    });

    it('declined, revoked and expired invitations can’t be used', async () => {
      const clock = testClock();
      const { asha, ravi, meera, zoe, tripId } = await world({ clock });
      // Declined
      const first = await invite(asha, tripId, 'ravi@example.com', 'editor');
      const declined = await post(ravi, `/invitations/${first.id}/decline`, {}, null);
      expect(declined.status).toBe(200);
      expect(declined.body.data).toMatchObject({
        tripId: null,
        invitation: { status: 'declined' },
      });
      expect((await post(ravi, `/invitations/${first.id}/accept`, {}, null)).body.error.code).toBe(
        'INVITATION_CLOSED',
      );
      expect((await ravi.get(api(`/trips/${tripId}`))).status).toBe(404);
      expect((await notificationsFor('asha@example.com')).map((n) => n.type)).toContain(
        'PLAN_INVITATION_DECLINED',
      );

      // Revoked
      const second = await invite(asha, tripId, 'meera@example.com', 'viewer');
      const revoked = await del(asha, `/trips/${tripId}/invitations/${second.id}`);
      expect(revoked.status).toBe(200);
      expect(revoked.body.data.status).toBe('revoked');
      const late = await post(meera, `/invitations/${second.id}/accept`, {}, null);
      expect(late.status).toBe(409);
      expect(late.body.error.message).toBe('The owner withdrew this invitation.');
      expect((await del(asha, `/trips/${tripId}/invitations/${second.id}`)).status).toBe(409);

      // Expired: 14 days later.
      const third = await invite(asha, tripId, 'zoe@example.com', 'viewer');
      clock.advance(15 * DAY_MS);
      const listed = receivedInvitationListSchema.parse(
        (await zoe.get(api('/invitations'))).body.data,
      );
      expect(listed.items).toEqual([]);
      const all = receivedInvitationListSchema.parse(
        (await zoe.get(api('/invitations?status=all'))).body.data,
      );
      expect(all.items[0]).toMatchObject({ id: third.id, status: 'expired' });
      const expired = await post(zoe, `/invitations/${third.id}/accept`, {}, null);
      expect(expired.status).toBe(409);
      expect(expired.body.error.message).toMatch(/expired/);
      expect(
        await testPrisma().tripInvitation.findUnique({ where: { id: third.id } }),
      ).toMatchObject({
        status: 'EXPIRED',
      });
      // The expired one doesn't block a fresh invitation.
      await invite(asha, tripId, 'zoe@example.com', 'viewer');
      expect(await testPrisma().tripMember.count()).toBe(0);
    });

    it('only the recipient can see or answer an invitation; only the owner can send or revoke', async () => {
      const { asha, ravi, meera, zoe, tripId } = await shared();
      const invitation = await invite(asha, tripId, 'zoe@example.com', 'viewer');
      for (const agent of [asha, ravi, meera]) {
        expect((await agent.get(api(`/invitations/${invitation.id}`))).status).toBe(404);
        expect((await post(agent, `/invitations/${invitation.id}/accept`, {}, null)).status).toBe(
          404,
        );
        expect((await post(agent, `/invitations/${invitation.id}/decline`, {}, null)).status).toBe(
          404,
        );
      }
      // Editors and viewers can't invite or revoke; Zoe (not a member yet) gets 404.
      for (const agent of [ravi, meera]) {
        const res = await post(
          agent,
          `/trips/${tripId}/invitations`,
          { email: 'x@example.com', role: 'viewer' },
          null,
        );
        expect(res.status).toBe(403);
        expect((await del(agent, `/trips/${tripId}/invitations/${invitation.id}`)).status).toBe(
          403,
        );
      }
      expect((await del(zoe, `/trips/${tripId}/invitations/${invitation.id}`)).status).toBe(404);
      // Members don't see open invitations (or anyone's email).
      const view = (await ravi.get(api(`/trips/${tripId}/members`))).body.data;
      expect(view.invitations).toEqual([]);
      expect(JSON.stringify(view)).not.toContain('@');
      expect((await zoe.get(api(`/invitations/${invitation.id}`))).status).toBe(200);
    });

    it('accepting the same invitation twice at once joins once', async () => {
      const { asha, ravi, tripId } = await world();
      const invitation = await invite(asha, tripId, 'ravi@example.com', 'editor');
      const results = await Promise.all([
        post(ravi, `/invitations/${invitation.id}/accept`, {}, null),
        post(ravi, `/invitations/${invitation.id}/accept`, {}, null),
        post(ravi, `/invitations/${invitation.id}/decline`, {}, null),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(2);
      const members = await testPrisma().tripMember.count();
      const status = (
        await testPrisma().tripInvitation.findUniqueOrThrow({ where: { id: invitation.id } })
      ).status;
      expect([members, status]).toEqual(status === 'ACCEPTED' ? [1, 'ACCEPTED'] : [0, 'DECLINED']);
      expect(
        await testPrisma().notification.count({
          where: { type: { in: ['PLAN_INVITATION_ACCEPTED', 'PLAN_INVITATION_DECLINED'] } },
        }),
      ).toBe(1);
    });
  });

  describe('roles and permissions', () => {
    it('editors change the itinerary and details; viewers only look; strangers get nothing', async () => {
      const { asha, ravi, meera, zoe, tripId } = await shared();
      const trip = await getTrip(ravi, tripId);
      const fort = trip.days[0]!.items[0]!;

      // Editor: every itinerary change, plus notes, preferences and dates.
      const added = await post(ravi, `/trips/${tripId}/items`, {
        day: START,
        title: 'Beach',
        category: 'beach',
      });
      expect(added.status).toBe(201);
      const beach = plannedTripSchema.parse(added.body.data).days[0]!.items[1]!;
      expect(beach.addedBy).toEqual({ name: 'Ravi Kumar', isYou: true });
      expect(
        (await patch(ravi, `/trips/${tripId}/items/${fort.id}`, { version: 1, notes: 'Go early' }))
          .status,
      ).toBe(200);
      expect(
        (
          await put(ravi, `/trips/${tripId}/days/${START}/order`, {
            itemIds: [beach.id, fort.id],
            previousOrder: [fort.id, beach.id],
          })
        ).status,
      ).toBe(200);
      expect(
        (await patch(ravi, `/trips/${tripId}/items/${beach.id}`, { version: 1, day: DAY2 })).status,
      ).toBe(200);
      expect((await post(ravi, `/trips/${tripId}/items/${beach.id}/duplicate`, {})).status).toBe(
        201,
      );
      expect((await del(ravi, `/trips/${tripId}/items/${beach.id}`)).status).toBe(200);
      const details = await patch(ravi, `/trips/${tripId}`, {
        version: trip.version,
        notes: 'Bring sunscreen and hats',
        preferences: { pace: 'relaxed' },
      });
      expect(details.status).toBe(200);
      expect(details.body.data.notes).toBe('Bring sunscreen and hats');
      expect((await ravi.get(api(`/trips/${tripId}/suggestions`))).status).toBe(200);

      // Editor: not the owner's powers.
      const fresh = await getTrip(ravi, tripId);
      expect(
        (await patch(ravi, `/trips/${tripId}`, { version: fresh.version, bookingReference: null }))
          .status,
      ).toBe(403);
      expect((await del(ravi, `/trips/${tripId}`)).status).toBe(403);

      // Viewer: can look at everything, change nothing.
      const seen = await getTrip(meera, tripId);
      expect(seen.access).toEqual({ role: 'viewer', canEdit: false, canManage: false });
      expect(seen.notes).toBe('Bring sunscreen and hats');
      for (const path of ['', '/suggestions', '/members', '/activity']) {
        expect((await meera.get(api(`/trips/${tripId}${path}`))).status, path).toBe(200);
      }
      const item = seen.days[0]!.items[0]!;
      const writes = [
        post(meera, `/trips/${tripId}/items`, { day: START, title: 'Sneaky', category: 'other' }),
        patch(meera, `/trips/${tripId}/items/${item.id}`, {
          version: item.version,
          title: 'Changed',
        }),
        patch(meera, `/trips/${tripId}/items/${item.id}`, { version: item.version, day: DAY2 }),
        del(meera, `/trips/${tripId}/items/${item.id}`),
        post(meera, `/trips/${tripId}/items/${item.id}/duplicate`, {}),
        put(meera, `/trips/${tripId}/days/${START}/order`, {
          itemIds: [item.id],
          previousOrder: [item.id],
        }),
        patch(meera, `/trips/${tripId}`, { version: seen.version, title: 'Mine now' }),
        del(meera, `/trips/${tripId}`),
        post(
          meera,
          `/trips/${tripId}/invitations`,
          { email: 'zoe@example.com', role: 'editor' },
          null,
        ),
      ];
      for (const [n, res] of (await Promise.all(writes)).entries()) {
        expect(res.status, `write #${n}`).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      }

      // Stranger: every endpoint is "not found", and reveals nothing.
      const strangers = [
        zoe.get(api(`/trips/${tripId}`)),
        zoe.get(api(`/trips/${tripId}/members`)),
        zoe.get(api(`/trips/${tripId}/activity`)),
        zoe.get(api(`/trips/${tripId}/suggestions`)),
        zoe.get(api(`/trips/${tripId}/events`)),
        patch(zoe, `/trips/${tripId}`, { version: 1, title: 'x' }),
        post(zoe, `/trips/${tripId}/items`, { day: START, title: 'x', category: 'other' }),
        put(zoe, `/trips/${tripId}/days/${START}/order`, {
          itemIds: [item.id],
          previousOrder: [item.id],
        }),
        del(zoe, `/trips/${tripId}/items/${item.id}`),
        del(zoe, `/trips/${tripId}`),
      ];
      for (const [n, res] of (await Promise.all(strangers)).entries()) {
        expect(res.status, `request #${n}`).toBe(404);
        expect(JSON.stringify(res.body)).not.toMatch(/Goa with friends|Asha|sunscreen/);
      }
      expect(plannedTripListSchema.parse((await zoe.get(api('/trips'))).body.data).items).toEqual(
        [],
      );
      // The plan is untouched by the refused writes.
      expect((await getTrip(asha, tripId)).title).toBe('Goa with friends');
    });

    it('the owner changes roles; nobody else can, and nobody can become owner', async () => {
      const { asha, ravi, meera, tripId, raviMemberId, meeraMemberId } = await shared();
      // Escalation attempts.
      for (const [agent, memberId, role] of [
        [meera, meeraMemberId, 'editor'],
        [ravi, raviMemberId, 'editor'],
        [ravi, meeraMemberId, 'editor'],
      ] as const) {
        expect((await patch(agent, `/trips/${tripId}/members/${memberId}`, { role })).status).toBe(
          403,
        );
      }
      for (const body of [
        { role: 'owner' },
        { role: 'editor', userId: randomUUID() },
        { role: 'editor', tripId },
      ]) {
        expect((await patch(asha, `/trips/${tripId}/members/${raviMemberId}`, body)).status).toBe(
          400,
        );
      }
      expect(
        (await patch(asha, `/trips/${tripId}/members/${randomUUID()}`, { role: 'editor' })).status,
      ).toBe(404);

      const changed = await patch(asha, `/trips/${tripId}/members/${meeraMemberId}`, {
        role: 'editor',
      });
      expect(changed.status).toBe(200);
      expect(
        tripMembersSchema.parse(changed.body.data).members.find((m) => m.id === meeraMemberId)
          ?.role,
      ).toBe('editor');
      // Takes effect at once, and is persisted.
      expect((await getTrip(meera, tripId)).access.role).toBe('editor');
      const meeraNotes = await notificationsFor('meera@example.com');
      expect(meeraNotes.at(-1)).toMatchObject({
        type: 'PLAN_MEMBER_CHANGED',
        plannedTripId: tripId,
      });
      expect(meeraNotes.at(-1)!.message).toBe('You can now edit the plan “Goa with friends”.');
      // Same role again: no change, no new notification or history.
      const before = (await getTrip(asha, tripId)).revision;
      await patch(asha, `/trips/${tripId}/members/${meeraMemberId}`, { role: 'editor' }).expect(
        200,
      );
      expect((await getTrip(asha, tripId)).revision).toBe(before);
      expect(await notificationsFor('meera@example.com')).toHaveLength(meeraNotes.length);
    });

    it('removing a member takes effect at once; members may leave; the owner can’t be removed', async () => {
      const { asha, ravi, meera, tripId, raviMemberId, meeraMemberId } = await shared();
      // Members can't remove each other.
      expect((await del(ravi, `/trips/${tripId}/members/${meeraMemberId}`)).status).toBe(403);
      // The owner isn't a member row: there's nothing to remove or demote.
      const ashaId = await userId('asha@example.com');
      expect((await del(asha, `/trips/${tripId}/members/${ashaId}`)).status).toBe(404);

      const removed = await del(asha, `/trips/${tripId}/members/${raviMemberId}`);
      expect(removed.status).toBe(200);
      expect((await ravi.get(api(`/trips/${tripId}`))).status).toBe(404);
      expect(
        (await post(ravi, `/trips/${tripId}/items`, { day: START, title: 'x', category: 'other' }))
          .status,
      ).toBe(404);
      const raviNote = (await notificationsFor('ravi@example.com')).at(-1)!;
      expect(raviNote).toMatchObject({ type: 'PLAN_MEMBER_CHANGED', plannedTripId: null });
      expect(raviNote.message).toContain('removed you');

      const left = await del(meera, `/trips/${tripId}/members/${meeraMemberId}`);
      expect(left.status).toBe(200);
      expect((await meera.get(api(`/trips/${tripId}`))).status).toBe(404);
      expect((await notificationsFor('asha@example.com')).at(-1)!.message).toBe(
        'Meera Iyer left the plan “Goa with friends”.',
      );
      // Notifications about a plan they've lost access to lead nowhere.
      const raviLinks = (await ravi.get('/api/v1/notifications')).body.data.items.map(
        (n: { link: unknown }) => n.link,
      );
      expect(raviLinks.some((l: { kind?: string } | null) => l?.kind === 'plan')).toBe(false);
    });

    it('the database keeps exactly one owner, outside the member list', async () => {
      const { tripId } = await shared();
      const prisma = testPrisma();
      const ashaId = await userId('asha@example.com');
      const raviId = await userId('ravi@example.com');
      await expect(
        prisma.tripMember.create({
          data: { tripId, userId: ashaId, role: 'EDITOR', joinedAt: new Date() },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.tripInvitation.create({
          data: {
            tripId,
            inviteeId: ashaId,
            role: 'EDITOR',
            expiresAt: new Date(Date.now() + DAY_MS),
          },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.plannedTrip.update({ where: { id: tripId }, data: { userId: raviId } }),
      ).rejects.toThrow();
      await expect(
        prisma.tripMember.create({
          data: { tripId, userId: raviId, role: 'VIEWER', joinedAt: new Date() },
        }),
      ).rejects.toThrow(); // already a member: unique
    });

    it('keeps the owner’s linked booking private from members', async () => {
      const { asha, ravi, tripId } = await shared();
      const { serviceType: _t, ...body } = VALID_INPUTS.hotels;
      const search = await asha.post('/api/v1/search/hotels').set('Origin', ORIGIN).send(body);
      const offer = search.body.data.results[0] as SearchResult;
      const created = await asha
        .post('/api/v1/bookings')
        .set('Origin', ORIGIN)
        .set('Idempotency-Key', randomUUID())
        .send({
          serviceType: offer.serviceType,
          searchId: search.body.data.searchId,
          offerId: offer.id,
          travellers: bookingRequirementsFor(offer).namedTravellers.map(() => ({
            firstName: 'Asha',
            lastName: 'Rao',
          })),
          acceptedPrice: offer.price,
          acceptDemoTerms: true,
        });
      let booking = bookingSchema.parse(created.body.data);
      if (booking.payment.canPay) {
        await asha
          .post(`/api/v1/bookings/${booking.reference}/payments`)
          .set('Origin', ORIGIN)
          .set('Idempotency-Key', randomUUID())
          .send({ amount: booking.payment.amount })
          .expect(201);
        booking = bookingSchema.parse(
          (await asha.get(`/api/v1/bookings/${booking.reference}`)).body.data,
        );
      }
      const trip = await getTrip(asha, tripId);
      await patch(asha, `/trips/${tripId}`, {
        version: trip.version,
        bookingReference: booking.reference,
      }).expect(200);
      expect((await getTrip(asha, tripId)).linkedBooking?.reference).toBe(booking.reference);
      const ravis = await getTrip(ravi, tripId);
      expect(ravis.linkedBooking).toBeNull();
      expect(JSON.stringify((await ravi.get(api('/trips'))).body)).not.toContain(booking.reference);
    });
  });

  describe('conflicting edits', () => {
    it('refuses an activity edit based on an older version, instead of overwriting', async () => {
      const { asha, ravi, tripId } = await shared();
      const item = (await getTrip(asha, tripId)).days[0]!.items[0]!;
      const first = await patch(asha, `/trips/${tripId}/items/${item.id}`, {
        version: item.version,
        title: 'Fort at sunrise',
      });
      expect(first.status).toBe(200);
      const stale = await patch(ravi, `/trips/${tripId}/items/${item.id}`, {
        version: item.version,
        title: 'Fort at noon',
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toMatchObject({
        code: 'PLAN_OUT_OF_DATE',
        details: [expect.objectContaining({ path: 'body.version', code: 'stale_version' })],
      });
      expect(stale.body.error.message).toMatch(/Someone else changed this activity/);
      const latest = (await getTrip(ravi, tripId)).days[0]!.items[0]!;
      expect(latest).toMatchObject({ title: 'Fort at sunrise', version: 2 });
      // After loading the latest version, the edit goes through.
      await patch(ravi, `/trips/${tripId}/items/${item.id}`, {
        version: 2,
        title: 'Fort at noon',
      }).expect(200);
    });

    it('two simultaneous edits of the same version: exactly one wins', async () => {
      const { asha, ravi, tripId } = await shared();
      const item = (await getTrip(asha, tripId)).days[0]!.items[0]!;
      const results = await Promise.all([
        patch(asha, `/trips/${tripId}/items/${item.id}`, { version: 1, title: 'A' }),
        patch(ravi, `/trips/${tripId}/items/${item.id}`, { version: 1, title: 'B' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const winner = results.find((r) => r.status === 200)!;
      expect((await getTrip(asha, tripId)).days[0]!.items[0]!.title).toBe(
        winner.body.data.days[0].items[0].title,
      );
    });

    it('refuses trip-detail edits and reorders based on stale data', async () => {
      const { asha, ravi, tripId } = await shared();
      const trip = await getTrip(asha, tripId);
      await post(asha, `/trips/${tripId}/items`, {
        day: START,
        title: 'Beach',
        category: 'beach',
      }).expect(201);
      const [fort, beach] = (await getTrip(asha, tripId)).days[0]!.items;

      await patch(asha, `/trips/${tripId}`, { version: trip.version, title: 'Goa, slowly' }).expect(
        200,
      );
      const staleDetails = await patch(ravi, `/trips/${tripId}`, {
        version: trip.version,
        notes: 'Mine',
      });
      expect(staleDetails.status).toBe(409);
      expect(staleDetails.body.error.details[0].path).toBe('body.version');

      // Asha reorders; Ravi's reorder was based on the old order.
      const order = [fort!.id, beach!.id];
      await put(asha, `/trips/${tripId}/days/${START}/order`, {
        itemIds: [beach!.id, fort!.id],
        previousOrder: order,
      }).expect(200);
      const staleOrder = await put(ravi, `/trips/${tripId}/days/${START}/order`, {
        itemIds: [beach!.id, fort!.id],
        previousOrder: order,
      });
      expect(staleOrder.status).toBe(409);
      expect(staleOrder.body.error.details[0].path).toBe('body.previousOrder');
      // Simultaneous reorders from the same starting order: one applies, the other is refused.
      const now = (await getTrip(asha, tripId)).days[0]!.items.map((i) => i.id);
      const both = await Promise.all([
        put(asha, `/trips/${tripId}/days/${START}/order`, {
          itemIds: [...now].reverse(),
          previousOrder: now,
        }),
        put(ravi, `/trips/${tripId}/days/${START}/order`, {
          itemIds: [...now].reverse(),
          previousOrder: now,
        }),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
      const positions = (await getTrip(asha, tripId)).days[0]!.items.map((i) => i.position);
      expect(positions).toEqual([0, 1]);
    });

    it('a deleted activity can’t be edited by someone who still had it open', async () => {
      const { asha, ravi, tripId } = await shared();
      const item = (await getTrip(asha, tripId)).days[0]!.items[0]!;
      await del(asha, `/trips/${tripId}/items/${item.id}`).expect(200);
      const res = await patch(ravi, `/trips/${tripId}/items/${item.id}`, {
        version: 1,
        title: 'x',
      });
      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/deleted by another member/);
    });
  });

  describe('activity history and notifications', () => {
    it('records who changed what, newest first, paged, for members only, once per change', async () => {
      const { asha, ravi, meera, zoe, tripId } = await shared();
      const key = randomUUID();
      const body = { day: START, title: 'Beach', category: 'beach' };
      await post(ravi, `/trips/${tripId}/items`, body, key).expect(201);
      await post(ravi, `/trips/${tripId}/items`, body, key).expect(201); // retry: replayed
      const trip = await getTrip(asha, tripId);
      await patch(asha, `/trips/${tripId}`, {
        version: trip.version,
        startDate: DAY2,
        endDate: END,
      }).expect(200);

      const page = plannerActivityListSchema.parse(
        (await meera.get(api(`/trips/${tripId}/activity?limit=4`))).body.data,
      );
      expect(page.items.map((e) => e.summary)).toEqual([
        'Asha Rao changed the plan’s dates',
        'Ravi Kumar added “Beach”',
        'You joined the plan as viewer',
        'Asha Rao invited you as viewer',
      ]);
      expect(page.items[0]!.actor).toMatchObject({
        name: 'Asha Rao',
        initials: 'AR',
        isYou: false,
      });
      const older = plannerActivityListSchema.parse(
        (await meera.get(api(`/trips/${tripId}/activity?limit=50&before=${page.nextBefore}`))).body
          .data,
      );
      expect(older.items.map((e) => e.summary)).toEqual([
        'Ravi Kumar joined the plan as editor',
        'Asha Rao invited Ravi Kumar as editor',
        'Asha Rao added “Fort Aguada”',
      ]);
      expect(older.nextBefore).toBeNull();
      const revisions = [...page.items, ...older.items].map((e) => e.revision);
      expect(revisions).toEqual([...revisions].sort((a, b) => b - a));
      expect(new Set(revisions).size).toBe(revisions.length);
      // Ravi sees "You" for his own entries.
      const ravis = plannerActivityListSchema.parse(
        (await ravi.get(api(`/trips/${tripId}/activity`))).body.data,
      );
      expect(ravis.items[1]!.summary).toBe('You added “Beach”');
      expect(JSON.stringify(ravis)).not.toContain('@');
      expect((await zoe.get(api(`/trips/${tripId}/activity`))).status).toBe(404);
      expect((await meera.get(api(`/trips/${tripId}/activity?limit=500`))).status).toBe(400);
      // History can't be rewritten.
      await expect(
        testPrisma().plannerActivity.updateMany({
          where: { tripId },
          data: { data: { title: 'forged' } },
        }),
      ).rejects.toThrow();
    });

    it('notifies others about date or destination changes, once, and not about minor edits', async () => {
      const { asha, ravi, tripId } = await shared();
      await post(ravi, `/trips/${tripId}/items`, {
        day: START,
        title: 'Beach',
        category: 'beach',
      }).expect(201);
      const trip = await getTrip(ravi, tripId);
      await patch(ravi, `/trips/${tripId}`, { version: trip.version, notes: 'Just notes' }).expect(
        200,
      );
      expect(await testPrisma().notification.count({ where: { type: 'PLAN_UPDATED' } })).toBe(0);

      await patch(ravi, `/trips/${tripId}`, {
        version: trip.version + 1,
        startDate: DAY2,
        endDate: END,
      }).expect(200);
      const updates = await testPrisma().notification.findMany({ where: { type: 'PLAN_UPDATED' } });
      const recipients = await Promise.all(
        ['asha@example.com', 'meera@example.com'].map((email) => userId(email)),
      );
      expect(updates.map((n) => n.userId).sort()).toEqual(recipients.sort());
      expect(updates[0]!.message).toBe(
        `Ravi Kumar changed “Goa with friends”: now Goa, ${DAY2} to ${END}.`,
      );
      // The editor who made the change isn't notified.
      expect(
        (await notificationsFor('ravi@example.com')).filter((n) => n.type === 'PLAN_UPDATED'),
      ).toEqual([]);
      const link = (await asha.get('/api/v1/notifications')).body.data.items[0].link;
      expect(link).toEqual({ kind: 'plan', tripId });
    });
  });

  describe('rate limits', () => {
    it('limits invitations per user per hour', async () => {
      const { asha, tripId } = await world({ env: { PLANNER_INVITE_RATE_LIMIT_MAX: 2 } });
      const statuses: number[] = [];
      for (const email of ['ravi@example.com', 'meera@example.com', 'zoe@example.com']) {
        statuses.push(
          (await post(asha, `/trips/${tripId}/invitations`, { email, role: 'viewer' }, null))
            .status,
        );
      }
      expect(statuses).toEqual([201, 201, 429]);
    });
  });

  describe('live updates (Server-Sent Events)', () => {
    let server: Server | undefined;
    let hub: SignalHub | undefined;
    afterEach(async () => {
      await hub?.close();
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      server = undefined;
      hub = undefined;
    });

    async function serve(target: ReturnType<typeof app>) {
      server = target.listen(0);
      await new Promise((r) => server!.once('listening', r));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }
    async function login(base: string, email: string) {
      const res = await fetch(`${base}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ email, password: 'blue river morning' }),
      });
      expect(res.status).toBe(200);
      return res.headers.get('set-cookie')!.split(';')[0]!;
    }
    function reader(res: Response) {
      const r = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      return {
        async until(pattern: RegExp, timeoutMs = 5000): Promise<string> {
          const deadline = Date.now() + timeoutMs;
          while (!pattern.test(text)) {
            const left = deadline - Date.now();
            if (left <= 0) throw new Error(`Timed out waiting for ${pattern}; got: ${text}`);
            const chunk = await Promise.race([
              r.read(),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), left)),
            ]);
            if (!chunk) continue;
            if (chunk.done) break;
            text += decoder.decode(chunk.value);
          }
          return text;
        },
        cancel: () => r.cancel(),
      };
    }

    it('tells members (only) that the plan changed, via PostgreSQL LISTEN/NOTIFY, and ends when access does', async () => {
      hub = new PgSignalHub(TEST_DATABASE_URL!, pino({ level: 'silent' }), {
        channel: PLANNER_EVENTS_CHANNEL,
        keyField: 'tripId',
        component: 'planner-events',
        label: 'plan updates',
      });
      const { target, asha, tripId, raviMemberId } = await shared({ hub });
      const base = await serve(target);
      for (let i = 0; i < 50 && !hub.live; i += 1) await new Promise((r) => setTimeout(r, 50));
      expect(hub.live).toBe(true);

      const ravi = await login(base, 'ravi@example.com');
      const res = await fetch(`${base}${api(`/trips/${tripId}/events`)}`, {
        headers: { Cookie: ravi },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
      const sse = reader(res);
      await sse.until(/event: ready\ndata: \{"live":true\}/);

      // Asha's change (another request, another connection) reaches Ravi's stream.
      const before = (await getTrip(asha, tripId)).revision;
      await post(asha, `/trips/${tripId}/items`, {
        day: START,
        title: 'Beach',
        category: 'beach',
      }).expect(201);
      const text = await sse.until(/event: plan-changed/);
      expect(text).toContain(
        `id: ${before + 1}\nevent: plan-changed\ndata: {"revision":${before + 1},"tripId":"${tripId}"}`,
      );
      expect(text).not.toMatch(/Beach|Asha/);

      // Removed: the next announcement ends his stream instead of reaching him.
      await del(asha, `/trips/${tripId}/members/${raviMemberId}`).expect(200);
      await sse.until(/event: end\ndata: \{"reason":"access-ended"\}/);

      // Strangers and signed-out visitors can't open it.
      const zoe = await login(base, 'zoe@example.com');
      expect(
        (await fetch(`${base}${api(`/trips/${tripId}/events`)}`, { headers: { Cookie: zoe } }))
          .status,
      ).toBe(404);
      expect((await fetch(`${base}${api(`/trips/${tripId}/events`)}`)).status).toBe(401);
    });

    it('a reconnect with Last-Event-ID catches up; repeats are not sent twice', async () => {
      const { target, asha, tripId } = await shared({ stream: { catchUpMs: 100 } });
      const base = await serve(target);
      const meera = await login(base, 'meera@example.com');
      const revision = (await getTrip(asha, tripId)).revision;
      const res = await fetch(`${base}${api(`/trips/${tripId}/events`)}`, {
        headers: { Cookie: meera, 'Last-Event-ID': String(revision - 1) },
      });
      const sse = reader(res);
      const text = await sse.until(/event: ready/);
      expect(text).toContain(`id: ${revision}\nevent: plan-changed`);
      // Periodic catch-ups (every 100 ms here) don't repeat it.
      await new Promise((r) => setTimeout(r, 400));
      const later = await sse.until(/event: ready/);
      expect(later.match(/event: plan-changed/g)).toHaveLength(1);
      await sse.cancel();
    });
  });
});
