import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  balancesSchema,
  bookingRequirementsFor,
  bookingSchema,
  budgetOverviewSchema,
  expenseListSchema,
  expenseSchema,
  plannerActivityListSchema,
  utcDateFromToday,
  type Balances,
  type BudgetOverview,
  type Expense,
  type SearchResult,
} from '@wayora/contracts';
import type { Env } from '../../src/config/env.js';
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
 * Trip budget, expenses and group split against a real PostgreSQL
 * (docs/planner.md#budget): budget progress per currency, exact splits,
 * balances and settlement suggestions derived from stored records, the
 * database's own money invariants, idempotency and concurrency, booking
 * import without double counting — and the Phase 19 roles on every endpoint.
 */

if (process.env.CI && !TEST_DATABASE_URL) {
  throw new Error('CI is set but TEST_DATABASE_URL is not: the budget tests would be skipped.');
}

type Agent = ReturnType<typeof request.agent>;

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

function app(env: Partial<Env> = {}) {
  return buildTestApp({
    prisma: testPrisma(),
    env: { ...BASE_ENV, ...env },
    logger: pino({ level: 'silent' }),
    now: testClock().now,
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
const put = (agent: Agent, path: string, body: unknown) =>
  agent
    .put(api(path))
    .set('Origin', ORIGIN)
    .send(body as object);
const del = (agent: Agent, path: string) => agent.delete(api(path)).set('Origin', ORIGIN);

const userId = async (email: string) =>
  (await testPrisma().user.findUniqueOrThrow({ where: { email } })).id;

/** Asha (owner), Ravi (editor) and Meera (viewer) share a plan; Zoe is outside. */
async function shared(env: Partial<Env> = {}) {
  const target = app(env);
  const asha = await signedIn(target, 'asha@example.com', 'Asha Rao');
  const ravi = await signedIn(target, 'ravi@example.com', 'Ravi Kumar');
  const meera = await signedIn(target, 'meera@example.com', 'Meera Iyer');
  const zoe = await signedIn(target, 'zoe@example.com', 'Zoe Das');
  const created = await post(asha, '/trips', {
    title: 'Goa with friends',
    destinationId: 'goa',
    startDate: START,
    endDate: END,
  });
  expect(created.status).toBe(201);
  const tripId = created.body.data.id as string;
  for (const [agent, email, role] of [
    [ravi, 'ravi@example.com', 'editor'],
    [meera, 'meera@example.com', 'viewer'],
  ] as const) {
    const inv = await post(asha, `/trips/${tripId}/invitations`, { email, role }, null);
    expect(inv.status).toBe(201);
    expect((await post(agent, `/invitations/${inv.body.data.id}/accept`, {}, null)).status).toBe(
      200,
    );
  }
  const ids = {
    asha: await userId('asha@example.com'),
    ravi: await userId('ravi@example.com'),
    meera: await userId('meera@example.com'),
    zoe: await userId('zoe@example.com'),
  };
  return { target, asha, ravi, meera, zoe, tripId, ids };
}

const overview = async (agent: Agent, tripId: string): Promise<BudgetOverview> => {
  const res = await agent.get(api(`/trips/${tripId}/budget`));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return budgetOverviewSchema.parse(res.body.data);
};
const balances = async (agent: Agent, tripId: string): Promise<Balances> => {
  const res = await agent.get(api(`/trips/${tripId}/balances`));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return balancesSchema.parse(res.body.data);
};
const net = (b: Balances, currency: string, personId: string) =>
  b.currencies.find((c) => c.currency === currency)?.people.find((p) => p.personId === personId)
    ?.netMinor;

function paidExpense(
  overrides: Record<string, unknown> & {
    amountMinor: string;
    paidBy: { personId: string; amountMinor: string }[];
    split: unknown;
  },
) {
  return {
    description: 'Dinner',
    category: 'food',
    currency: 'INR',
    spentOn: START,
    status: 'paid',
    ...overrides,
  };
}

async function addExpense(agent: Agent, tripId: string, body: unknown): Promise<Expense> {
  const res = await post(agent, `/trips/${tripId}/expenses`, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return expenseSchema.parse(res.body.data);
}

describe.skipIf(!TEST_DATABASE_URL)(
  'trip budget and group split (integration, real PostgreSQL)',
  () => {
    beforeEach(resetAccounts);
    afterAll(disconnect);

    describe('budget', () => {
      it('starts empty, then tracks recorded and planned costs separately, per category', async () => {
        const { asha, tripId, ids } = await shared();
        const empty = await overview(asha, tripId);
        expect(empty).toMatchObject({
          budget: null,
          progress: null,
          totals: [],
          canManageBudget: true,
        });

        const set = await put(asha, `/trips/${tripId}/budget`, {
          currency: 'INR',
          totalMinor: '5000000',
          categories: [
            { category: 'food', amountMinor: '1000000' },
            { category: 'hotels', amountMinor: '2500000' },
          ],
        });
        expect(set.status, JSON.stringify(set.body)).toBe(200);
        expect(set.body.data.budget).toMatchObject({
          currency: 'INR',
          totalMinor: '5000000',
          version: 1,
        });

        await addExpense(
          asha,
          tripId,
          paidExpense({
            amountMinor: '1250050',
            paidBy: [{ personId: ids.asha, amountMinor: '1250050' }],
            split: { method: 'equal', participants: [ids.asha, ids.ravi] },
          }),
        );
        await addExpense(asha, tripId, {
          description: 'Hotel (estimate)',
          category: 'hotels',
          amountMinor: '2000000',
          currency: 'INR',
          spentOn: START,
          status: 'planned',
        });
        const o = await overview(asha, tripId);
        expect(o.progress).toMatchObject({
          currency: 'INR',
          totalMinor: '5000000',
          recordedMinor: '1250050',
          plannedMinor: '2000000',
          remainingMinor: '3749950',
          remainingAfterPlannedMinor: '1749950',
          utilizationBasisPoints: 2500, // 25.001% rounded down to 25.00%
          overBudget: false,
        });
        expect(o.progress!.categories).toEqual([
          {
            category: 'hotels',
            budgetMinor: '2500000',
            recordedMinor: '0',
            plannedMinor: '2000000',
          },
          { category: 'food', budgetMinor: '1000000', recordedMinor: '1250050', plannedMinor: '0' },
        ]);
        expect(o.totals).toEqual([
          {
            currency: 'INR',
            recordedMinor: '1250050',
            plannedMinor: '2000000',
            recordedCount: 1,
            plannedCount: 1,
          },
        ]);
      });

      it('shows over-budget honestly and never changes expenses when the budget changes', async () => {
        const { asha, tripId, ids } = await shared();
        await put(asha, `/trips/${tripId}/budget`, { currency: 'INR', totalMinor: '100000' });
        const expense = await addExpense(
          asha,
          tripId,
          paidExpense({
            amountMinor: '150000',
            paidBy: [{ personId: ids.asha, amountMinor: '150000' }],
            split: { method: 'equal', participants: [ids.asha] },
          }),
        );
        let o = await overview(asha, tripId);
        expect(o.progress).toMatchObject({
          remainingMinor: '-50000',
          utilizationBasisPoints: 15000,
          overBudget: true,
        });

        // Change and then remove the budget: the expense is untouched.
        expect(
          (
            await put(asha, `/trips/${tripId}/budget`, {
              version: 1,
              currency: 'USD',
              totalMinor: '500000',
            })
          ).status,
        ).toBe(200);
        o = await overview(asha, tripId);
        expect(o.progress).toMatchObject({ currency: 'USD', recordedMinor: '0' });
        expect(o.totals.map((t) => t.currency)).toEqual(['INR']);
        expect((await del(asha, `/trips/${tripId}/budget?version=2`)).status).toBe(200);
        const after = expenseSchema.parse(
          (await asha.get(api(`/trips/${tripId}/expenses/${expense.id}`))).body.data,
        );
        expect(after).toMatchObject({ amountMinor: '150000', currency: 'INR', version: 1 });
      });

      it('refuses stale budget edits, impossible category budgets and invalid money', async () => {
        const { asha, ravi, tripId } = await shared();
        await put(asha, `/trips/${tripId}/budget`, { currency: 'INR', totalMinor: '100000' });
        expect(
          (
            await put(ravi, `/trips/${tripId}/budget`, {
              version: 1,
              currency: 'INR',
              totalMinor: '200000',
            })
          ).status,
        ).toBe(200);
        const stale = await put(asha, `/trips/${tripId}/budget`, {
          version: 1,
          currency: 'INR',
          totalMinor: '300000',
        });
        expect(stale.status).toBe(409);
        expect(stale.body.error.code).toBe('PLAN_OUT_OF_DATE');
        const tooBig = await put(asha, `/trips/${tripId}/budget`, {
          version: 2,
          currency: 'INR',
          totalMinor: '100000',
          categories: [{ category: 'food', amountMinor: '100001' }],
        });
        expect(tooBig.status).toBe(400);
        for (const body of [
          { currency: 'INR', totalMinor: '1000.50' },
          { currency: 'INR', totalMinor: 1000 },
          { currency: 'INR', totalMinor: '-5' },
          { currency: 'XYZ', totalMinor: '100' },
          { currency: 'INR', totalMinor: '100', tripId },
        ]) {
          expect(
            (await put(asha, `/trips/${tripId}/budget`, { version: 2, ...body })).status,
            JSON.stringify(body),
          ).toBe(400);
        }
      });

      it('keeps currencies apart: other currencies are totalled separately, never converted', async () => {
        const { asha, tripId, ids } = await shared();
        await put(asha, `/trips/${tripId}/budget`, { currency: 'INR', totalMinor: '10000000' });
        await addExpense(
          asha,
          tripId,
          paidExpense({
            amountMinor: '12000',
            currency: 'USD',
            paidBy: [{ personId: ids.asha, amountMinor: '12000' }],
            split: { method: 'equal', participants: [ids.asha, ids.ravi] },
          }),
        );
        await addExpense(
          asha,
          tripId,
          paidExpense({
            amountMinor: '300000',
            paidBy: [{ personId: ids.ravi, amountMinor: '300000' }],
            split: { method: 'equal', participants: [ids.asha, ids.ravi] },
          }),
        );
        const o = await overview(asha, tripId);
        expect(o.progress!.recordedMinor).toBe('300000');
        expect(o.totals.map((t) => [t.currency, t.recordedMinor])).toEqual([
          ['INR', '300000'],
          ['USD', '12000'],
        ]);
        const b = await balances(asha, tripId);
        expect(b.currencies.map((c) => c.currency)).toEqual(['INR', 'USD']);
        expect(net(b, 'USD', ids.asha)).toBe('6000');
        expect(net(b, 'INR', ids.asha)).toBe('-150000');
      });
    });

    describe('splitting', () => {
      it('splits ₹1,000 three ways exactly, with the extra paisa assigned deterministically', async () => {
        const { asha, tripId, ids } = await shared();
        const e = await addExpense(
          asha,
          tripId,
          paidExpense({
            amountMinor: '100000',
            paidBy: [{ personId: ids.asha, amountMinor: '100000' }],
            split: { method: 'equal', participants: [ids.meera, ids.ravi, ids.asha] },
          }),
        );
        expect(e.splitMethod).toBe('equal');
        const shares = e.parts.map((p) => BigInt(p.shareMinor));
        expect(shares.reduce((s, v) => s + v, 0n)).toBe(100_000n);
        expect(shares.sort()).toEqual([33_333n, 33_333n, 33_334n]);
        const sortedIds = [ids.asha, ids.ravi, ids.meera].sort();
        expect(e.parts.find((p) => p.personId === sortedIds[0])!.shareMinor).toBe('33334');
        // Stored exactly as computed.
        const stored = await testPrisma().planExpensePart.findMany({ where: { expenseId: e.id } });
        expect(stored.reduce((s, p) => s + p.shareMinor, 0n)).toBe(100_000n);
        expect(stored.reduce((s, p) => s + p.paidMinor, 0n)).toBe(100_000n);
      });

      it('supports custom and percentage splits and several payers — totals must match exactly', async () => {
        const { asha, tripId, ids } = await shared();
        const custom = await addExpense(
          asha,
          tripId,
          paidExpense({
            amountMinor: '90000',
            paidBy: [
              { personId: ids.asha, amountMinor: '60000' },
              { personId: ids.ravi, amountMinor: '30000' },
            ],
            split: {
              method: 'custom',
              shares: [
                { personId: ids.asha, amountMinor: '10000' },
                { personId: ids.ravi, amountMinor: '50000' },
                { personId: ids.meera, amountMinor: '30000' },
              ],
            },
          }),
        );
        expect(custom.parts).toEqual(
          [
            { personId: ids.asha, paidMinor: '60000', shareMinor: '10000', basisPoints: null },
            { personId: ids.ravi, paidMinor: '30000', shareMinor: '50000', basisPoints: null },
            { personId: ids.meera, paidMinor: '0', shareMinor: '30000', basisPoints: null },
          ].sort((a, b) => (a.personId < b.personId ? -1 : 1)),
        );

        const percent = await addExpense(
          asha,
          tripId,
          paidExpense({
            amountMinor: '10',
            paidBy: [{ personId: ids.ravi, amountMinor: '10' }],
            split: {
              method: 'percent',
              shares: [
                { personId: ids.asha, basisPoints: 3333 },
                { personId: ids.ravi, basisPoints: 3333 },
                { personId: ids.meera, basisPoints: 3334 },
              ],
            },
          }),
        );
        expect(percent.parts.reduce((s, p) => s + BigInt(p.shareMinor), 0n)).toBe(10n);
        expect(percent.parts.find((p) => p.personId === ids.meera)).toMatchObject({
          shareMinor: '4',
          basisPoints: 3334,
        });
      });

      it('refuses mismatched totals, unknown or duplicate people, and non-members', async () => {
        const { asha, tripId, ids } = await shared();
        const cases: [unknown, string][] = [
          [
            {
              amountMinor: '1000',
              paidBy: [{ personId: ids.asha, amountMinor: '999' }],
              split: { method: 'equal', participants: [ids.asha] },
            },
            'body.paidBy',
          ],
          [
            {
              amountMinor: '1000',
              paidBy: [{ personId: ids.asha, amountMinor: '1000' }],
              split: {
                method: 'custom',
                shares: [
                  { personId: ids.asha, amountMinor: '600' },
                  { personId: ids.ravi, amountMinor: '401' },
                ],
              },
            },
            'body.split',
          ],
          [
            {
              amountMinor: '1000',
              paidBy: [{ personId: ids.asha, amountMinor: '1000' }],
              split: {
                method: 'percent',
                shares: [
                  { personId: ids.asha, basisPoints: 5000 },
                  { personId: ids.ravi, basisPoints: 4999 },
                ],
              },
            },
            'body.split',
          ],
          [
            {
              amountMinor: '1000',
              paidBy: [{ personId: ids.zoe, amountMinor: '1000' }],
              split: { method: 'equal', participants: [ids.asha] },
            },
            'body.paidBy.0.personId',
          ],
          [
            {
              amountMinor: '1000',
              paidBy: [{ personId: ids.asha, amountMinor: '1000' }],
              split: { method: 'equal', participants: [ids.asha, ids.zoe] },
            },
            'body.split.participants.1',
          ],
          [
            {
              amountMinor: '1000',
              paidBy: [{ personId: ids.asha, amountMinor: '1000' }],
              split: { method: 'equal', participants: [ids.asha, randomUUID()] },
            },
            'body.split.participants.1',
          ],
          [
            {
              amountMinor: '1000',
              paidBy: [{ personId: ids.asha, amountMinor: '1000' }],
              split: { method: 'equal', participants: [ids.asha, ids.asha] },
            },
            'body.split',
          ],
          [
            {
              amountMinor: '1000',
              paidBy: [
                { personId: ids.asha, amountMinor: '500' },
                { personId: ids.asha, amountMinor: '500' },
              ],
              split: { method: 'equal', participants: [ids.asha] },
            },
            'body.paidBy.1.personId',
          ],
        ];
        for (const [overrides, path] of cases) {
          const res = await post(
            asha,
            `/trips/${tripId}/expenses`,
            paidExpense(overrides as never),
          );
          expect(res.status, JSON.stringify(overrides)).toBe(400);
          expect(
            (res.body.error.details as { path: string }[]).some((d) => d.path.startsWith(path)),
            `${path} → ${JSON.stringify(res.body.error.details)}`,
          ).toBe(true);
        }
        expect(await testPrisma().planExpense.count()).toBe(0);
      });

      it('the database itself refuses unbalanced or half-written splits', async () => {
        const { asha, tripId, ids } = await shared();
        const e = await addExpense(
          asha,
          tripId,
          paidExpense({
            amountMinor: '1000',
            paidBy: [{ personId: ids.asha, amountMinor: '1000' }],
            split: { method: 'equal', participants: [ids.asha, ids.ravi] },
          }),
        );
        const prisma = testPrisma();
        await expect(
          prisma.planExpensePart.update({
            where: { expenseId_userId: { expenseId: e.id, userId: ids.ravi } },
            data: { shareMinor: 499n },
          }),
        ).rejects.toThrow();
        await expect(
          prisma.planExpense.update({ where: { id: e.id }, data: { amountMinor: 1001n } }),
        ).rejects.toThrow();
        await expect(
          prisma.planExpensePart.create({
            data: { expenseId: e.id, userId: ids.meera, paidMinor: 0n, shareMinor: 0n },
          }),
        ).rejects.toThrow();
        // Nothing changed.
        const parts = await prisma.planExpensePart.findMany({ where: { expenseId: e.id } });
        expect(parts.reduce((s, p) => s + p.shareMinor, 0n)).toBe(1000n);
      });
    });

    describe('balances and settlements', () => {
      it('A paid ₹1,500 and owes ₹500; B paid ₹500 and owes ₹1,000 — with a suggestion that reconciles', async () => {
        const { asha, ravi, tripId, ids } = await shared();
        await addExpense(
          asha,
          tripId,
          paidExpense({
            amountMinor: '150000',
            paidBy: [{ personId: ids.asha, amountMinor: '150000' }],
            split: {
              method: 'custom',
              shares: [
                { personId: ids.asha, amountMinor: '50000' },
                { personId: ids.ravi, amountMinor: '100000' },
              ],
            },
          }),
        );
        await addExpense(
          ravi,
          tripId,
          paidExpense({
            amountMinor: '50000',
            paidBy: [{ personId: ids.ravi, amountMinor: '50000' }],
            split: { method: 'equal', participants: [ids.ravi] },
          }),
        );
        let b = await balances(asha, tripId);
        const inr = b.currencies[0]!;
        expect(inr.people.find((p) => p.personId === ids.asha)).toMatchObject({
          paidMinor: '150000',
          shareMinor: '50000',
          netMinor: '100000',
        });
        expect(inr.people.find((p) => p.personId === ids.ravi)).toMatchObject({
          paidMinor: '50000',
          shareMinor: '150000',
          netMinor: '-100000',
        });
        expect(inr.people.reduce((s, p) => s + BigInt(p.netMinor), 0n)).toBe(0n);
        expect(inr.suggestions).toEqual([
          { fromId: ids.ravi, toId: ids.asha, amountMinor: '100000' },
        ]);

        // Ravi records paying Asha back (outside Wayora): everyone is even.
        const rec = await post(ravi, `/trips/${tripId}/settlements`, {
          fromId: ids.ravi,
          toId: ids.asha,
          amountMinor: '100000',
          currency: 'INR',
          settledOn: START,
          note: 'UPI',
        });
        expect(rec.status, JSON.stringify(rec.body)).toBe(201);
        b = balancesSchema.parse(rec.body.data);
        expect(net(b, 'INR', ids.asha)).toBe('0');
        expect(net(b, 'INR', ids.ravi)).toBe('0');
        expect(b.currencies[0]!.suggestions).toEqual([]);
        expect(b.settlements[0]).toMatchObject({
          amountMinor: '100000',
          note: 'UPI',
          canDelete: true,
        });

        // Deleting the record brings the debt back.
        const settlementId = b.settlements[0]!.id;
        expect((await del(asha, `/trips/${tripId}/settlements/${settlementId}`)).status).toBe(200);
        expect(net(await balances(asha, tripId), 'INR', ids.ravi)).toBe('-100000');
      });

      it('different participant sets, planned and deleted expenses, recomputed from stored records', async () => {
        const { asha, ravi, tripId, ids } = await shared();
        await addExpense(
          asha,
          tripId,
          paidExpense({
            amountMinor: '90000',
            paidBy: [{ personId: ids.asha, amountMinor: '90000' }],
            split: { method: 'equal', participants: [ids.asha, ids.ravi, ids.meera] },
          }),
        );
        const taxi = await addExpense(
          ravi,
          tripId,
          paidExpense({
            description: 'Taxi',
            category: 'local_transport',
            amountMinor: '301',
            paidBy: [{ personId: ids.meera, amountMinor: '301' }],
            split: { method: 'equal', participants: [ids.ravi, ids.meera] },
          }),
        );
        await addExpense(asha, tripId, {
          description: 'Planned spa',
          category: 'activities',
          amountMinor: '500000',
          currency: 'INR',
          spentOn: START,
          status: 'planned',
        });
        let b = await balances(asha, tripId);
        const sorted = [ids.ravi, ids.meera].sort();
        const extra = (id: string) => (id === sorted[0] ? 151n : 150n);
        expect(net(b, 'INR', ids.asha)).toBe('60000');
        expect(net(b, 'INR', ids.ravi)).toBe((-30_000n - extra(ids.ravi)).toString());
        expect(net(b, 'INR', ids.meera)).toBe((301n - 30_000n - extra(ids.meera)).toString());
        const inr = b.currencies[0]!;
        expect(inr.people.reduce((s, p) => s + BigInt(p.netMinor), 0n)).toBe(0n);
        // The suggestions settle everyone exactly.
        const after = new Map(inr.people.map((p) => [p.personId, BigInt(p.netMinor)]));
        for (const t of inr.suggestions) {
          after.set(t.fromId, after.get(t.fromId)! + BigInt(t.amountMinor));
          after.set(t.toId, after.get(t.toId)! - BigInt(t.amountMinor));
        }
        expect([...after.values()].every((v) => v === 0n)).toBe(true);

        // A deleted expense no longer counts.
        expect((await del(ravi, `/trips/${tripId}/expenses/${taxi.id}`)).status).toBe(200);
        b = await balances(asha, tripId);
        expect(net(b, 'INR', ids.meera)).toBe('-30000');
        expect(await testPrisma().planExpensePart.count({ where: { expenseId: taxi.id } })).toBe(0);
      });

      it('settlements: only members, not with yourself; viewers only their own', async () => {
        const { asha, meera, zoe, tripId, ids } = await shared();
        const body = (o: Record<string, unknown>) => ({
          fromId: ids.meera,
          toId: ids.asha,
          amountMinor: '1000',
          currency: 'INR',
          settledOn: START,
          ...o,
        });
        expect(
          (await post(asha, `/trips/${tripId}/settlements`, body({ toId: ids.zoe }))).status,
        ).toBe(400);
        expect(
          (await post(asha, `/trips/${tripId}/settlements`, body({ toId: ids.meera }))).status,
        ).toBe(400);
        expect(
          (await post(meera, `/trips/${tripId}/settlements`, body({ fromId: ids.ravi }))).status,
        ).toBe(403);
        const own = await post(meera, `/trips/${tripId}/settlements`, body({}));
        expect(own.status).toBe(201);
        const b = balancesSchema.parse(own.body.data);
        const id = b.settlements[0]!.id;
        expect((await del(zoe, `/trips/${tripId}/settlements/${id}`)).status).toBe(404);
      });
    });

    describe('permissions', () => {
      it('viewers see everything but change nothing; strangers get nothing', async () => {
        const { asha, meera, zoe, tripId, ids } = await shared();
        await put(asha, `/trips/${tripId}/budget`, { currency: 'INR', totalMinor: '100000' });
        const e = await addExpense(
          asha,
          tripId,
          paidExpense({
            amountMinor: '1000',
            notes: 'Table by the window',
            paidBy: [{ personId: ids.asha, amountMinor: '1000' }],
            split: { method: 'equal', participants: [ids.asha, ids.meera] },
          }),
        );

        const o = await overview(meera, tripId);
        expect(o).toMatchObject({
          canAddExpenses: false,
          canManageBudget: false,
          bookingImport: null,
        });
        const list = expenseListSchema.parse(
          (await meera.get(api(`/trips/${tripId}/expenses`))).body.data,
        );
        expect(list.items[0]).toMatchObject({ id: e.id, canEdit: false });
        expect(JSON.stringify(list.people)).not.toContain('@');
        expect((await meera.get(api(`/trips/${tripId}/balances`))).status).toBe(200);

        const writes = [
          post(
            meera,
            `/trips/${tripId}/expenses`,
            paidExpense({
              amountMinor: '1',
              paidBy: [{ personId: ids.meera, amountMinor: '1' }],
              split: { method: 'equal', participants: [ids.meera] },
            }),
          ),
          put(meera, `/trips/${tripId}/expenses/${e.id}`, {
            ...paidExpense({
              amountMinor: '1000',
              paidBy: [{ personId: ids.asha, amountMinor: '1000' }],
              split: { method: 'equal', participants: [ids.meera] },
            }),
            version: 1,
          }),
          del(meera, `/trips/${tripId}/expenses/${e.id}`),
          put(meera, `/trips/${tripId}/budget`, { version: 1, currency: 'INR', totalMinor: '1' }),
          del(meera, `/trips/${tripId}/budget?version=1`),
        ];
        for (const res of await Promise.all(writes)) expect(res.status, res.text).toBe(403);

        const stranger = [
          zoe.get(api(`/trips/${tripId}/budget`)),
          zoe.get(api(`/trips/${tripId}/expenses`)),
          zoe.get(api(`/trips/${tripId}/expenses/${e.id}`)),
          zoe.get(api(`/trips/${tripId}/balances`)),
          post(
            zoe,
            `/trips/${tripId}/expenses`,
            paidExpense({
              amountMinor: '1',
              paidBy: [{ personId: ids.zoe, amountMinor: '1' }],
              split: { method: 'equal', participants: [ids.zoe] },
            }),
          ),
          del(zoe, `/trips/${tripId}/expenses/${e.id}`),
          put(zoe, `/trips/${tripId}/budget`, { currency: 'INR', totalMinor: '1' }),
        ];
        for (const res of await Promise.all(stranger)) {
          expect(res.status, res.text).toBe(404);
          expect(JSON.stringify(res.body)).not.toContain('window');
        }
        expect(
          (await testPrisma().planExpense.findUniqueOrThrow({ where: { id: e.id } })).version,
        ).toBe(1);
      });

      it('editors change only their own expenses; the owner can change any', async () => {
        const { asha, ravi, tripId, ids } = await shared();
        const ashas = await addExpense(
          asha,
          tripId,
          paidExpense({
            amountMinor: '1000',
            paidBy: [{ personId: ids.asha, amountMinor: '1000' }],
            split: { method: 'equal', participants: [ids.asha, ids.ravi] },
          }),
        );
        const ravis = await addExpense(
          ravi,
          tripId,
          paidExpense({
            amountMinor: '2000',
            paidBy: [{ personId: ids.ravi, amountMinor: '2000' }],
            split: { method: 'equal', participants: [ids.asha, ids.ravi] },
          }),
        );
        expect(ravis.canEdit).toBe(true);
        const list = expenseListSchema.parse(
          (await ravi.get(api(`/trips/${tripId}/expenses`))).body.data,
        );
        expect(list.items.find((x) => x.id === ashas.id)!.canEdit).toBe(false);

        const replace = (e: Expense, amount: string) => ({
          ...paidExpense({
            description: 'Edited',
            amountMinor: amount,
            paidBy: [{ personId: ids.ravi, amountMinor: amount }],
            split: { method: 'equal', participants: [ids.ravi] },
          }),
          version: e.version,
        });
        expect(
          (await put(ravi, `/trips/${tripId}/expenses/${ashas.id}`, replace(ashas, '1000'))).status,
        ).toBe(403);
        expect((await del(ravi, `/trips/${tripId}/expenses/${ashas.id}`)).status).toBe(403);
        expect(
          (await put(ravi, `/trips/${tripId}/expenses/${ravis.id}`, replace(ravis, '2500'))).status,
        ).toBe(200);
        expect(
          (
            await put(
              asha,
              `/trips/${tripId}/expenses/${ravis.id}`,
              replace({ ...ravis, version: 2 }, '3000'),
            )
          ).status,
        ).toBe(200);
        expect((await del(asha, `/trips/${tripId}/expenses/${ravis.id}`)).status).toBe(200);
      });

      it('expenses can’t be reached through another plan, and removal ends access at once', async () => {
        const { asha, ravi, zoe, tripId, ids } = await shared();
        const e = await addExpense(
          asha,
          tripId,
          paidExpense({
            amountMinor: '1000',
            paidBy: [{ personId: ids.asha, amountMinor: '1000' }],
            split: { method: 'equal', participants: [ids.asha] },
          }),
        );
        const zoesTrip = (
          await post(zoe, '/trips', {
            title: 'Zoe',
            destinationId: 'goa',
            startDate: START,
            endDate: END,
          })
        ).body.data.id as string;
        for (const res of await Promise.all([
          zoe.get(api(`/trips/${zoesTrip}/expenses/${e.id}`)),
          put(zoe, `/trips/${zoesTrip}/expenses/${e.id}`, {
            ...paidExpense({
              amountMinor: '1',
              paidBy: [{ personId: ids.zoe, amountMinor: '1' }],
              split: { method: 'equal', participants: [ids.zoe] },
            }),
            version: 1,
          }),
          del(zoe, `/trips/${zoesTrip}/expenses/${e.id}`),
        ])) {
          expect(res.status, res.text).toBe(404);
        }
        // Ravi is removed: his next request is refused.
        const members = (await asha.get(api(`/trips/${tripId}/members`))).body.data.members as {
          id: string;
          name: string;
        }[];
        const raviMember = members.find((m) => m.name === 'Ravi Kumar')!;
        expect((await del(asha, `/trips/${tripId}/members/${raviMember.id}`)).status).toBe(200);
        expect((await ravi.get(api(`/trips/${tripId}/budget`))).status).toBe(404);
        expect(
          (
            await post(
              ravi,
              `/trips/${tripId}/expenses`,
              paidExpense({
                amountMinor: '1',
                paidBy: [{ personId: ids.ravi, amountMinor: '1' }],
                split: { method: 'equal', participants: [ids.ravi] },
              }),
            )
          ).status,
        ).toBe(404);
      });

      it('a former member stays on old expenses (shown as former) but can’t be added to new ones', async () => {
        const { asha, tripId, ids } = await shared();
        const e = await addExpense(
          asha,
          tripId,
          paidExpense({
            amountMinor: '2000',
            paidBy: [{ personId: ids.ravi, amountMinor: '2000' }],
            split: { method: 'equal', participants: [ids.asha, ids.ravi] },
          }),
        );
        const members = (await asha.get(api(`/trips/${tripId}/members`))).body.data.members as {
          id: string;
          name: string;
        }[];
        await del(
          asha,
          `/trips/${tripId}/members/${members.find((m) => m.name === 'Ravi Kumar')!.id}`,
        );

        const o = await overview(asha, tripId);
        expect(o.people.find((p) => p.id === ids.ravi)!.role).toBe('former');
        expect(net(await balances(asha, tripId), 'INR', ids.ravi)).toBe('1000');
        // Editing the old expense may keep him; a new expense may not include him.
        const edit = await put(asha, `/trips/${tripId}/expenses/${e.id}`, {
          ...paidExpense({
            description: 'Renamed',
            amountMinor: '2000',
            paidBy: [{ personId: ids.ravi, amountMinor: '2000' }],
            split: { method: 'equal', participants: [ids.asha, ids.ravi] },
          }),
          version: 1,
        });
        expect(edit.status, JSON.stringify(edit.body)).toBe(200);
        const fresh = await post(
          asha,
          `/trips/${tripId}/expenses`,
          paidExpense({
            amountMinor: '1',
            paidBy: [{ personId: ids.ravi, amountMinor: '1' }],
            split: { method: 'equal', participants: [ids.asha] },
          }),
        );
        expect(fresh.status).toBe(400);
      });
    });

    describe('editing, concurrency and retries', () => {
      it('an edit replaces the whole split (no stale allocations) and refuses stale versions', async () => {
        const { asha, tripId, ids } = await shared();
        const e = await addExpense(
          asha,
          tripId,
          paidExpense({
            amountMinor: '3000',
            paidBy: [{ personId: ids.asha, amountMinor: '3000' }],
            split: { method: 'equal', participants: [ids.asha, ids.ravi, ids.meera] },
          }),
        );
        const edit = (version: number, participants: string[]) =>
          put(asha, `/trips/${tripId}/expenses/${e.id}`, {
            ...paidExpense({
              amountMinor: '3000',
              paidBy: [{ personId: ids.asha, amountMinor: '3000' }],
              split: { method: 'equal', participants },
            }),
            version,
          });
        const ok = await edit(1, [ids.ravi]);
        expect(ok.status).toBe(200);
        expect(
          expenseSchema
            .parse(ok.body.data)
            .parts.map((p) => [p.personId, p.paidMinor, p.shareMinor]),
        ).toEqual(
          [
            [ids.asha, '3000', '0'],
            [ids.ravi, '0', '3000'],
          ].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
        );
        const stale = await edit(1, [ids.asha]);
        expect(stale.status).toBe(409);
        expect(stale.body.error.code).toBe('PLAN_OUT_OF_DATE');

        // Two simultaneous edits of the same version: exactly one wins.
        const [x, y] = await Promise.all([edit(2, [ids.asha]), edit(2, [ids.meera, ids.ravi])]);
        expect([x.status, y.status].sort()).toEqual([200, 409]);
        const stored = await testPrisma().planExpensePart.findMany({ where: { expenseId: e.id } });
        expect(stored.reduce((s, p) => s + p.shareMinor, 0n)).toBe(3000n);
      });

      it('a retried add creates one expense', async () => {
        const { asha, tripId, ids } = await shared();
        const body = paidExpense({
          amountMinor: '1000',
          paidBy: [{ personId: ids.asha, amountMinor: '1000' }],
          split: { method: 'equal', participants: [ids.asha] },
        });
        const key = randomUUID();
        expect((await post(asha, `/trips/${tripId}/expenses`, body, key)).status).toBe(201);
        const again = await post(asha, `/trips/${tripId}/expenses`, body, key);
        expect(again.status).toBe(201);
        expect(again.headers['idempotent-replayed']).toBe('true');
        expect(await testPrisma().planExpense.count()).toBe(1);
        expect((await post(asha, `/trips/${tripId}/expenses`, body, null)).status).toBe(400);
        // One history entry for that one expense.
        const history = plannerActivityListSchema.parse(
          (await asha.get(api(`/trips/${tripId}/activity`))).body.data,
        );
        expect(history.items.filter((h) => h.type === 'expense_added')).toHaveLength(1);
      });

      it('records history without notes, and filters and sorts the list', async () => {
        const { asha, ravi, tripId, ids } = await shared();
        await addExpense(
          asha,
          tripId,
          paidExpense({
            description: 'Breakfast',
            spentOn: START,
            amountMinor: '500',
            notes: 'secret note',
            paidBy: [{ personId: ids.asha, amountMinor: '500' }],
            split: { method: 'equal', participants: [ids.asha, ids.ravi] },
          }),
        );
        await addExpense(
          ravi,
          tripId,
          paidExpense({
            description: 'Ferry',
            category: 'local_transport',
            spentOn: END,
            amountMinor: '900',
            paidBy: [{ personId: ids.ravi, amountMinor: '900' }],
            split: { method: 'equal', participants: [ids.ravi] },
          }),
        );
        await addExpense(asha, tripId, {
          description: 'Spa',
          category: 'activities',
          amountMinor: '700',
          currency: 'INR',
          spentOn: utcDateFromToday(11),
          status: 'planned',
        });

        const list = async (q: string) =>
          expenseListSchema
            .parse((await asha.get(api(`/trips/${tripId}/expenses${q}`))).body.data)
            .items.map((i) => i.description);
        expect(await list('')).toEqual(['Ferry', 'Spa', 'Breakfast']);
        expect(await list('?sort=date-asc')).toEqual(['Breakfast', 'Spa', 'Ferry']);
        expect(await list('?sort=amount-desc')).toEqual(['Ferry', 'Spa', 'Breakfast']);
        expect(await list('?category=local_transport')).toEqual(['Ferry']);
        expect(await list('?status=planned')).toEqual(['Spa']);
        expect(await list(`?payer=${ids.ravi}`)).toEqual(['Ferry']);
        expect(await list(`?participant=${ids.ravi}`)).toEqual(['Ferry', 'Breakfast']);
        expect(await list(`?from=${utcDateFromToday(11)}&to=${END}`)).toEqual(['Ferry', 'Spa']);
        expect((await asha.get(api(`/trips/${tripId}/expenses?sort=random`))).status).toBe(400);

        const history = plannerActivityListSchema.parse(
          (await asha.get(api(`/trips/${tripId}/activity`))).body.data,
        );
        const text = JSON.stringify(history);
        expect(text).toContain('Ravi Kumar added the expense “Ferry” (INR 9.00)');
        expect(text).toContain('You added the planned expense “Spa” (INR 7.00)');
        expect(text).not.toContain('secret note');
        const stored = await testPrisma().plannerActivity.findMany();
        expect(JSON.stringify(stored.map((s) => s.data))).not.toContain('secret note');
      });
    });

    describe('bookings', () => {
      async function bookHotel(agent: Agent): Promise<string> {
        const { serviceType: _t, ...body } = VALID_INPUTS.hotels;
        const search = await agent.post('/api/v1/search/hotels').set('Origin', ORIGIN).send(body);
        const offer = search.body.data.results[0] as SearchResult;
        const requirements = bookingRequirementsFor(offer);
        const res = await agent
          .post('/api/v1/bookings')
          .set('Origin', ORIGIN)
          .set('Idempotency-Key', randomUUID())
          .send({
            serviceType: offer.serviceType,
            searchId: search.body.data.searchId,
            offerId: offer.id,
            travellers: requirements.namedTravellers.map(() => ({
              firstName: 'Asha',
              lastName: 'Rao',
            })),
            acceptedPrice: offer.price,
            acceptDemoTerms: true,
          });
        const booking = bookingSchema.parse(res.body.data);
        if (booking.payment.canPay) {
          await agent
            .post(`/api/v1/bookings/${booking.reference}/payments`)
            .set('Origin', ORIGIN)
            .set('Idempotency-Key', randomUUID())
            .send({ amount: booking.payment.amount });
        }
        return booking.reference;
      }

      it('adds the owner’s demo booking once, as planned (no money moved), never double-counted', async () => {
        const { asha, ravi, tripId } = await shared();
        const reference = await bookHotel(asha);
        const plan = (await asha.get(api(`/trips/${tripId}`))).body.data;
        expect(
          (
            await asha
              .patch(api(`/trips/${tripId}`))
              .set('Origin', ORIGIN)
              .send({ version: plan.version, bookingReference: reference })
          ).status,
        ).toBe(200);

        const offer = (await overview(asha, tripId)).bookingImport!;
        expect(offer).toMatchObject({ reference, paid: false, demo: true, currency: 'INR' });
        expect((await overview(ravi, tripId)).bookingImport).toBeNull();
        expect((await post(ravi, `/trips/${tripId}/expenses/from-booking`, {})).status).toBe(403);

        const added = await post(asha, `/trips/${tripId}/expenses/from-booking`, {});
        expect(added.status, JSON.stringify(added.body)).toBe(201);
        expect(expenseSchema.parse(added.body.data)).toMatchObject({
          status: 'planned',
          category: 'hotels',
          amountMinor: offer.amountMinor,
          bookingReference: reference,
          notes: 'Demo booking: no money was charged.',
          parts: [],
        });
        expect((await overview(asha, tripId)).bookingImport).toBeNull();
        const twice = await post(asha, `/trips/${tripId}/expenses/from-booking`, {});
        expect(twice.status).toBe(409);
        expect(await testPrisma().planExpense.count({ where: { bookingId: { not: null } } })).toBe(
          1,
        );
        // Balances aren't affected by a planned (unpaid) booking.
        expect((await balances(asha, tripId)).currencies).toEqual([]);
      });

      it('a real (non-demo) booking with a confirmed payment is added as paid, split among members', async () => {
        const { asha, tripId, ids } = await shared();
        const demoReference = await bookHotel(asha);
        // No real payment provider exists, so clone the demo booking and its
        // succeeded payment as a non-demo pair (test data only).
        const prisma = testPrisma();
        const demo = await prisma.booking.findUniqueOrThrow({
          where: { reference: demoReference },
        });
        const reference = `WYD-${demoReference.slice(9, 13)}-${demoReference.slice(4, 8)}`;
        const realId = randomUUID();
        await prisma.$executeRaw`
        INSERT INTO bookings (id, order_id, category, status, provider, provider_reference, currency,
          total_amount_minor, created_at, updated_at, cancelled_at, confirmed_at, contact_phone, ends_on,
          is_demo, offer_snapshot, party_size, reference, search_id, starts_on, user_id, payment_mode,
          payment_due_at)
        SELECT ${realId}::uuid, order_id, category, status, provider, provider_reference, currency,
          total_amount_minor, created_at, updated_at, cancelled_at, confirmed_at, contact_phone, ends_on,
          false, offer_snapshot, party_size, ${reference}, search_id, starts_on, user_id, payment_mode,
          payment_due_at
        FROM bookings WHERE id = ${demo.id}::uuid`;
        await prisma.$executeRaw`
        INSERT INTO payments (id, booking_id, user_id, attempt, mode, provider, provider_reference, status,
          currency, amount_minor, demo_scenario, idempotency_key_hash, failure_code, failure_message,
          refund_required, created_at, updated_at, completed_at)
        SELECT ${randomUUID()}::uuid, ${realId}::uuid, user_id, attempt, mode, provider, ${`clone-${realId}`},
          status, currency, amount_minor, demo_scenario, NULL, failure_code, failure_message,
          refund_required, created_at, updated_at, completed_at
        FROM payments WHERE booking_id = ${demo.id}::uuid AND status = 'SUCCEEDED'`;
        const plan = (await asha.get(api(`/trips/${tripId}`))).body.data;
        expect(
          (
            await asha
              .patch(api(`/trips/${tripId}`))
              .set('Origin', ORIGIN)
              .send({ version: plan.version, bookingReference: reference })
          ).status,
        ).toBe(200);

        expect((await overview(asha, tripId)).bookingImport).toMatchObject({
          reference,
          paid: true,
          demo: false,
        });
        const added = await post(asha, `/trips/${tripId}/expenses/from-booking`, {});
        expect(added.status, JSON.stringify(added.body)).toBe(201);
        const expense = expenseSchema.parse(added.body.data);
        expect(expense).toMatchObject({ status: 'paid', splitMethod: 'equal', notes: null });
        const amount = BigInt(expense.amountMinor);
        expect(expense.parts.reduce((s, p) => s + BigInt(p.paidMinor), 0n)).toBe(amount);
        expect(expense.parts.find((p) => p.personId === ids.asha)!.paidMinor).toBe(
          expense.amountMinor,
        );
        expect(expense.parts.reduce((s, p) => s + BigInt(p.shareMinor), 0n)).toBe(amount);
        expect(new Set(expense.parts.map((p) => p.personId))).toEqual(
          new Set([ids.asha, ids.ravi, ids.meera]),
        );
        // Its amount can't be edited away from the booking's.
        const edit = await put(asha, `/trips/${tripId}/expenses/${expense.id}`, {
          ...paidExpense({
            amountMinor: '1',
            paidBy: [{ personId: ids.asha, amountMinor: '1' }],
            split: { method: 'equal', participants: [ids.asha] },
          }),
          version: 1,
        });
        expect(edit.status).toBe(400);
      });
    });
  },
);
