import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  adminReviewListSchema,
  adminReviewSchema,
  adminReviewSubjectsSchema,
  bookingRequirementsFor,
  bookingReviewStateSchema,
  bookingSchema,
  notificationListResponseSchema,
  ownReviewListSchema,
  ownReviewSchema,
  reviewListSchema,
  reviewMetricsSchema,
  type AdminReview,
  type Booking,
  type OwnReview,
  type SearchResult,
  type SearchServiceType,
} from '@wayora/contracts';
import type { Env } from '../../src/config/env.js';
import { setUserRole } from '../../src/modules/admin/roles.js';
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
 * Reviews against a real PostgreSQL (Phase 28, docs/reviews.md): submission
 * and eligibility (ownership, completion, demo labelling), duplicates,
 * editing, rating validation, public aggregates and visibility, moderation
 * permissions and lifecycle, reports, helpful votes, pagination and
 * filters, notifications, analytics and the database guards.
 */

const PASSWORD = 'blue river morning';
/** Names take letters only. */
const NAMES = ['Anand', 'Bela', 'Chitra', 'Dev', 'Esha', 'Farah', 'Gopal', 'Hari'];
const DAY = 24 * 3600_000;
type Agent = ReturnType<typeof request.agent>;
type Clock = ReturnType<typeof testClock>;

if (process.env.CI && !TEST_DATABASE_URL) {
  throw new Error('CI is set but TEST_DATABASE_URL is not: the review tests would be skipped.');
}

const BASE_ENV: Partial<Env> = {
  SESSION_IDLE_TIMEOUT_HOURS: 24 * 900,
  SESSION_ABSOLUTE_TIMEOUT_HOURS: 24 * 1000,
  BOOKING_RATE_LIMIT_MAX: 1000,
  PAYMENT_RATE_LIMIT_MAX: 1000,
  REVIEW_RATE_LIMIT_MAX: 1000,
  REVIEW_REPORT_RATE_LIMIT_MAX: 1000,
  REVIEW_VOTE_RATE_LIMIT_MAX: 1000,
  PAYMENT_PROVIDER: 'demo',
};

const app = (clock: Clock, env: Partial<Env> = {}) =>
  buildTestApp({ prisma: testPrisma(), env: { ...BASE_ENV, ...env }, now: clock.now });

let counter = 0;
async function register(target: Parameters<typeof request.agent>[0], name = 'Asha Rao') {
  const email = `r${(counter += 1)}-${randomUUID().slice(0, 6)}@example.com`;
  const agent = request.agent(target);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('Origin', ORIGIN)
    .send({ name, email, password: PASSWORD });
  expect(res.status).toBe(201);
  const user = await testPrisma().user.findUniqueOrThrow({ where: { email } });
  return { agent, userId: user.id, email };
}
async function staff(
  target: Parameters<typeof request.agent>[0],
  role: 'admin' | 'support',
  name: string,
) {
  const s = await register(target, name);
  await setUserRole(testPrisma(), { email: s.email, role, reason: 'Test setup', actor: 'test' });
  return s;
}

async function book(agent: Agent, type: SearchServiceType = 'hotels'): Promise<Booking> {
  const { serviceType: _t, ...body } = VALID_INPUTS[type];
  const s = await agent.post(`/api/v1/search/${type}`).set('Origin', ORIGIN).send(body);
  expect(s.status).toBe(200);
  const offer = (s.body.data.results as SearchResult[])[0]!;
  const requirements = bookingRequirementsFor(offer);
  const res = await agent
    .post('/api/v1/bookings')
    .set('Origin', ORIGIN)
    .set('Idempotency-Key', randomUUID())
    .send({
      serviceType: offer.serviceType,
      searchId: s.body.data.searchId,
      offerId: offer.id,
      travellers: requirements.namedTravellers.map(() => ({ firstName: 'Asha', lastName: 'Rao' })),
      ...(requirements.contactPhone === 'required' ? { contactPhone: '+919876543210' } : {}),
      acceptedPrice: offer.price,
      acceptDemoTerms: true,
    });
  expect(res.status).toBe(201);
  return bookingSchema.parse(res.body.data);
}

/** Books and pays (demo), so the booking is confirmed. */
async function paidStay(agent: Agent, type: SearchServiceType = 'hotels'): Promise<Booking> {
  const b = await book(agent, type);
  const res = await agent
    .post(`/api/v1/bookings/${b.reference}/payments`)
    .set('Origin', ORIGIN)
    .set('Idempotency-Key', randomUUID())
    .send({ amount: b.payment.amount, demoScenario: 'succeed' });
  expect(res.status).toBe(201);
  const after = bookingSchema.parse((await agent.get(`/api/v1/bookings/${b.reference}`)).body.data);
  expect(after.status).toBe('confirmed');
  return after;
}

const content = (over: Record<string, unknown> = {}) => ({
  rating: 4,
  aspects: { cleanliness: 5, value: 3 },
  title: 'Quiet and close to the beach',
  body: 'Clean rooms, friendly staff and a short walk to the sand. Breakfast was simple but fine.',
  ...over,
});

const postReview = (agent: Agent, body: Record<string, unknown>) =>
  agent.post('/api/v1/reviews').set('Origin', ORIGIN).send(body);
const bookingReview = (agent: Agent, reference: string, over: Record<string, unknown> = {}) =>
  postReview(agent, { kind: 'booking', bookingReference: reference, ...content(over) });
const destinationReview = (agent: Agent, destination: string, over: Record<string, unknown> = {}) =>
  postReview(agent, {
    kind: 'destination',
    destination,
    ...content({ aspects: {}, ...over }),
  });

const moderate = (agent: Agent, id: string, body: Record<string, unknown>) =>
  agent.post(`/api/v1/admin/reviews/${id}/moderate`).set('Origin', ORIGIN).send(body);
const adminGet = async (agent: Agent, id: string): Promise<AdminReview> => {
  const res = await agent.get(`/api/v1/admin/reviews/${id}`);
  expect(res.status).toBe(200);
  return adminReviewSchema.parse(res.body.data);
};
async function publish(admin: Agent, id: string) {
  const r = await adminGet(admin, id);
  const res = await moderate(admin, id, { action: 'publish', revision: r.revision });
  expect(res.status).toBe(200);
  return adminReviewSchema.parse(res.body.data);
}
const listFor = async (agent: Agent, type: string, key: string, query = '') => {
  const res = await agent.get(
    `/api/v1/reviews?type=${type}&key=${encodeURIComponent(key)}${query}`,
  );
  expect(res.status).toBe(200);
  return reviewListSchema.parse(res.body.data);
};

beforeEach(async () => {
  if (!TEST_DATABASE_URL) return;
  await resetAccounts();
});
afterAll(async () => {
  await disconnect();
});

describe.skipIf(!TEST_DATABASE_URL)('reviews (PostgreSQL)', () => {
  describe('booking reviews: eligibility, ownership and submission', () => {
    it('reviews a completed stay as a demo booking (never verified), from the booking’s own property', async () => {
      const clock = testClock();
      const target = app(clock);
      const { agent, userId } = await register(target);
      const stay = await paidStay(agent);

      // Before checkout: not yet, with the day it opens.
      const early = bookingReviewStateSchema.parse(
        (await agent.get(`/api/v1/reviews/bookings/${stay.reference}`)).body.data,
      );
      expect(early.state).toBe('not_yet');
      expect(early.eligibleFrom).not.toBeNull();
      const refused = await bookingReview(agent, stay.reference);
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe('REVIEW_NOT_ELIGIBLE');

      clock.advance(25 * DAY);
      const state = bookingReviewStateSchema.parse(
        (await agent.get(`/api/v1/reviews/bookings/${stay.reference}`)).body.data,
      );
      expect(state).toMatchObject({ state: 'eligible', verification: 'demo_booking' });
      expect(state.subject?.type).toBe('hotel');
      expect(state.subject?.key).toMatch(/^demo-hotels:[a-z0-9-]+$/);

      // The client can't name the subject, the verification or the status.
      for (const extra of [
        { verification: 'verified_booking' },
        { status: 'published' },
        { subject: { type: 'hotel', key: 'demo-hotels:other' } },
        { userId: randomUUID() },
      ]) {
        const res = await bookingReview(agent, stay.reference, extra);
        expect(res.status, JSON.stringify(extra)).toBe(400);
      }

      const res = await bookingReview(agent, stay.reference);
      expect(res.status).toBe(201);
      const review = ownReviewSchema.parse(res.body.data);
      expect(review).toMatchObject({
        status: 'pending',
        verification: 'demo_booking',
        rating: 4,
        aspects: { cleanliness: 5, value: 3 },
        bookingReference: stay.reference,
        subject: state.subject,
        revision: 1,
        edited: false,
      });
      expect(review.travelled?.from).toBe(stay.startsOn);
      expect(review.editableUntil).not.toBeNull();
      const row = await testPrisma().review.findUniqueOrThrow({ where: { id: review.id } });
      expect(row).toMatchObject({ userId, verification: 'DEMO_BOOKING', status: 'PENDING' });
      expect(await testPrisma().reviewRevision.count({ where: { reviewId: review.id } })).toBe(1);
      expect(
        await testPrisma().auditLog.count({
          where: { action: 'review.submitted', entityId: review.id },
        }),
      ).toBe(1);

      // The booking is untouched; its state now says "reviewed".
      const reviewed = bookingReviewStateSchema.parse(
        (await agent.get(`/api/v1/reviews/bookings/${stay.reference}`)).body.data,
      );
      expect(reviewed).toMatchObject({ state: 'reviewed', reviewId: review.id });
      const after = bookingSchema.parse(
        (await agent.get(`/api/v1/bookings/${stay.reference}`)).body.data,
      );
      expect(after.status).toBe('confirmed');
    });

    it('refuses other people’s bookings, unfinished, unpaid and cancelled ones, and unsupported categories', async () => {
      const clock = testClock();
      const target = app(clock);
      const owner = await register(target);
      const other = await register(target, 'Ravi Kumar');
      const stay = await paidStay(owner.agent);
      const unpaid = await book(owner.agent);
      const toCancel = await paidStay(owner.agent);
      const cancel = await owner.agent
        .post(`/api/v1/bookings/${toCancel.reference}/cancel`)
        .set('Origin', ORIGIN)
        .set('Idempotency-Key', randomUUID())
        .send();
      expect(cancel.status).toBe(200);
      const flight = await paidStay(owner.agent, 'flights');
      clock.advance(40 * DAY);

      // Someone else's booking looks exactly like a missing one.
      const foreign = await bookingReview(other.agent, stay.reference);
      expect(foreign.status).toBe(404);
      expect((await other.agent.get(`/api/v1/reviews/bookings/${stay.reference}`)).status).toBe(
        404,
      );

      for (const [b, message] of [
        [unpaid, /completed, confirmed/],
        [toCancel, /Cancelled bookings/],
        [flight, /hotel stays and holiday packages/],
      ] as const) {
        const res = await bookingReview(owner.agent, b.reference, { aspects: {} });
        expect(res.status, b.reference).toBe(422);
        expect(res.body.error.code).toBe('REVIEW_NOT_ELIGIBLE');
        expect(res.body.error.message).toMatch(message);
      }

      // Unauthenticated writes need a session.
      const anonymous = await request(target)
        .post('/api/v1/reviews')
        .set('Origin', ORIGIN)
        .send({ kind: 'booking', bookingReference: stay.reference, ...content() });
      expect(anonymous.status).toBe(401);
      expect(await testPrisma().review.count()).toBe(0);
    });

    it('allows one review per booking, even when submitted twice at once', async () => {
      const clock = testClock();
      const target = app(clock);
      const { agent } = await register(target);
      const stay = await paidStay(agent);
      clock.advance(25 * DAY);
      const [a, b] = await Promise.all([
        bookingReview(agent, stay.reference),
        bookingReview(agent, stay.reference),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const again = await bookingReview(agent, stay.reference);
      expect(again.status).toBe(409);
      expect(again.body.error.message).toMatch(/already reviewed/);
      expect(await testPrisma().review.count()).toBe(1);
    });

    it('validates ratings and category ratings on the server', async () => {
      const clock = testClock();
      const target = app(clock);
      const { agent } = await register(target);
      const stay = await paidStay(agent);
      clock.advance(25 * DAY);
      for (const over of [
        { rating: 0 },
        { rating: 6 },
        { rating: 4.5 },
        { rating: '5' },
        { aspects: { cleanliness: 7 } },
        { aspects: { experience: 4 } }, // a package aspect on a hotel
        { title: 'Ok' },
        { body: 'Too short.' },
        { body: 'x'.repeat(3001) },
        { title: 'Two\nlines here' },
        { body: `Contains a control character \u0007 that is refused by the server.` },
      ]) {
        const res = await bookingReview(agent, stay.reference, over);
        expect(res.status, JSON.stringify(over).slice(0, 60)).toBe(400);
      }
      const destination = await destinationReview(agent, 'goa', { aspects: { location: 4 } });
      expect(destination.status).toBe(400);
      expect(await testPrisma().review.count()).toBe(0);
    });
  });

  describe('destination feedback', () => {
    it('is unverified, one per customer per destination, for known destinations only', async () => {
      const clock = testClock(Date.parse('2026-11-07T06:00:00Z'));
      const target = app(clock);
      const { agent } = await register(target);
      const res = await destinationReview(agent, 'goa', { visitedMonth: '2026-03' });
      expect(res.status).toBe(201);
      const review = ownReviewSchema.parse(res.body.data);
      expect(review).toMatchObject({
        verification: 'unverified',
        subject: { type: 'destination', key: 'goa' },
        subjectName: 'Goa',
        visitedMonth: '2026-03',
        bookingReference: null,
        travelled: null,
      });
      expect((await destinationReview(agent, 'goa')).status).toBe(409);
      expect((await destinationReview(agent, 'atlantis')).status).toBe(404);
      expect((await destinationReview(agent, 'kyoto', { visitedMonth: '2027-01' })).status).toBe(
        400,
      );
      const state = (await agent.get('/api/v1/reviews/destinations/goa')).body.data;
      expect(state).toEqual({ destination: 'goa', name: 'Goa', reviewId: review.id });
    });
  });

  describe('editing', () => {
    it('edits go back to moderation, keep every version, and follow the window and ownership rules', async () => {
      const clock = testClock();
      const target = app(clock);
      const author = await register(target);
      const other = await register(target, 'Ravi Kumar');
      const admin = await staff(target, 'admin', 'Meera Admin');
      const created = ownReviewSchema.parse(
        (await destinationReview(author.agent, 'jaipur')).body.data,
      );
      await publish(admin.agent, created.id);
      const published = ownReviewSchema.parse(
        (await author.agent.get(`/api/v1/reviews/mine/${created.id}`)).body.data,
      );
      expect(published.status).toBe('published');

      const patch = (agent: Agent, over: Record<string, unknown>) =>
        agent
          .patch(`/api/v1/reviews/${created.id}`)
          .set('Origin', ORIGIN)
          .send({ ...content({ aspects: {} }), ...over });

      expect((await patch(other.agent, { revision: published.revision })).status).toBe(404);
      expect((await patch(author.agent, { revision: 1 })).status).toBe(409); // stale
      const edited = await patch(author.agent, {
        revision: published.revision,
        rating: 2,
        title: 'Busy but beautiful old city',
      });
      expect(edited.status).toBe(200);
      const after = ownReviewSchema.parse(edited.body.data);
      expect(after).toMatchObject({ status: 'pending', rating: 2, edited: true });
      // Hidden until moderated again; both versions are kept.
      expect((await listFor(author.agent, 'destination', 'jaipur')).summary.count).toBe(0);
      expect(await testPrisma().reviewRevision.count({ where: { reviewId: created.id } })).toBe(2);
      const history = await adminGet(admin.agent, created.id);
      expect(history.revisions.map((r) => r.rating)).toEqual([4, 2]);
      expect(history.history.map((h) => h.event)).toEqual(['submitted', 'moderated', 'edited']);

      // After the window: no more edits.
      clock.advance(31 * DAY);
      const late = await patch(author.agent, { revision: after.revision });
      expect(late.status).toBe(409);
      expect(late.body.error.message).toMatch(/30 days/);
    });
  });

  describe('public reviews and ratings', () => {
    it('counts published reviews only, shows an average from three, and hides authors’ details', async () => {
      const clock = testClock();
      const target = app(clock);
      const admin = await staff(target, 'admin', 'Meera Admin');
      const writers = await Promise.all(
        ['Asha Rao', 'Ravi Kumar', 'Lena', 'Kabir Singh', 'Noor Ali'].map((n) =>
          register(target, n),
        ),
      );
      const ratings = [5, 4, 2, 1, 3];
      const ids: string[] = [];
      for (const [i, w] of writers.entries()) {
        const res = await destinationReview(w.agent, 'kerala', {
          rating: ratings[i],
          title: `Visit number ${i + 1} to Kerala`,
        });
        ids.push(ownReviewSchema.parse(res.body.data).id);
      }
      const anonymous = request(target);

      // Nothing published yet: nothing counted, nothing listed.
      let list = await listFor(anonymous as unknown as Agent, 'destination', 'kerala');
      expect(list.summary).toMatchObject({
        count: 0,
        average: null,
        distribution: [0, 0, 0, 0, 0],
      });
      expect(list.items).toHaveLength(0);

      await publish(admin.agent, ids[0]!);
      await publish(admin.agent, ids[1]!);
      list = await listFor(anonymous as unknown as Agent, 'destination', 'kerala');
      // Two reviews: counts and distribution, no average yet.
      expect(list.summary).toMatchObject({
        count: 2,
        average: null,
        distribution: [0, 0, 0, 1, 1],
      });

      await publish(admin.agent, ids[2]!);
      const reject = await adminGet(admin.agent, ids[3]!);
      expect(
        (
          await moderate(admin.agent, ids[3]!, {
            action: 'reject',
            reason: 'Not about the destination',
            revision: reject.revision,
          })
        ).status,
      ).toBe(200);
      list = await listFor(anonymous as unknown as Agent, 'destination', 'kerala');
      // (5 + 4 + 2) / 3 = 3.67 → 3.7; the rejected and pending reviews don't count.
      expect(list.summary).toMatchObject({
        count: 3,
        average: 3.7,
        distribution: [0, 1, 0, 1, 1],
        byVerification: { unverified: 3, demo_booking: 0, verified_booking: 0 },
        minimumForAverage: 3,
      });

      // Removing one recalculates at once.
      await moderate(admin.agent, ids[2]!, {
        action: 'remove',
        reason: 'Shares a phone number',
        revision: (await adminGet(admin.agent, ids[2]!)).revision,
      });
      list = await listFor(anonymous as unknown as Agent, 'destination', 'kerala');
      expect(list.summary).toMatchObject({ count: 2, average: null });

      const text = JSON.stringify(list);
      for (const w of writers) {
        expect(text).not.toContain(w.userId);
        expect(text).not.toContain(w.email);
      }
      expect(list.items.map((i) => i.author).sort()).toEqual(['Asha R.', 'Ravi K.']);
      expect(list.items.every((i) => i.viewer === null)).toBe(true);
    });

    it('sorts, filters by rating and pages on the server', async () => {
      const clock = testClock();
      const target = app(clock);
      const admin = await staff(target, 'admin', 'Meera Admin');
      const ratings = [3, 5, 1, 4, 5];
      for (const [i, r] of ratings.entries()) {
        const w = await register(target, `Writer ${NAMES[i]}`);
        const res = await destinationReview(w.agent, 'manali', {
          rating: r,
          title: `Rated ${r} stars, writer ${i}`,
        });
        clock.advance(60_000);
        await publish(admin.agent, ownReviewSchema.parse(res.body.data).id);
      }
      const anon = request(target) as unknown as Agent;
      const recent = await listFor(anon, 'destination', 'manali', '&pageSize=2');
      expect(recent.pagination).toMatchObject({
        page: 1,
        pageSize: 2,
        totalResults: 5,
        totalPages: 3,
      });
      expect(recent.items.map((i) => i.title)).toEqual([
        'Rated 5 stars, writer 4',
        'Rated 4 stars, writer 3',
      ]);
      const page3 = await listFor(anon, 'destination', 'manali', '&pageSize=2&page=3');
      expect(page3.items.map((i) => i.rating)).toEqual([3]);
      expect(
        (await listFor(anon, 'destination', 'manali', '&sort=highest')).items.map((i) => i.rating),
      ).toEqual([5, 5, 4, 3, 1]);
      expect(
        (await listFor(anon, 'destination', 'manali', '&sort=lowest')).items.map((i) => i.rating),
      ).toEqual([1, 3, 4, 5, 5]);
      const fives = await listFor(anon, 'destination', 'manali', '&rating=5');
      expect(fives.items.map((i) => i.rating)).toEqual([5, 5]);
      // The summary always describes all counted reviews, whatever the filter.
      expect(fives.summary.count).toBe(5);
      expect((await anon.get('/api/v1/reviews?type=destination&key=manali&rating=6')).status).toBe(
        400,
      );
      expect((await anon.get('/api/v1/reviews?type=destination&key=nowhere')).status).toBe(404);
      expect((await anon.get('/api/v1/reviews?type=flight&key=x')).status).toBe(400);
    });
  });

  describe('helpful votes', () => {
    it('one vote per customer, never on your own or unpublished reviews, counted from votes', async () => {
      const clock = testClock();
      const target = app(clock);
      const admin = await staff(target, 'admin', 'Meera Admin');
      const author = await register(target);
      const voter = await register(target, 'Ravi Kumar');
      const voter2 = await register(target, 'Lena Fox');
      const review = ownReviewSchema.parse(
        (await destinationReview(author.agent, 'bali')).body.data,
      );
      const vote = (agent: Agent, method: 'put' | 'delete' = 'put') =>
        agent[method](`/api/v1/reviews/${review.id}/helpful`).set('Origin', ORIGIN);

      expect((await vote(voter.agent)).status).toBe(404); // not published yet
      await publish(admin.agent, review.id);
      expect((await vote(author.agent)).status).toBe(403);
      expect((await vote(voter.agent)).body.data).toEqual({ helpful: 1, votedHelpful: true });
      expect((await vote(voter.agent)).body.data).toEqual({ helpful: 1, votedHelpful: true }); // no double vote
      expect((await vote(voter2.agent)).body.data).toEqual({ helpful: 2, votedHelpful: true });
      // A client-sent count is refused, not used.
      expect(
        (
          await voter.agent
            .put(`/api/v1/reviews/${review.id}/helpful?count=99`)
            .set('Origin', ORIGIN)
        ).status,
      ).toBe(400);
      expect((await vote(voter2.agent, 'delete')).body.data).toEqual({
        helpful: 1,
        votedHelpful: false,
      });

      const list = await listFor(voter.agent, 'destination', 'bali', '&sort=helpful');
      expect(list.items[0]).toMatchObject({
        helpful: 1,
        viewer: { own: false, votedHelpful: true, reported: false },
      });
      const own = await listFor(author.agent, 'destination', 'bali');
      expect(own.items[0]!.viewer).toMatchObject({ own: true });
      expect(await testPrisma().reviewVote.count()).toBe(1);
    });

    it('rate-limits votes per customer', async () => {
      const clock = testClock();
      const target = app(clock, { REVIEW_VOTE_RATE_LIMIT_MAX: 2 });
      const admin = await staff(target, 'admin', 'Meera Admin');
      const author = await register(target);
      const voter = await register(target, 'Ravi Kumar');
      const review = ownReviewSchema.parse(
        (await destinationReview(author.agent, 'delhi')).body.data,
      );
      await publish(admin.agent, review.id);
      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        statuses.push(
          (await voter.agent.put(`/api/v1/reviews/${review.id}/helpful`).set('Origin', ORIGIN))
            .status,
        );
      }
      expect(statuses).toEqual([200, 200, 429]);
    });
  });

  describe('reports', () => {
    it('one report per customer, private, never changing the review by itself; staff can dismiss them', async () => {
      const clock = testClock();
      const target = app(clock);
      const admin = await staff(target, 'admin', 'Meera Admin');
      const author = await register(target);
      const reporters = await Promise.all(
        [1, 2, 3].map((i) => register(target, `Reporter ${NAMES[i]}`)),
      );
      const review = ownReviewSchema.parse(
        (await destinationReview(author.agent, 'mumbai')).body.data,
      );
      const report = (agent: Agent, body: Record<string, unknown>) =>
        agent.post(`/api/v1/reviews/${review.id}/reports`).set('Origin', ORIGIN).send(body);

      expect((await report(reporters[0]!.agent, { reason: 'spam' })).status).toBe(404); // not public
      await publish(admin.agent, review.id);
      expect((await report(author.agent, { reason: 'spam' })).status).toBe(403);
      expect((await report(reporters[0]!.agent, { reason: 'bogus' })).status).toBe(400);
      expect((await report(reporters[0]!.agent, { reason: 'other' })).status).toBe(400); // needs details
      expect((await report(reporters[0]!.agent, { reason: 'spam' })).status).toBe(201);
      const dup = await report(reporters[0]!.agent, { reason: 'offensive' });
      expect(dup.status).toBe(409);
      expect(dup.body.error.message).toMatch(/already reported/);
      for (const r of reporters.slice(1)) {
        expect(
          (await report(r.agent, { reason: 'fake_experience', details: 'Reads like an advert.' }))
            .status,
        ).toBe(201);
      }

      // Three reports don't hide or remove it.
      const list = await listFor(reporters[1]!.agent, 'destination', 'mumbai');
      expect(list.summary.count).toBe(1);
      expect(list.items[0]!.viewer?.reported).toBe(true);
      expect(JSON.stringify(list)).not.toContain(reporters[1]!.userId);

      // Staff see the reports, never who sent them.
      const queue = adminReviewListSchema.parse(
        (await admin.agent.get('/api/v1/admin/reviews?reported=true')).body.data,
      );
      expect(queue.items.map((i) => [i.id, i.openReports])).toEqual([[review.id, 3]]);
      const detail = await adminGet(admin.agent, review.id);
      expect(detail.reports.map((r) => r.reason).sort()).toEqual([
        'fake_experience',
        'fake_experience',
        'spam',
      ]);
      const detailText = JSON.stringify(detail);
      for (const r of reporters) {
        expect(detailText).not.toContain(r.userId);
        expect(detailText).not.toContain(r.email);
      }

      const dismiss = await admin.agent
        .post(`/api/v1/admin/reviews/${review.id}/reports/dismiss`)
        .set('Origin', ORIGIN)
        .send({ reason: 'Genuine experience, no policy issue', revision: detail.revision });
      expect(dismiss.status).toBe(200);
      const after = adminReviewSchema.parse(dismiss.body.data);
      expect(after.status).toBe('published');
      expect(after.openReports).toBe(0);
      expect(after.reports.every((r) => r.status === 'dismissed')).toBe(true);
      expect(after.history.at(-1)).toMatchObject({ event: 'reports_dismissed' });
    });

    it('rate-limits reports per customer', async () => {
      const clock = testClock();
      const target = app(clock, { REVIEW_REPORT_RATE_LIMIT_MAX: 1 });
      const admin = await staff(target, 'admin', 'Meera Admin');
      const reporter = await register(target, 'Ravi Kumar');
      const ids: string[] = [];
      for (const slug of ['goa', 'jaipur']) {
        const w = await register(target, `Writer ${NAMES[slug.length]}`);
        const r = ownReviewSchema.parse((await destinationReview(w.agent, slug)).body.data);
        await publish(admin.agent, r.id);
        ids.push(r.id);
      }
      const statuses = [];
      for (const id of ids) {
        statuses.push(
          (
            await reporter.agent
              .post(`/api/v1/reviews/${id}/reports`)
              .set('Origin', ORIGIN)
              .send({ reason: 'spam' })
          ).status,
        );
      }
      expect(statuses).toEqual([201, 429]);
    });
  });

  describe('moderation', () => {
    it('enforces permissions: customers none, support publish/reject/flag, only admins remove, nobody their own', async () => {
      const clock = testClock();
      const target = app(clock);
      const customer = await register(target);
      const support = await staff(target, 'support', 'Ravi Support');
      const admin = await staff(target, 'admin', 'Meera Admin');
      const review = ownReviewSchema.parse(
        (await destinationReview(customer.agent, 'hyderabad')).body.data,
      );

      for (const [method, path] of [
        ['get', '/api/v1/admin/reviews'],
        ['get', `/api/v1/admin/reviews/${review.id}`],
        ['get', '/api/v1/admin/reviews/metrics'],
        ['post', `/api/v1/admin/reviews/${review.id}/moderate`],
      ] as const) {
        const res = await customer.agent[method](path)
          .set('Origin', ORIGIN)
          .send({ action: 'publish', revision: 1 });
        expect(res.status, path).toBe(403);
      }
      expect(
        await testPrisma().review.findUniqueOrThrow({ where: { id: review.id } }),
      ).toMatchObject({ status: 'PENDING' });

      // Support: no remove action offered, and refused on the server.
      const seen = await adminGet(support.agent, review.id);
      expect(seen.allowed.actions).toEqual(['publish', 'reject', 'flag']);
      const remove = await moderate(support.agent, review.id, {
        action: 'remove',
        reason: 'Policy breach here',
        revision: seen.revision,
      });
      expect(remove.status).toBe(403);
      // A reason is required for anything but publishing.
      expect(
        (await moderate(support.agent, review.id, { action: 'reject', revision: seen.revision }))
          .status,
      ).toBe(400);
      const flagged = await moderate(support.agent, review.id, {
        action: 'flag',
        reason: 'Check the claims',
        revision: seen.revision,
      });
      expect(flagged.status).toBe(200);
      expect(adminReviewSchema.parse(flagged.body.data).status).toBe('flagged');
      // Invalid transition and stale revision.
      const now = await adminGet(admin.agent, review.id);
      expect(
        (
          await moderate(admin.agent, review.id, {
            action: 'flag',
            reason: 'Again please',
            revision: now.revision,
          })
        ).status,
      ).toBe(409);
      expect(
        (await moderate(admin.agent, review.id, { action: 'publish', revision: 1 })).status,
      ).toBe(409);
      const removed = await moderate(admin.agent, review.id, {
        action: 'remove',
        reason: 'Contains a phone number',
        revision: now.revision,
      });
      expect(removed.status).toBe(200);
      const final = adminReviewSchema.parse(removed.body.data);
      expect(final.status).toBe('removed');
      expect(final.allowed.actions).toEqual([]);
      expect(
        await testPrisma().auditLog.count({
          where: { action: 'review.moderated', entityId: review.id },
        }),
      ).toBe(2);
      expect(
        await testPrisma().auditLog.count({
          where: { action: 'admin.access_denied', actorId: customer.userId },
        }),
      ).toBeGreaterThan(0);

      // Staff can't moderate their own reviews.
      const ownReview = ownReviewSchema.parse(
        (await destinationReview(admin.agent, 'singapore')).body.data,
      );
      const own = await adminGet(admin.agent, ownReview.id);
      expect(own.allowed).toMatchObject({ actions: [], ownReview: true });
      expect(
        (await moderate(admin.agent, ownReview.id, { action: 'publish', revision: own.revision }))
          .status,
      ).toBe(403);
    });

    it('publishing and rejecting notify the author once, with the reason, and keep the history', async () => {
      const clock = testClock();
      const target = app(clock);
      const author = await register(target);
      const admin = await staff(target, 'admin', 'Meera Admin');
      const review = ownReviewSchema.parse(
        (await destinationReview(author.agent, 'dubai')).body.data,
      );
      const first = await adminGet(admin.agent, review.id);
      const rejected = await moderate(admin.agent, review.id, {
        action: 'reject',
        reason: 'Mentions another customer by name',
        revision: first.revision,
      });
      expect(rejected.status).toBe(200);
      // Replaying the same request is refused as stale: no second decision or notification.
      expect(
        (
          await moderate(admin.agent, review.id, {
            action: 'reject',
            reason: 'Mentions another customer by name',
            revision: first.revision,
          })
        ).status,
      ).toBe(409);

      const mine = ownReviewListSchema.parse(
        (await author.agent.get('/api/v1/reviews/mine')).body.data,
      );
      expect(mine.items[0]).toMatchObject({
        status: 'rejected',
        moderationNote: 'Mentions another customer by name',
      });
      const notes = notificationListResponseSchema.parse(
        (await author.agent.get('/api/v1/notifications')).body.data,
      );
      const reviewNotes = notes.items.filter((n) => n.type === 'review');
      expect(reviewNotes).toHaveLength(1);
      expect(reviewNotes[0]).toMatchObject({
        title: 'Your review wasn’t published',
        category: 'reviews',
        link: { kind: 'my-reviews' },
      });
      expect(reviewNotes[0]!.message).toContain('Mentions another customer by name');

      // The author edits; it goes back to pending; staff publish it.
      const edited = await author.agent
        .patch(`/api/v1/reviews/${review.id}`)
        .set('Origin', ORIGIN)
        .send({
          ...content({ aspects: {} }),
          title: 'Glittering, hot, very organised',
          revision: mine.items[0]!.revision,
        });
      expect(edited.status).toBe(200);
      await publish(admin.agent, review.id);
      const all = notificationListResponseSchema.parse(
        (await author.agent.get('/api/v1/notifications')).body.data,
      );
      expect(all.items.filter((n) => n.type === 'review').map((n) => n.title)).toEqual([
        'Your review is published',
        'Your review wasn’t published',
      ]);
      // Database de-duplication: the same key can't notify twice.
      const keys = await testPrisma().notification.findMany({
        where: { type: 'REVIEW' },
        select: { dedupeKey: true },
      });
      expect(new Set(keys.map((k) => k.dedupeKey)).size).toBe(keys.length);

      const detail = await adminGet(admin.agent, review.id);
      expect(detail.history.map((h) => [h.event, h.from, h.to])).toEqual([
        ['submitted', null, 'pending'],
        ['moderated', 'pending', 'rejected'],
        ['edited', 'rejected', 'pending'],
        ['moderated', 'pending', 'published'],
      ]);
      expect(detail.history[1]!.actor).toEqual({ kind: 'staff', name: 'Meera Admin' });
    });

    it('lists the queue with server-side filters and pagination', async () => {
      const clock = testClock();
      const target = app(clock);
      const admin = await staff(target, 'admin', 'Meera Admin');
      for (const [i, slug] of ['goa', 'jaipur', 'kerala', 'kyoto'].entries()) {
        const w = await register(target, `Writer ${NAMES[i]}`);
        await destinationReview(w.agent, slug, { rating: i + 1, title: `About ${slug} in detail` });
        clock.advance(60_000);
      }
      const page = adminReviewListSchema.parse(
        (await admin.agent.get('/api/v1/admin/reviews?status=pending&pageSize=3')).body.data,
      );
      expect(page.pagination).toMatchObject({ totalResults: 4, totalPages: 2 });
      expect(page.items.map((i) => i.subject.key)).toEqual(['goa', 'jaipur', 'kerala']); // oldest first
      const kyoto = adminReviewListSchema.parse(
        (await admin.agent.get('/api/v1/admin/reviews?q=Kyoto')).body.data,
      );
      expect(kyoto.items.map((i) => i.subject.key)).toEqual(['kyoto']);
      const ones = adminReviewListSchema.parse(
        (await admin.agent.get('/api/v1/admin/reviews?rating=1')).body.data,
      );
      expect(ones.items.map((i) => i.rating)).toEqual([1]);
      expect((await admin.agent.get('/api/v1/admin/reviews?status=bogus')).status).toBe(400);
    });
  });

  describe('analytics', () => {
    it('reports counts, distribution, submissions and moderator workload from stored records', async () => {
      const clock = testClock(Date.parse('2026-11-07T06:00:00Z'));
      const target = app(clock);
      const admin = await staff(target, 'admin', 'Meera Admin');
      const support = await staff(target, 'support', 'Ravi Support');
      const ids: string[] = [];
      for (const [i, slug] of ['goa', 'jaipur', 'kerala'].entries()) {
        const w = await register(target, `Writer ${NAMES[i]}`);
        ids.push(
          ownReviewSchema.parse(
            (await destinationReview(w.agent, slug, { rating: 5 - i })).body.data,
          ).id,
        );
      }
      await publish(admin.agent, ids[0]!);
      await publish(support.agent, ids[1]!);
      const s = await adminGet(support.agent, ids[2]!);
      await moderate(support.agent, ids[2]!, {
        action: 'flag',
        reason: 'Needs a second look',
        revision: s.revision,
      });
      clock.advance(3 * DAY);

      const metrics = reviewMetricsSchema.parse(
        (await support.agent.get('/api/v1/admin/reviews/metrics?range=7d')).body.data,
      );
      expect(metrics.byStatus).toEqual({
        pending: 0,
        published: 2,
        rejected: 0,
        flagged: 1,
        removed: 0,
      });
      expect(metrics.publishedByVerification).toEqual({
        verified_booking: 0,
        demo_booking: 0,
        unverified: 2,
      });
      expect(metrics.distribution).toEqual([0, 0, 0, 1, 1]);
      expect(metrics.submissions).toEqual([{ day: '2026-11-07', count: 3 }]);
      expect(metrics.moderators).toEqual([
        { name: 'Ravi Support', decisions: 2, published: 1 },
        { name: 'Meera Admin', decisions: 1, published: 1 },
      ]);
      expect(metrics.pending).toEqual({ count: 0, oldestAt: null, olderThan48h: 0 });

      const subjects = adminReviewSubjectsSchema.parse(
        (await admin.agent.get('/api/v1/admin/reviews/subjects')).body.data,
      );
      expect(subjects.pagination.totalResults).toBe(3);
      expect(subjects.items[0]).toMatchObject({ published: 1, average: null, pending: 0 });
      expect(subjects.items.find((i) => i.subject.key === 'kerala')).toMatchObject({
        published: 0,
        flagged: 1,
      });
    });
  });

  describe('database guards', () => {
    it('keeps reviews, their facts and history: no deletes, no changing who or what, removal is final', async () => {
      const clock = testClock();
      const target = app(clock);
      const author = await register(target);
      const review = ownReviewSchema.parse(
        (await destinationReview(author.agent, 'goa')).body.data,
      );
      const db = testPrisma();
      await expect(db.review.delete({ where: { id: review.id } })).rejects.toThrow(
        /DELETE blocked/,
      );
      await expect(
        db.review.update({ where: { id: review.id }, data: { verification: 'VERIFIED_BOOKING' } }),
      ).rejects.toThrow();
      await expect(
        db.review.update({ where: { id: review.id }, data: { subjectKey: 'jaipur' } }),
      ).rejects.toThrow(/immutable/);
      await expect(db.reviewEvent.deleteMany({ where: { reviewId: review.id } })).rejects.toThrow(
        /append-only/,
      );
      await expect(
        db.review.update({ where: { id: review.id }, data: { status: 'PUBLISHED' } }),
      ).rejects.toThrow(); // published needs published_at
      await db.review.update({
        where: { id: review.id },
        data: { status: 'REMOVED', revision: 2 },
      });
      await expect(
        db.review.update({ where: { id: review.id }, data: { status: 'PENDING', revision: 3 } }),
      ).rejects.toThrow(/final/);
      await expect(
        db.review.update({ where: { id: review.id }, data: { rating: 9 } }),
      ).rejects.toThrow();
    });
  });

  describe('a confirmed hotel review in public', () => {
    it('shows the stay dates and the demo-booking label, and its summary has the hotel’s category ratings', async () => {
      const clock = testClock();
      const target = app(clock);
      const admin = await staff(target, 'admin', 'Meera Admin');
      const { agent } = await register(target);
      const stay = await paidStay(agent);
      clock.advance(25 * DAY);
      const review = ownReviewSchema.parse((await bookingReview(agent, stay.reference)).body.data);
      await publish(admin.agent, review.id);
      const list = await listFor(request(target) as unknown as Agent, 'hotel', review.subject.key);
      expect(list.items[0]).toMatchObject({
        verification: 'demo_booking',
        travelled: { from: stay.startsOn },
        aspects: { cleanliness: 5, value: 3 },
      });
      expect(list.summary.aspects.map((a) => a.aspect)).toEqual([
        'cleanliness',
        'location',
        'service',
        'comfort',
        'value',
      ]);
      expect(list.summary.aspects.find((a) => a.aspect === 'cleanliness')).toMatchObject({
        count: 1,
        average: null,
      });
      expect(list.summary.byVerification).toEqual({
        verified_booking: 0,
        demo_booking: 1,
        unverified: 0,
      });
      expect(JSON.stringify(list)).not.toContain(stay.reference);
      // The reviewable-bookings list shows it as reviewed.
      const bookings = (await agent.get('/api/v1/reviews/bookings')).body.data.items as OwnReview[];
      expect(bookings).toEqual([
        expect.objectContaining({ bookingReference: stay.reference, state: 'reviewed' }),
      ]);
    });
  });
});
