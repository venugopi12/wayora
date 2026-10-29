import {
  EXPENSE_CATEGORIES,
  balancesSchema,
  budgetOverviewSchema,
  computeBalances,
  expenseListSchema,
  expenseSchema,
  splitByBasisPoints,
  splitEqual,
  suggestSettlements,
  type Budget,
  type BudgetOverview,
  type BudgetPerson,
  type Expense,
  type PlannedTrip,
  type Settlement,
} from '@wayora/contracts';

/*
 * A stand-in for the plan budget API (docs/planner.md#budget-api), used by
 * fake-planner-api.ts. It uses the same exact split and balance functions as
 * the real API (from @wayora/contracts) and follows its main rules: version
 * checks on budget and expense edits, Idempotency-Key on POSTs, members only
 * on expenses, shares that add up exactly. The real API is covered by
 * apps/api/test/integration/planner-budget.test.ts.
 */

const AT = '2026-10-22T10:00:00.000Z';
let ids = 0;
const uuid = () => {
  ids += 1;
  return `01890000-0000-7000-b000-${String(ids).padStart(12, '0')}`;
};

export const PERSON = {
  asha: '01890000-0000-7000-8000-000000000001',
  ravi: '01890000-0000-7000-8000-000000000002',
  meera: '01890000-0000-7000-8000-000000000003',
};

export interface FakeBudgetState {
  people: BudgetPerson[];
  budget: Budget | null;
  expenses: Expense[];
  settlements: Settlement[];
  canAddExpenses: boolean;
  canManageBudget: boolean;
  canRecordSettlements: boolean;
  bookingImport: BudgetOverview['bookingImport'];
}

/** A budget state for a plan (default: the owner, you, alone; nothing recorded). */
export function budgetState(overrides: Partial<FakeBudgetState> = {}): FakeBudgetState {
  return {
    people: [{ id: PERSON.asha, name: 'Asha Rao', initials: 'AR', isYou: true, role: 'owner' }],
    budget: null,
    expenses: [],
    settlements: [],
    canAddExpenses: true,
    canManageBudget: true,
    canRecordSettlements: true,
    bookingImport: null,
    ...overrides,
  };
}

/** A paid expense split equally (or as `parts` says). */
export function expense(
  overrides: Partial<Expense> & { description: string; amountMinor: string },
): Expense {
  return expenseSchema.parse({
    id: uuid(),
    category: 'food',
    currency: 'INR',
    spentOn: '2026-11-12',
    status: 'paid',
    splitMethod: 'equal',
    notes: null,
    parts: [],
    bookingReference: null,
    createdBy: { id: PERSON.asha, name: 'Asha Rao', isYou: true },
    canEdit: true,
    version: 1,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

const sum = (values: bigint[]) => values.reduce((s, v) => s + v, 0n);

export function createFakeBudgetApi(
  initial: Record<string, FakeBudgetState>,
  ok: (data: unknown, status?: number) => Response,
  fail: (status: number, code: string, message: string) => Response,
) {
  const states = new Map(Object.entries(initial));
  const keys = new Map<string, { body: string; result: unknown }>();
  const stateFor = (trip: PlannedTrip) => {
    let s = states.get(trip.id);
    if (!s) {
      const canEdit = trip.access.canEdit;
      s = budgetState({
        people: [
          {
            id: PERSON.asha,
            name: trip.owner.name,
            initials: 'AR',
            isYou: trip.owner.isYou,
            role: 'owner',
          },
        ],
        canAddExpenses: canEdit,
        canManageBudget: canEdit,
        canRecordSettlements: canEdit,
      });
      states.set(trip.id, s);
    }
    return s;
  };

  const overview = (trip: PlannedTrip, s: FakeBudgetState) => {
    const totals = new Map<string, { recorded: bigint; planned: bigint; r: number; p: number }>();
    for (const e of s.expenses) {
      const t = totals.get(e.currency) ?? { recorded: 0n, planned: 0n, r: 0, p: 0 };
      if (e.status === 'paid') {
        t.recorded += BigInt(e.amountMinor);
        t.r += 1;
      } else {
        t.planned += BigInt(e.amountMinor);
        t.p += 1;
      }
      totals.set(e.currency, t);
    }
    let progress = null;
    if (s.budget) {
      const b = s.budget;
      const t = totals.get(b.currency) ?? { recorded: 0n, planned: 0n };
      const total = BigInt(b.totalMinor);
      const util = (t.recorded * 10_000n) / total;
      progress = {
        currency: b.currency,
        totalMinor: b.totalMinor,
        recordedMinor: String(t.recorded),
        plannedMinor: String(t.planned),
        remainingMinor: String(total - t.recorded),
        remainingAfterPlannedMinor: String(total - t.recorded - t.planned),
        utilizationBasisPoints: Number(util),
        overBudget: t.recorded > total,
        categories: EXPENSE_CATEGORIES.map((category) => {
          const inCat = s.expenses.filter(
            (e) => e.category === category && e.currency === b.currency,
          );
          return {
            category,
            budgetMinor: b.categories.find((c) => c.category === category)?.amountMinor ?? null,
            recordedMinor: String(
              sum(inCat.filter((e) => e.status === 'paid').map((e) => BigInt(e.amountMinor))),
            ),
            plannedMinor: String(
              sum(inCat.filter((e) => e.status === 'planned').map((e) => BigInt(e.amountMinor))),
            ),
          };
        }),
      };
    }
    const currencies = [...totals.keys()].sort((a, b) =>
      a === s.budget?.currency ? -1 : b === s.budget?.currency ? 1 : a.localeCompare(b),
    );
    return budgetOverviewSchema.parse({
      tripId: trip.id,
      access: trip.access,
      canAddExpenses: s.canAddExpenses,
      canManageBudget: s.canManageBudget,
      budget: s.budget,
      progress,
      totals: currencies.map((c) => ({
        currency: c,
        recordedMinor: String(totals.get(c)!.recorded),
        plannedMinor: String(totals.get(c)!.planned),
        recordedCount: totals.get(c)!.r,
        plannedCount: totals.get(c)!.p,
      })),
      people: s.people,
      bookingImport: s.bookingImport,
    });
  };

  const balances = (s: FakeBudgetState) => {
    const paid = s.expenses.filter((e) => e.status === 'paid');
    const computed = computeBalances(
      paid.map((e) => ({
        currency: e.currency,
        parts: e.parts.map((p) => ({
          personId: p.personId,
          paidMinor: BigInt(p.paidMinor),
          shareMinor: BigInt(p.shareMinor),
        })),
      })),
      s.settlements.map((x) => ({ ...x, amountMinor: BigInt(x.amountMinor) })),
    );
    return balancesSchema.parse({
      currencies: [...computed.entries()].map(([currency, people]) => ({
        currency,
        people: people.map((p) => ({
          personId: p.personId,
          paidMinor: String(p.paidMinor),
          shareMinor: String(p.shareMinor),
          sentMinor: String(p.sentMinor),
          receivedMinor: String(p.receivedMinor),
          netMinor: String(p.netMinor),
        })),
        suggestions: suggestSettlements(people).map((t) => ({
          ...t,
          amountMinor: String(t.amountMinor),
        })),
      })),
      settlements: s.settlements,
      people: s.people,
      canRecordSettlements: s.canRecordSettlements,
    });
  };

  /** The expense's parts from a create/update body, or an error message. */
  const parts = (s: FakeBudgetState, body: Record<string, unknown>): Expense['parts'] | string => {
    const amount = BigInt(String(body.amountMinor));
    const members = new Set(s.people.filter((p) => p.role !== 'former').map((p) => p.id));
    const paidBy = body.paidBy as { personId: string; amountMinor: string }[];
    const split = body.split as {
      method: 'equal' | 'custom' | 'percent';
      participants?: string[];
      shares?: { personId: string; amountMinor?: string; basisPoints?: number }[];
    };
    const shares =
      split.method === 'equal'
        ? splitEqual(amount, split.participants!)
        : split.method === 'percent'
          ? splitByBasisPoints(
              amount,
              split.shares!.map((x) => ({ personId: x.personId, basisPoints: x.basisPoints! })),
            )
          : new Map(split.shares!.map((x) => [x.personId, BigInt(x.amountMinor!)]));
    const everyone = new Set([...paidBy.map((p) => p.personId), ...shares.keys()]);
    if ([...everyone].some((id) => !members.has(id))) {
      return 'Everyone on an expense must be a member of this plan.';
    }
    if (sum(paidBy.map((p) => BigInt(p.amountMinor))) !== amount) {
      return 'What each person paid must add up to the amount.';
    }
    if (sum([...shares.values()]) !== amount) return 'The shares must add up to the amount.';
    return [...everyone].sort().map((personId) => ({
      personId,
      paidMinor: paidBy.find((p) => p.personId === personId)?.amountMinor ?? '0',
      shareMinor: String(shares.get(personId) ?? 0n),
      basisPoints:
        split.method === 'percent'
          ? (split.shares!.find((x) => x.personId === personId)?.basisPoints ?? null)
          : null,
    }));
  };

  const you = (s: FakeBudgetState) => s.people.find((p) => p.isYou);

  return {
    states,
    handle(
      trip: PlannedTrip | undefined,
      method: string,
      rest: string,
      params: URLSearchParams,
      body: Record<string, unknown> | null,
      key: string | null,
    ): Response | null {
      if (!trip) return null;
      const s = stateFor(trip);
      const replay = (run: () => { status: number; data: unknown } | Response) => {
        if (!key) return fail(400, 'BAD_REQUEST', 'Send an Idempotency-Key header.');
        const seen = keys.get(key);
        const serialized = JSON.stringify(body);
        if (seen) {
          if (seen.body !== serialized) return fail(422, 'IDEMPOTENCY_KEY_REUSED', 'Key reused.');
          return ok(seen.result, 201);
        }
        const result = run();
        if (result instanceof Response) return result;
        keys.set(key, { body: serialized, result: result.data });
        return ok(result.data, result.status);
      };

      if (rest === '/budget') {
        if (method === 'GET') return ok(overview(trip, s));
        if (!s.canManageBudget)
          return fail(403, 'FORBIDDEN', 'Only the owner and editors can change the budget.');
        if (method === 'PUT') {
          const version = body!.version as number | undefined;
          if ((s.budget && version !== s.budget.version) || (!s.budget && version !== undefined)) {
            return fail(409, 'PLAN_OUT_OF_DATE', 'The budget changed since you loaded it.');
          }
          s.budget = {
            currency: body!.currency as Budget['currency'],
            totalMinor: String(body!.totalMinor),
            categories: (body!.categories as Budget['categories']) ?? [],
            version: (s.budget?.version ?? 0) + 1,
            updatedAt: AT,
          };
          return ok(overview(trip, s));
        }
        if (method === 'DELETE') {
          if (!s.budget || Number(params.get('version')) !== s.budget.version) {
            return fail(409, 'PLAN_OUT_OF_DATE', 'The budget changed since you loaded it.');
          }
          s.budget = null;
          return ok(overview(trip, s));
        }
      }
      if (rest === '/expenses') {
        if (method === 'GET') {
          let items = [...s.expenses];
          const category = params.get('category');
          const status = params.get('status');
          const payer = params.get('payer');
          const participant = params.get('participant');
          if (category) items = items.filter((e) => e.category === category);
          if (status) items = items.filter((e) => e.status === status);
          if (payer)
            items = items.filter((e) =>
              e.parts.some((p) => p.personId === payer && p.paidMinor !== '0'),
            );
          if (participant) {
            items = items.filter((e) =>
              e.parts.some((p) => p.personId === participant && p.shareMinor !== '0'),
            );
          }
          const sort = params.get('sort') ?? 'date-desc';
          items.sort((a, b) =>
            sort === 'amount-desc'
              ? a.currency.localeCompare(b.currency) ||
                Number(BigInt(b.amountMinor) - BigInt(a.amountMinor))
              : sort === 'date-asc'
                ? a.spentOn.localeCompare(b.spentOn)
                : b.spentOn.localeCompare(a.spentOn),
          );
          return ok(
            expenseListSchema.parse({
              items,
              page: 1,
              pageSize: 100,
              total: items.length,
              people: s.people,
            }),
          );
        }
        if (method === 'POST') {
          if (!s.canAddExpenses)
            return fail(403, 'FORBIDDEN', 'Only the owner and editors can add expenses.');
          return replay(() => {
            const paid = body!.status === 'paid';
            const p = paid ? parts(s, body!) : [];
            if (typeof p === 'string') return fail(400, 'VALIDATION_FAILED', p);
            const me = you(s)!;
            const created = expense({
              description: String(body!.description).trim(),
              category: body!.category as Expense['category'],
              amountMinor: String(body!.amountMinor),
              currency: body!.currency as Expense['currency'],
              spentOn: String(body!.spentOn),
              status: paid ? 'paid' : 'planned',
              splitMethod: paid ? (body!.split as { method: Expense['splitMethod'] }).method : null,
              notes:
                typeof body!.notes === 'string' && body!.notes.trim() ? body!.notes.trim() : null,
              parts: p,
              createdBy: { id: me.id, name: me.name, isYou: true },
            });
            s.expenses.push(created);
            return { status: 201, data: created };
          });
        }
      }
      if (rest === '/expenses/from-booking' && method === 'POST') {
        return replay(() => {
          const offer = s.bookingImport;
          if (!offer) return fail(409, 'CONFLICT', 'There is no linked booking to add.');
          const me = you(s)!;
          const created = expense({
            description: `Booking ${offer.reference}`,
            category: 'hotels',
            amountMinor: offer.amountMinor,
            currency: offer.currency as Expense['currency'],
            status: offer.paid ? 'paid' : 'planned',
            splitMethod: offer.paid ? 'equal' : null,
            parts: offer.paid
              ? [
                  {
                    personId: me.id,
                    paidMinor: offer.amountMinor,
                    shareMinor: offer.amountMinor,
                    basisPoints: null,
                  },
                ]
              : [],
            notes: offer.demo ? 'Demo booking: no money was charged.' : null,
            bookingReference: offer.reference,
          });
          s.expenses.push(created);
          s.bookingImport = null;
          return { status: 201, data: created };
        });
      }
      const one = /^\/expenses\/([^/]+)$/.exec(rest);
      if (one) {
        const index = s.expenses.findIndex((e) => e.id === one[1]);
        const existing = s.expenses[index];
        if (!existing) return fail(404, 'NOT_FOUND', 'This expense doesn’t exist in this plan.');
        if (method === 'GET') return ok(existing);
        if (!existing.canEdit) return fail(403, 'FORBIDDEN', 'You can’t change this expense.');
        if (method === 'DELETE') {
          s.expenses.splice(index, 1);
          return ok({ deleted: true });
        }
        if (method === 'PUT') {
          if (body!.version !== existing.version) {
            return fail(
              409,
              'PLAN_OUT_OF_DATE',
              'Someone changed this expense since you loaded it.',
            );
          }
          const paid = body!.status === 'paid';
          const p = paid ? parts(s, body!) : [];
          if (typeof p === 'string') return fail(400, 'VALIDATION_FAILED', p);
          const updated = expenseSchema.parse({
            ...existing,
            description: String(body!.description).trim(),
            category: body!.category,
            amountMinor: String(body!.amountMinor),
            currency: body!.currency,
            spentOn: body!.spentOn,
            status: paid ? 'paid' : 'planned',
            splitMethod: paid ? (body!.split as { method: string }).method : null,
            notes:
              typeof body!.notes === 'string' && body!.notes.trim() ? body!.notes.trim() : null,
            parts: p,
            version: existing.version + 1,
          });
          s.expenses[index] = updated;
          return ok(updated);
        }
      }
      if (rest === '/balances' && method === 'GET') return ok(balances(s));
      if (rest === '/settlements' && method === 'POST') {
        return replay(() => {
          const me = you(s);
          const party = body!.fromId === me?.id || body!.toId === me?.id;
          if (!s.canRecordSettlements && !party) {
            return fail(
              403,
              'FORBIDDEN',
              'Viewers can only record payments they made or received.',
            );
          }
          s.settlements.push({
            id: uuid(),
            fromId: String(body!.fromId),
            toId: String(body!.toId),
            amountMinor: String(body!.amountMinor),
            currency: body!.currency as Settlement['currency'],
            settledOn: String(body!.settledOn),
            note: typeof body!.note === 'string' && body!.note.trim() ? body!.note.trim() : null,
            recordedBy: me ? { name: me.name, isYou: true } : null,
            canDelete: true,
            createdAt: AT,
          });
          return { status: 201, data: balances(s) };
        });
      }
      const settlement = /^\/settlements\/([^/]+)$/.exec(rest);
      if (settlement && method === 'DELETE') {
        const i = s.settlements.findIndex((x) => x.id === settlement[1]);
        if (i === -1) return fail(404, 'NOT_FOUND', 'This payment record doesn’t exist.');
        s.settlements.splice(i, 1);
        return ok(balances(s));
      }
      return null;
    },
  };
}
