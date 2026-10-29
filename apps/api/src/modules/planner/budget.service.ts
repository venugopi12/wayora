import {
  BUDGET_CURRENCY_DIGITS,
  BUDGET_LIMITS,
  EXPENSE_CATEGORIES,
  computeBalances,
  splitByBasisPoints,
  splitEqual,
  suggestSettlements,
  type Balances,
  type BudgetCurrency,
  type BudgetOverview,
  type BudgetPerson,
  type BudgetProgress,
  type CurrencyTotals,
  type Expense,
  type ExpenseCategory,
  type ExpenseList,
  type ExpenseSplitInput,
  type Settlement,
  type createExpenseSchema,
  type createSettlementSchema,
  type expenseListQuerySchema,
  type putBudgetSchema,
  type updateExpenseSchema,
} from '@wayora/contracts';
import type {
  ExpenseCategory as DbExpenseCategory,
  ExpenseSplitMethod,
  Prisma,
  PrismaClient,
  TravelCategory,
} from '@wayora/database';
import type { z } from 'zod';
import { AppError, notFound } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import { IdempotencyService, type IdempotencyMessages } from '../bookings/idempotency.js';
import { recordActivity, tripAccess, type TripContext } from './access.js';
import { runIdempotent } from './idempotent.js';
import { accessFor, initials, personName } from './people.js';
import { dateOnly, toDbDate } from './presenter.js';

/*
 * Trip budget, expenses and group split (docs/planner.md#budget).
 *
 * Permissions (the Phase 19 roles, enforced here on every request):
 * - Any member (owner, editor, viewer) sees the budget, expenses, balances
 *   and settlement suggestions.
 * - Owners and editors set the budget and add expenses. An editor may edit
 *   or delete only expenses they added; the owner may edit or delete any.
 * - Only the owner adds their linked booking as an expense.
 * - A settlement may be recorded by the owner, an editor, or either person
 *   in it; deleted by the owner or whoever recorded it.
 * - Payers and participants must be current members (an edit may keep
 *   people already on that expense who have since left).
 *
 * Money is integer minor units (BigInt) end to end. The server computes every
 * share from the requested split; a client-sent total or balance is never
 * trusted. Every write locks the plan row first (serializing concurrent
 * writes), runs in one transaction, and is recorded in the plan history
 * (which also tells collaborators' open pages to refresh).
 */

type Tx = Prisma.TransactionClient;
type CreateExpense = z.output<typeof createExpenseSchema>;
type UpdateExpense = z.output<typeof updateExpenseSchema>;
type PutBudget = z.output<typeof putBudgetSchema>;
type ExpenseListQuery = z.output<typeof expenseListQuerySchema>;
type CreateSettlement = z.output<typeof createSettlementSchema>;

const EXPENSE_NOT_FOUND = 'This expense doesn’t exist in this plan. It may have been deleted.';
const SETTLEMENT_NOT_FOUND = 'This recorded payment doesn’t exist in this plan.';

const EXPENSE_MESSAGES: IdempotencyMessages = {
  inProgress: 'This expense is already being saved. Wait a moment.',
  reused: 'This request key was already used for a different expense. Try again.',
};
const SETTLEMENT_MESSAGES: IdempotencyMessages = {
  inProgress: 'This payment is already being recorded. Wait a moment.',
  reused: 'This request key was already used for a different payment. Try again.',
};

const toDbCategory = (c: ExpenseCategory) => c.toUpperCase() as DbExpenseCategory;
const fromDbCategory = (c: DbExpenseCategory) => c.toLowerCase() as ExpenseCategory;

const validation = (path: string, message: string) =>
  new AppError('VALIDATION_FAILED', 'The request is invalid.', {
    details: [{ path, message, code: 'custom' }],
  });

/** Booking category → expense category, for adding the linked booking. */
const BOOKING_CATEGORY: Record<TravelCategory, DbExpenseCategory> = {
  FLIGHT: 'FLIGHTS',
  HOTEL: 'HOTELS',
  TRAIN: 'TRAINS',
  BUS: 'BUSES',
  METRO: 'LOCAL_TRANSPORT',
  CAB: 'LOCAL_TRANSPORT',
  HOLIDAY_PACKAGE: 'OTHER',
};

const EXPENSE_INCLUDE = {
  parts: { orderBy: { userId: 'asc' } },
  createdBy: { select: { id: true, displayName: true } },
  booking: { select: { reference: true } },
} satisfies Prisma.PlanExpenseInclude;
type ExpenseRow = Prisma.PlanExpenseGetPayload<{ include: typeof EXPENSE_INCLUDE }>;

interface Parts {
  rows: { userId: string; paidMinor: bigint; shareMinor: bigint; basisPoints: number | null }[];
  method: ExpenseSplitMethod | null;
}

export class BudgetService {
  private readonly prisma: PrismaClient;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly idempotency: IdempotencyService;

  constructor(options: { prisma: PrismaClient; logger: Logger; now?: () => Date }) {
    this.prisma = options.prisma;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.idempotency = new IdempotencyService(this.prisma, this.now);
  }

  // ─── Overview ─────────────────────────────────────────────────────────

  async overview(userId: string, tripId: string): Promise<BudgetOverview> {
    const trip = await tripAccess(this.prisma, userId, tripId, 'view');
    const [budget, grouped, people, bookingImport] = await Promise.all([
      this.prisma.planBudget.findUnique({ where: { tripId }, include: { categories: true } }),
      this.prisma.planExpense.groupBy({
        by: ['currency', 'status', 'category'],
        where: { tripId },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      this.people(this.prisma, trip, userId),
      trip.role === 'owner' ? this.bookingImportOffer(this.prisma, trip) : Promise.resolve(null),
    ]);

    // Totals per currency (never mixed).
    const totals = new Map<string, CurrencyTotals>();
    const totalsFor = (currency: string) => {
      let t = totals.get(currency);
      if (!t) {
        t = {
          currency: currency as BudgetCurrency,
          recordedMinor: '0',
          plannedMinor: '0',
          recordedCount: 0,
          plannedCount: 0,
        };
        totals.set(currency, t);
      }
      return t;
    };
    for (const g of grouped) {
      const t = totalsFor(g.currency);
      const amount = g._sum.amountMinor ?? 0n;
      if (g.status === 'PAID') {
        t.recordedMinor = (BigInt(t.recordedMinor) + amount).toString();
        t.recordedCount += g._count._all;
      } else {
        t.plannedMinor = (BigInt(t.plannedMinor) + amount).toString();
        t.plannedCount += g._count._all;
      }
    }

    let progress: BudgetProgress | null = null;
    if (budget) {
      const inCurrency = grouped.filter((g) => g.currency === budget.currency);
      const sumWhere = (status: 'PAID' | 'PLANNED', category?: DbExpenseCategory) =>
        inCurrency
          .filter((g) => g.status === status && (!category || g.category === category))
          .reduce((s, g) => s + (g._sum.amountMinor ?? 0n), 0n);
      const total = budget.totalAmountMinor;
      const recorded = sumWhere('PAID');
      const planned = sumWhere('PLANNED');
      const categoryBudgets = new Map(budget.categories.map((c) => [c.category, c.amountMinor]));
      progress = {
        currency: budget.currency as BudgetCurrency,
        totalMinor: total.toString(),
        recordedMinor: recorded.toString(),
        plannedMinor: planned.toString(),
        remainingMinor: (total - recorded).toString(),
        remainingAfterPlannedMinor: (total - recorded - planned).toString(),
        // Integer basis points, rounded down: no floating point.
        utilizationBasisPoints: Number((recorded * 10_000n) / total),
        overBudget: recorded > total,
        categories: EXPENSE_CATEGORIES.map((category) => {
          const db = toDbCategory(category);
          return {
            category,
            budgetMinor: categoryBudgets.get(db)?.toString() ?? null,
            recordedMinor: sumWhere('PAID', db).toString(),
            plannedMinor: sumWhere('PLANNED', db).toString(),
          };
        }).filter(
          (c) => c.budgetMinor !== null || c.recordedMinor !== '0' || c.plannedMinor !== '0',
        ),
      };
    }

    const ordered = [...totals.values()].sort((a, b) =>
      a.currency === budget?.currency
        ? -1
        : b.currency === budget?.currency
          ? 1
          : a.currency < b.currency
            ? -1
            : 1,
    );
    const canEdit = trip.role !== 'viewer';
    return {
      tripId,
      access: accessFor(trip.role),
      canAddExpenses: canEdit,
      canManageBudget: canEdit,
      budget: budget
        ? {
            currency: budget.currency as BudgetCurrency,
            totalMinor: budget.totalAmountMinor.toString(),
            categories: budget.categories
              .map((c) => ({
                category: fromDbCategory(c.category),
                amountMinor: c.amountMinor.toString(),
              }))
              .sort(
                (a, b) =>
                  EXPENSE_CATEGORIES.indexOf(a.category) - EXPENSE_CATEGORIES.indexOf(b.category),
              ),
            version: budget.version,
            updatedAt: budget.updatedAt.toISOString(),
          }
        : null,
      progress,
      totals: ordered,
      people: [...people.values()],
      bookingImport,
    };
  }

  // ─── Budget ───────────────────────────────────────────────────────────

  /** Creates or replaces the budget (owner, editors). Expenses are never changed by it. */
  async putBudget(userId: string, tripId: string, input: PutBudget): Promise<BudgetOverview> {
    await this.prisma.$transaction(async (tx) => {
      const trip = await tripAccess(tx, userId, tripId, 'edit', { lock: true });
      const existing = await tx.planBudget.findUnique({ where: { tripId } });
      if (existing && input.version !== existing.version) {
        throw new AppError(
          'PLAN_OUT_OF_DATE',
          'Someone else changed the budget since you opened it. Load the latest budget, then make your change again.',
          { details: [{ path: 'body.version', message: 'Stale version', code: 'stale_version' }] },
        );
      }
      if (!existing && input.version !== undefined) {
        throw new AppError('PLAN_OUT_OF_DATE', 'This budget was removed. Load the plan again.', {
          details: [{ path: 'body.version', message: 'No budget', code: 'stale_version' }],
        });
      }
      const total = BigInt(input.totalMinor);
      for (const [i, c] of input.categories.entries()) {
        if (BigInt(c.amountMinor) > total) {
          throw validation(
            `body.categories.${i}.amountMinor`,
            'A category budget can’t be more than the whole budget.',
          );
        }
      }
      const now = this.now();
      if (existing) {
        await tx.planBudget.update({
          where: { tripId },
          data: {
            currency: input.currency,
            totalAmountMinor: total,
            version: { increment: 1 },
            updatedAt: now,
          },
        });
        await tx.planCategoryBudget.deleteMany({ where: { tripId } });
      } else {
        await tx.planBudget.create({
          data: {
            tripId,
            currency: input.currency,
            totalAmountMinor: total,
            createdAt: now,
            updatedAt: now,
          },
        });
      }
      if (input.categories.length > 0) {
        await tx.planCategoryBudget.createMany({
          data: input.categories.map((c) => ({
            tripId,
            category: toDbCategory(c.category),
            amountMinor: BigInt(c.amountMinor),
          })),
        });
      }
      await recordActivity(tx, {
        tripId: trip.id,
        actorId: userId,
        type: 'BUDGET_UPDATED',
        data: { totalMinor: input.totalMinor, currency: input.currency },
        now,
      });
    });
    return this.overview(userId, tripId);
  }

  async removeBudget(userId: string, tripId: string, version: number): Promise<BudgetOverview> {
    await this.prisma.$transaction(async (tx) => {
      const trip = await tripAccess(tx, userId, tripId, 'edit', { lock: true });
      const existing = await tx.planBudget.findUnique({ where: { tripId } });
      if (!existing) throw notFound('This plan has no budget.');
      if (existing.version !== version) {
        throw new AppError(
          'PLAN_OUT_OF_DATE',
          'Someone else changed the budget since you opened it. Load the latest budget first.',
        );
      }
      await tx.planBudget.delete({ where: { tripId } });
      await recordActivity(tx, {
        tripId: trip.id,
        actorId: userId,
        type: 'BUDGET_REMOVED',
        data: {},
        now: this.now(),
      });
    });
    return this.overview(userId, tripId);
  }

  // ─── Expenses ─────────────────────────────────────────────────────────

  async listExpenses(
    userId: string,
    tripId: string,
    query: ExpenseListQuery,
  ): Promise<ExpenseList> {
    const trip = await tripAccess(this.prisma, userId, tripId, 'view');
    const where: Prisma.PlanExpenseWhereInput = {
      tripId,
      ...(query.category ? { category: toDbCategory(query.category) } : {}),
      ...(query.status ? { status: query.status === 'paid' ? 'PAID' : 'PLANNED' } : {}),
      ...(query.currency ? { currency: query.currency } : {}),
      ...(query.from || query.to
        ? {
            spentOn: {
              ...(query.from ? { gte: toDbDate(query.from) } : {}),
              ...(query.to ? { lte: toDbDate(query.to) } : {}),
            },
          }
        : {}),
      ...(query.payer || query.participant
        ? {
            AND: [
              ...(query.payer
                ? [{ parts: { some: { userId: query.payer, paidMinor: { gt: 0n } } } }]
                : []),
              ...(query.participant
                ? [{ parts: { some: { userId: query.participant, shareMinor: { gt: 0n } } } }]
                : []),
            ],
          }
        : {}),
    };
    const orderBy: Prisma.PlanExpenseOrderByWithRelationInput[] =
      query.sort === 'date-asc'
        ? [{ spentOn: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }]
        : query.sort === 'amount-desc'
          ? [{ currency: 'asc' }, { amountMinor: 'desc' }, { id: 'asc' }]
          : [{ spentOn: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }];
    const [rows, total, people] = await Promise.all([
      this.prisma.planExpense.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: EXPENSE_INCLUDE,
      }),
      this.prisma.planExpense.count({ where }),
      this.people(this.prisma, trip, userId),
    ]);
    return {
      items: rows.map((r) => this.presentExpense(r, trip, userId)),
      page: query.page,
      pageSize: query.pageSize,
      total,
      people: [...people.values()],
    };
  }

  async getExpense(userId: string, tripId: string, expenseId: string): Promise<Expense> {
    const trip = await tripAccess(this.prisma, userId, tripId, 'view');
    const row = await this.prisma.planExpense.findFirst({
      where: { id: expenseId, tripId },
      include: EXPENSE_INCLUDE,
    });
    if (!row) throw notFound(EXPENSE_NOT_FOUND);
    return this.presentExpense(row, trip, userId);
  }

  async createExpense(
    userId: string,
    tripId: string,
    input: CreateExpense,
    key: string,
  ): Promise<{ expense: Expense; replayed: boolean }> {
    const result = await runIdempotent(
      this.idempotency,
      this.logger,
      {
        operation: 'plan-expense',
        userId,
        key,
        payload: { tripId, ...input },
        messages: EXPENSE_MESSAGES,
      },
      (complete) =>
        this.prisma.$transaction(async (tx) => {
          const trip = await tripAccess(tx, userId, tripId, 'edit', { lock: true });
          await this.checkExpenseLimit(tx, tripId);
          const members = await this.memberIds(tx, trip);
          const parts = this.buildParts(input, members, new Set());
          const now = this.now();
          const expense = await tx.planExpense.create({
            data: {
              tripId,
              description: input.description,
              category: toDbCategory(input.category),
              amountMinor: BigInt(input.amountMinor),
              currency: input.currency,
              spentOn: toDbDate(input.spentOn),
              status: input.status === 'paid' ? 'PAID' : 'PLANNED',
              splitMethod: parts.method,
              notes: input.notes ?? null,
              createdById: userId,
              createdAt: now,
              updatedAt: now,
            },
            select: { id: true },
          });
          if (parts.rows.length > 0) {
            await tx.planExpensePart.createMany({
              data: parts.rows.map((p) => ({ expenseId: expense.id, ...p })),
            });
          }
          await recordActivity(tx, {
            tripId,
            actorId: userId,
            type: 'EXPENSE_ADDED',
            data: this.activityData(expense.id, input),
            now,
          });
          await complete(tx, expense.id);
          return expense.id;
        }),
    );
    return { expense: await this.getExpense(userId, tripId, result.id), replayed: result.replayed };
  }

  /**
   * Replaces an expense and its split (owner: any expense; editor: their own).
   * Every field and the whole split are sent again, so nothing is changed
   * silently; the old parts are replaced in the same transaction.
   */
  async updateExpense(
    userId: string,
    tripId: string,
    expenseId: string,
    input: UpdateExpense,
  ): Promise<Expense> {
    await this.prisma.$transaction(async (tx) => {
      const trip = await tripAccess(tx, userId, tripId, 'edit', { lock: true });
      const existing = await tx.planExpense.findFirst({
        where: { id: expenseId, tripId },
        include: { parts: { select: { userId: true } } },
      });
      if (!existing) throw notFound(EXPENSE_NOT_FOUND);
      this.checkCanChange(trip, existing.createdById, userId);
      if (existing.version !== input.version) {
        throw new AppError(
          'PLAN_OUT_OF_DATE',
          'Someone else changed this expense since you opened it. Load the latest version, then make your change again.',
          { details: [{ path: 'body.version', message: 'Stale version', code: 'stale_version' }] },
        );
      }
      if (
        existing.bookingId &&
        (input.amountMinor !== existing.amountMinor.toString() ||
          input.currency !== existing.currency)
      ) {
        throw validation(
          'body.amountMinor',
          'This expense comes from a booking: its amount and currency can’t change.',
        );
      }
      const members = await this.memberIds(tx, trip);
      const parts = this.buildParts(input, members, new Set(existing.parts.map((p) => p.userId)));
      await tx.planExpensePart.deleteMany({ where: { expenseId } });
      await tx.planExpense.update({
        where: { id: expenseId },
        data: {
          description: input.description,
          category: toDbCategory(input.category),
          amountMinor: BigInt(input.amountMinor),
          currency: input.currency,
          spentOn: toDbDate(input.spentOn),
          status: input.status === 'paid' ? 'PAID' : 'PLANNED',
          splitMethod: parts.method,
          notes: input.notes ?? null,
          version: { increment: 1 },
          updatedAt: this.now(),
        },
      });
      if (parts.rows.length > 0) {
        await tx.planExpensePart.createMany({
          data: parts.rows.map((p) => ({ expenseId, ...p })),
        });
      }
      await recordActivity(tx, {
        tripId,
        actorId: userId,
        type: 'EXPENSE_UPDATED',
        data: this.activityData(expenseId, input),
        now: this.now(),
      });
    });
    return this.getExpense(userId, tripId, expenseId);
  }

  async deleteExpense(userId: string, tripId: string, expenseId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const trip = await tripAccess(tx, userId, tripId, 'edit', { lock: true });
      const existing = await tx.planExpense.findFirst({ where: { id: expenseId, tripId } });
      if (!existing) throw notFound(EXPENSE_NOT_FOUND);
      this.checkCanChange(trip, existing.createdById, userId);
      await tx.planExpense.delete({ where: { id: expenseId } });
      await recordActivity(tx, {
        tripId,
        actorId: userId,
        type: 'EXPENSE_DELETED',
        data: {
          expenseId,
          description: existing.description,
          amountMinor: existing.amountMinor.toString(),
          currency: existing.currency,
        },
        now: this.now(),
      });
    });
  }

  /**
   * Adds the owner's linked booking as an expense, once (owner only). It is
   * `paid` only when a real (non-demo) payment for it succeeded; demo
   * bookings move no money, so they are added as `planned`.
   */
  async addBookingExpense(
    userId: string,
    tripId: string,
    split: ExpenseSplitInput | undefined,
    key: string,
  ): Promise<{ expense: Expense; replayed: boolean }> {
    const result = await runIdempotent(
      this.idempotency,
      this.logger,
      {
        operation: 'plan-expense-booking',
        userId,
        key,
        payload: { tripId, split },
        messages: EXPENSE_MESSAGES,
      },
      (complete) =>
        this.prisma.$transaction(async (tx) => {
          const trip = await tripAccess(tx, userId, tripId, 'manage', { lock: true });
          const offer = await this.bookingImportOffer(tx, trip);
          if (!offer) {
            throw new AppError(
              'CONFLICT',
              'There’s no linked booking to add: link a confirmed booking with a fixed price first, or it was already added.',
            );
          }
          await this.checkExpenseLimit(tx, tripId);
          const booking = await tx.booking.findUniqueOrThrow({
            where: { reference: offer.reference },
            select: { id: true, category: true, startsOn: true },
          });
          const members = await this.memberIds(tx, trip);
          const input = {
            description: `Booking ${offer.reference}${offer.demo ? ' (demo booking)' : ''}`,
            category: BOOKING_CATEGORY[booking.category].toLowerCase() as ExpenseCategory,
            amountMinor: offer.amountMinor,
            currency: offer.currency as BudgetCurrency,
            spentOn: booking.startsOn ? dateOnly(booking.startsOn) : dateOnly(this.now()),
            status: offer.paid ? ('paid' as const) : ('planned' as const),
            notes: offer.demo ? 'Demo booking: no money was charged.' : null,
            ...(offer.paid
              ? {
                  paidBy: [{ personId: trip.ownerId, amountMinor: offer.amountMinor }],
                  split: split ?? { method: 'equal' as const, participants: [...members] },
                }
              : {}),
          };
          if (!offer.paid && split) {
            throw validation(
              'body.split',
              'This booking isn’t paid, so it’s added as planned and isn’t split.',
            );
          }
          const parts = this.buildParts(input, members, new Set());
          const now = this.now();
          const expense = await tx.planExpense.create({
            data: {
              tripId,
              description: input.description,
              category: toDbCategory(input.category),
              amountMinor: BigInt(input.amountMinor),
              currency: input.currency,
              spentOn: toDbDate(input.spentOn),
              status: offer.paid ? 'PAID' : 'PLANNED',
              splitMethod: parts.method,
              notes: input.notes,
              bookingId: booking.id,
              createdById: userId,
              createdAt: now,
              updatedAt: now,
            },
            select: { id: true },
          });
          if (parts.rows.length > 0) {
            await tx.planExpensePart.createMany({
              data: parts.rows.map((p) => ({ expenseId: expense.id, ...p })),
            });
          }
          await recordActivity(tx, {
            tripId,
            actorId: userId,
            type: 'EXPENSE_ADDED',
            data: this.activityData(expense.id, input),
            now,
          });
          await complete(tx, expense.id);
          return expense.id;
        }),
    );
    return { expense: await this.getExpense(userId, tripId, result.id), replayed: result.replayed };
  }

  // ─── Balances and settlements ────────────────────────────────────────

  /**
   * Balances per currency from paid expenses and recorded settlements (both
   * read from the database), with suggested transfers. Nothing is converted.
   */
  async balances(userId: string, tripId: string): Promise<Balances> {
    const trip = await tripAccess(this.prisma, userId, tripId, 'view');
    const [expenses, settlements, people] = await Promise.all([
      this.prisma.planExpense.findMany({
        where: { tripId, status: 'PAID' },
        select: {
          currency: true,
          parts: { select: { userId: true, paidMinor: true, shareMinor: true } },
        },
        take: BUDGET_LIMITS.maxExpensesPerTrip,
      }),
      this.prisma.planSettlement.findMany({
        where: { tripId },
        orderBy: [{ settledOn: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: BUDGET_LIMITS.maxSettlementsPerTrip,
        include: { recordedBy: { select: { id: true, displayName: true } } },
      }),
      this.people(this.prisma, trip, userId),
    ]);
    const ledger = computeBalances(
      expenses.map((e) => ({
        currency: e.currency,
        parts: e.parts.map((p) => ({
          personId: p.userId,
          paidMinor: p.paidMinor,
          shareMinor: p.shareMinor,
        })),
      })),
      settlements.map((s) => ({
        currency: s.currency,
        fromId: s.fromUserId,
        toId: s.toUserId,
        amountMinor: s.amountMinor,
      })),
    );
    const currencies = [...ledger.entries()].map(([currency, rows]) => ({
      currency: currency as BudgetCurrency,
      people: rows.map((r) => ({
        personId: r.personId,
        paidMinor: r.paidMinor.toString(),
        shareMinor: r.shareMinor.toString(),
        sentMinor: r.sentMinor.toString(),
        receivedMinor: r.receivedMinor.toString(),
        netMinor: r.netMinor.toString(),
      })),
      suggestions: suggestSettlements(rows).map((t) => ({
        fromId: t.fromId,
        toId: t.toId,
        amountMinor: t.amountMinor.toString(),
      })),
    }));
    return {
      currencies,
      settlements: settlements.map((s) => this.presentSettlement(s, trip, userId)),
      people: [...people.values()],
      canRecordSettlements: true,
    };
  }

  /**
   * Records that one person paid another outside Wayora. The owner and
   * editors may record any; a viewer only one they are part of.
   */
  async createSettlement(
    userId: string,
    tripId: string,
    input: CreateSettlement,
    key: string,
  ): Promise<{ balances: Balances; replayed: boolean }> {
    const result = await runIdempotent(
      this.idempotency,
      this.logger,
      {
        operation: 'plan-settlement',
        userId,
        key,
        payload: { tripId, ...input },
        messages: SETTLEMENT_MESSAGES,
      },
      (complete) =>
        this.prisma.$transaction(async (tx) => {
          const trip = await tripAccess(tx, userId, tripId, 'view', { lock: true });
          if (trip.role === 'viewer' && userId !== input.fromId && userId !== input.toId) {
            throw new AppError(
              'FORBIDDEN',
              'Viewers can only record payments they made or received.',
            );
          }
          const members = await this.memberIds(tx, trip);
          for (const [field, id] of [
            ['fromId', input.fromId],
            ['toId', input.toId],
          ] as const) {
            if (!members.has(id)) throw validation(`body.${field}`, 'Choose someone on this plan.');
          }
          const count = await tx.planSettlement.count({ where: { tripId } });
          if (count >= BUDGET_LIMITS.maxSettlementsPerTrip) {
            throw new AppError('PLAN_LIMIT_REACHED', 'This plan has too many recorded payments.');
          }
          const now = this.now();
          const settlement = await tx.planSettlement.create({
            data: {
              tripId,
              fromUserId: input.fromId,
              toUserId: input.toId,
              amountMinor: BigInt(input.amountMinor),
              currency: input.currency,
              settledOn: toDbDate(input.settledOn),
              note: input.note ?? null,
              recordedById: userId,
              createdAt: now,
            },
            select: { id: true },
          });
          await recordActivity(tx, {
            tripId,
            actorId: userId,
            type: 'SETTLEMENT_RECORDED',
            data: {
              settlementId: settlement.id,
              fromId: input.fromId,
              toId: input.toId,
              amountMinor: input.amountMinor,
              currency: input.currency,
            },
            now,
          });
          await complete(tx, settlement.id);
          return settlement.id;
        }),
    );
    return { balances: await this.balances(userId, tripId), replayed: result.replayed };
  }

  async deleteSettlement(userId: string, tripId: string, settlementId: string): Promise<Balances> {
    await this.prisma.$transaction(async (tx) => {
      const trip = await tripAccess(tx, userId, tripId, 'view', { lock: true });
      const settlement = await tx.planSettlement.findFirst({ where: { id: settlementId, tripId } });
      if (!settlement) throw notFound(SETTLEMENT_NOT_FOUND);
      if (trip.role !== 'owner' && settlement.recordedById !== userId) {
        throw new AppError(
          'FORBIDDEN',
          'Only the person who recorded this payment, or the plan’s owner, can delete it.',
        );
      }
      await tx.planSettlement.delete({ where: { id: settlementId } });
      await recordActivity(tx, {
        tripId,
        actorId: userId,
        type: 'SETTLEMENT_DELETED',
        data: {
          settlementId,
          amountMinor: settlement.amountMinor.toString(),
          currency: settlement.currency,
        },
        now: this.now(),
      });
    });
    return this.balances(userId, tripId);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  /** The owner and current members' account ids. */
  private async memberIds(db: PrismaClient | Tx, trip: TripContext): Promise<Set<string>> {
    const members = await db.tripMember.findMany({
      where: { tripId: trip.id },
      select: { userId: true },
    });
    return new Set([trip.ownerId, ...members.map((m) => m.userId)]);
  }

  /**
   * Everyone who can appear on this plan's money: the owner and current
   * members, plus former members still on expenses or settlements (shown as
   * "former"). Display names only — never email addresses.
   */
  private async people(
    db: PrismaClient | Tx,
    trip: TripContext,
    viewerId: string,
  ): Promise<Map<string, BudgetPerson>> {
    const [members, partUsers, settlementUsers] = await Promise.all([
      db.tripMember.findMany({ where: { tripId: trip.id }, select: { userId: true, role: true } }),
      db.planExpensePart.findMany({
        where: { expense: { tripId: trip.id } },
        distinct: ['userId'],
        select: { userId: true },
      }),
      db.planSettlement.findMany({
        where: { tripId: trip.id },
        select: { fromUserId: true, toUserId: true },
        take: BUDGET_LIMITS.maxSettlementsPerTrip,
      }),
    ]);
    const roles = new Map<string, BudgetPerson['role']>([[trip.ownerId, 'owner']]);
    for (const m of members) roles.set(m.userId, m.role === 'EDITOR' ? 'editor' : 'viewer');
    const ids = new Set([
      ...roles.keys(),
      ...partUsers.map((p) => p.userId),
      ...settlementUsers.flatMap((s) => [s.fromUserId, s.toUserId]),
    ]);
    const users = await db.user.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, displayName: true },
    });
    const order: Record<BudgetPerson['role'], number> = {
      owner: 0,
      editor: 1,
      viewer: 1,
      former: 2,
    };
    const people = users
      .map((u) => {
        const name = personName(u.displayName);
        return {
          id: u.id,
          name,
          initials: initials(name),
          isYou: u.id === viewerId,
          role: roles.get(u.id) ?? ('former' as const),
        };
      })
      .sort(
        (a, b) =>
          order[a.role] - order[b.role] || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1),
      );
    return new Map(people.map((p) => [p.id, p]));
  }

  /** Owner, or an editor changing an expense they added. */
  private checkCanChange(trip: TripContext, createdById: string | null, userId: string): void {
    if (trip.role === 'owner') return;
    if (createdById !== userId) {
      throw new AppError(
        'FORBIDDEN',
        'You can only change expenses you added. Ask the plan’s owner to change this one.',
      );
    }
  }

  private async checkExpenseLimit(tx: Tx, tripId: string): Promise<void> {
    const count = await tx.planExpense.count({ where: { tripId } });
    if (count >= BUDGET_LIMITS.maxExpensesPerTrip) {
      throw new AppError(
        'PLAN_LIMIT_REACHED',
        `A plan can hold up to ${BUDGET_LIMITS.maxExpensesPerTrip} expenses.`,
      );
    }
  }

  /**
   * The parts of an expense, computed on the server from the requested payers
   * and split. Every person must be a current member (or, when editing,
   * already on this expense). Payers and shares must each add up to the
   * amount exactly; a person's paid and share go in one row.
   */
  private buildParts(
    input: {
      amountMinor: string;
      status: 'paid' | 'planned';
      paidBy?: { personId: string; amountMinor: string }[] | undefined;
      split?: ExpenseSplitInput | undefined;
    },
    members: ReadonlySet<string>,
    alreadyOnExpense: ReadonlySet<string>,
  ): Parts {
    if (input.status === 'planned' || !input.paidBy || !input.split)
      return { rows: [], method: null };
    const amount = BigInt(input.amountMinor);
    const allowed = (id: string) => members.has(id) || alreadyOnExpense.has(id);

    const paid = new Map<string, bigint>();
    for (const [i, p] of input.paidBy.entries()) {
      if (!allowed(p.personId))
        throw validation(`body.paidBy.${i}.personId`, 'Choose someone on this plan.');
      if (paid.has(p.personId))
        throw validation(`body.paidBy.${i}.personId`, 'Each payer may appear only once.');
      paid.set(p.personId, BigInt(p.amountMinor));
    }
    const paidTotal = [...paid.values()].reduce((s, v) => s + v, 0n);
    if (paidTotal !== amount) {
      throw validation('body.paidBy', 'What each person paid must add up exactly to the amount.');
    }

    const split = input.split;
    let shares: Map<string, bigint>;
    const basisPoints = new Map<string, number>();
    let method: ExpenseSplitMethod;
    if (split.method === 'equal') {
      split.participants.forEach((id, i) => {
        if (!allowed(id))
          throw validation(`body.split.participants.${i}`, 'Choose someone on this plan.');
      });
      shares = splitEqual(amount, split.participants);
      method = 'EQUAL';
    } else if (split.method === 'custom') {
      const ids = new Set<string>();
      shares = new Map();
      split.shares.forEach((s, i) => {
        if (!allowed(s.personId))
          throw validation(`body.split.shares.${i}.personId`, 'Choose someone on this plan.');
        if (ids.has(s.personId))
          throw validation(`body.split.shares.${i}.personId`, 'Each person may appear only once.');
        ids.add(s.personId);
        shares.set(s.personId, BigInt(s.amountMinor));
      });
      const total = [...shares.values()].reduce((s, v) => s + v, 0n);
      if (total !== amount) {
        throw validation('body.split', 'The shares must add up exactly to the amount.');
      }
      method = 'CUSTOM';
    } else {
      const ids = new Set<string>();
      split.shares.forEach((s, i) => {
        if (!allowed(s.personId))
          throw validation(`body.split.shares.${i}.personId`, 'Choose someone on this plan.');
        if (ids.has(s.personId))
          throw validation(`body.split.shares.${i}.personId`, 'Each person may appear only once.');
        ids.add(s.personId);
        basisPoints.set(s.personId, s.basisPoints);
      });
      if (split.shares.reduce((s, x) => s + x.basisPoints, 0) !== 10_000) {
        throw validation('body.split', 'The percentages must add up to exactly 100%.');
      }
      shares = splitByBasisPoints(amount, split.shares);
      method = 'PERCENT';
    }

    const ids = new Set([...paid.keys(), ...shares.keys()]);
    const rows = [...ids]
      .sort()
      .map((id) => ({
        userId: id,
        paidMinor: paid.get(id) ?? 0n,
        shareMinor: shares.get(id) ?? 0n,
        basisPoints: basisPoints.get(id) ?? null,
      }))
      // A one-paisa expense split three ways leaves two people with nothing:
      // they get no row (a row must pay or owe something).
      .filter((r) => r.paidMinor > 0n || r.shareMinor > 0n);
    return { rows, method };
  }

  /** Safe history details: no notes, no payer names (ids only). */
  private activityData(
    expenseId: string,
    input: { description: string; amountMinor: string; currency: string; status: string },
  ): Record<string, unknown> {
    return {
      expenseId,
      description: input.description,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: input.status,
    };
  }

  /** The owner's linked booking, if it can be added (fixed price, supported currency, not yet added). */
  private async bookingImportOffer(
    db: PrismaClient | Tx,
    trip: TripContext,
  ): Promise<BudgetOverview['bookingImport']> {
    const plan = await db.plannedTrip.findUnique({
      where: { id: trip.id },
      select: {
        booking: {
          select: {
            id: true,
            reference: true,
            totalAmountMinor: true,
            currency: true,
            isDemo: true,
            payments: { where: { status: 'SUCCEEDED' }, select: { id: true }, take: 1 },
          },
        },
      },
    });
    const booking = plan?.booking;
    if (!booking || booking.totalAmountMinor === null || booking.totalAmountMinor <= 0n)
      return null;
    if (!(booking.currency in BUDGET_CURRENCY_DIGITS)) return null;
    const already = await db.planExpense.count({
      where: { tripId: trip.id, bookingId: booking.id },
    });
    if (already > 0) return null;
    return {
      reference: booking.reference,
      amountMinor: booking.totalAmountMinor.toString(),
      currency: booking.currency,
      // Only a confirmed, real payment makes it "paid"; a demo payment moved no money.
      paid: !booking.isDemo && booking.payments.length > 0,
      demo: booking.isDemo,
    };
  }

  private presentExpense(row: ExpenseRow, trip: TripContext, viewerId: string): Expense {
    return {
      id: row.id,
      description: row.description,
      category: fromDbCategory(row.category),
      amountMinor: row.amountMinor.toString(),
      currency: row.currency as BudgetCurrency,
      spentOn: dateOnly(row.spentOn),
      status: row.status === 'PAID' ? 'paid' : 'planned',
      splitMethod: row.splitMethod
        ? (row.splitMethod.toLowerCase() as Expense['splitMethod'])
        : null,
      notes: row.notes,
      parts: row.parts.map((p) => ({
        personId: p.userId,
        paidMinor: p.paidMinor.toString(),
        shareMinor: p.shareMinor.toString(),
        basisPoints: p.basisPoints,
      })),
      bookingReference: row.booking?.reference ?? null,
      createdBy: row.createdBy
        ? {
            id: row.createdBy.id,
            name: personName(row.createdBy.displayName),
            isYou: row.createdBy.id === viewerId,
          }
        : null,
      canEdit: trip.role === 'owner' || (trip.role === 'editor' && row.createdById === viewerId),
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private presentSettlement(
    row: Prisma.PlanSettlementGetPayload<{
      include: { recordedBy: { select: { id: true; displayName: true } } };
    }>,
    trip: TripContext,
    viewerId: string,
  ): Settlement {
    return {
      id: row.id,
      fromId: row.fromUserId,
      toId: row.toUserId,
      amountMinor: row.amountMinor.toString(),
      currency: row.currency as BudgetCurrency,
      settledOn: dateOnly(row.settledOn),
      note: row.note,
      recordedBy: row.recordedBy
        ? { name: personName(row.recordedBy.displayName), isYou: row.recordedBy.id === viewerId }
        : null,
      canDelete: trip.role === 'owner' || row.recordedById === viewerId,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
