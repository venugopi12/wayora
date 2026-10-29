import { z } from 'zod';
import { isoDateSchema, offsetDateTimeSchema } from './search/common.js';
import { plannedTripIdSchema, tripAccessSchema } from './planner.js';

/*
 * Trip budget, expenses and group split (Phase 20, docs/planner.md#budget).
 *
 * Money rules (same as the rest of Wayora, money.ts):
 * - Amounts are integer MINOR units (paise, cents) sent as strings and
 *   computed with BigInt. No floating point touches an amount.
 * - Every amount keeps its own currency. Amounts in different currencies are
 *   never added together: there is no exchange-rate source, so totals,
 *   budgets and balances are reported per currency.
 * - Splits always add up exactly to the expense amount. When an amount can't
 *   be divided evenly, the leftover minor units go to participants in a
 *   fixed, documented order (see splitEqual / splitByBasisPoints).
 *
 * Wayora records who paid what and suggests how to settle up. It never moves
 * money: settlements are paid outside Wayora and only recorded here.
 */

// ─── Currencies ──────────────────────────────────────────────────────────

/**
 * Currencies expenses and budgets can use, with their minor-unit digits
 * (ISO 4217). Explicit so parsing never depends on the runtime's Intl data.
 */
export const BUDGET_CURRENCY_DIGITS = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  SGD: 2,
} as const;
export const BUDGET_CURRENCIES = Object.keys(
  BUDGET_CURRENCY_DIGITS,
) as (keyof typeof BUDGET_CURRENCY_DIGITS)[];
export const budgetCurrencySchema = z.enum(
  BUDGET_CURRENCIES as [BudgetCurrency, ...BudgetCurrency[]],
  {
    error: `Choose one of ${Object.keys(BUDGET_CURRENCY_DIGITS).join(', ')}.`,
  },
);
export type BudgetCurrency = keyof typeof BUDGET_CURRENCY_DIGITS;

export const BUDGET_LIMITS = {
  /** Largest single amount, in minor units (10,000,000,000.00). */
  maxAmountMinor: 1_000_000_000_000n,
  maxExpensesPerTrip: 500,
  maxSettlementsPerTrip: 500,
} as const;

/** A positive amount in minor units, as an integer string. */
export const positiveMinorSchema = z
  .string({ error: 'Enter an amount.' })
  .regex(/^[1-9]\d{0,12}$/, { error: 'Enter an amount above zero.', abort: true })
  .refine((v) => BigInt(v) <= BUDGET_LIMITS.maxAmountMinor, 'That amount is too large.');

/**
 * Parses what a person typed ("1,499.5", "1499.50", "₹ 200") into minor units
 * for `currency`, exactly (string arithmetic only). Null when it isn't a valid,
 * positive amount with at most the currency's number of decimals.
 */
export function parseMoneyInput(text: string, currency: BudgetCurrency): string | null {
  const digits = BUDGET_CURRENCY_DIGITS[currency];
  const cleaned = text.replace(/[\s,₹$€£]|[A-Z]{3}/g, '');
  const match = new RegExp(`^(\\d{1,13})(?:\\.(\\d{0,${digits}}))?$`).exec(cleaned);
  if (!match) return null;
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(digits, '0');
  const minor = BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction || '0');
  if (minor <= 0n || minor > BUDGET_LIMITS.maxAmountMinor) return null;
  return minor.toString();
}

/** Minor units as a plain decimal string for an input field ("149950" → "1499.50"). */
export function minorToInput(amountMinor: string, currency: BudgetCurrency): string {
  const digits = BUDGET_CURRENCY_DIGITS[currency];
  const value = BigInt(amountMinor);
  const factor = 10n ** BigInt(digits);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const fraction = (abs % factor).toString().padStart(digits, '0');
  return `${negative ? '-' : ''}${abs / factor}${digits ? `.${fraction}` : ''}`;
}

/** Parses a percentage ("33.33", "50") into basis points (1% = 100). */
export function parsePercentInput(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{0,2}))?$/.exec(text.trim().replace('%', ''));
  if (!match) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || '0');
  return bp > 0 && bp <= 10_000 ? bp : null;
}

// ─── Categories ──────────────────────────────────────────────────────────

export const EXPENSE_CATEGORIES = [
  'flights',
  'hotels',
  'trains',
  'buses',
  'local_transport',
  'food',
  'activities',
  'shopping',
  'other',
] as const;
export const expenseCategorySchema = z.enum(EXPENSE_CATEGORIES, {
  error: 'Choose a category.',
});
export type ExpenseCategory = z.infer<typeof expenseCategorySchema>;

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  flights: 'Flights',
  hotels: 'Hotels',
  trains: 'Trains',
  buses: 'Buses',
  local_transport: 'Local transport',
  food: 'Food',
  activities: 'Activities',
  shopping: 'Shopping',
  other: 'Other',
};

// ─── Split calculations (pure, exact) ────────────────────────────────────

/** A person's part of an expense: what they paid and what share they owe. */
export interface PartMinor {
  personId: string;
  paidMinor: bigint;
  shareMinor: bigint;
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Equal split. Every participant gets ⌊amount / n⌋; the leftover minor units
 * (fewer than n) go one each to the participants first in id order. So
 * ₹1,000.00 between three people is 333.34 + 333.33 + 333.33 — exactly
 * ₹1,000.00, and the same people always get the extra paisa.
 */
export function splitEqual(amountMinor: bigint, personIds: readonly string[]): Map<string, bigint> {
  const ids = [...new Set(personIds)].sort(byId);
  if (ids.length === 0) throw new Error('No participants');
  const n = BigInt(ids.length);
  const base = amountMinor / n;
  const extra = amountMinor % n;
  return new Map(ids.map((id, i) => [id, base + (BigInt(i) < extra ? 1n : 0n)]));
}

/**
 * Percentage split in basis points (summing to 10,000). Each share is the
 * exact amount rounded down; the leftover minor units go one each to the
 * largest fractional remainders (ties: id order) — the largest-remainder
 * method, so the shares always add up to the amount exactly.
 */
export function splitByBasisPoints(
  amountMinor: bigint,
  shares: readonly { personId: string; basisPoints: number }[],
): Map<string, bigint> {
  const total = shares.reduce((s, x) => s + x.basisPoints, 0);
  if (total !== 10_000) throw new Error('Basis points must add up to 10000');
  const rows = shares.map((s) => {
    const exact = amountMinor * BigInt(s.basisPoints);
    return { id: s.personId, floor: exact / 10_000n, remainder: exact % 10_000n };
  });
  let left = amountMinor - rows.reduce((s, r) => s + r.floor, 0n);
  const order = [...rows].sort((a, b) =>
    a.remainder === b.remainder ? byId(a.id, b.id) : a.remainder > b.remainder ? -1 : 1,
  );
  const result = new Map(rows.map((r) => [r.id, r.floor]));
  for (const r of order) {
    if (left === 0n) break;
    result.set(r.id, (result.get(r.id) ?? 0n) + 1n);
    left -= 1n;
  }
  return result;
}

// ─── Balances and settlement suggestions (pure, exact) ───────────────────

export interface LedgerExpense {
  currency: string;
  parts: readonly PartMinor[];
}
export interface LedgerSettlement {
  currency: string;
  fromId: string;
  toId: string;
  amountMinor: bigint;
}
export interface PersonBalanceMinor {
  personId: string;
  paidMinor: bigint;
  shareMinor: bigint;
  /** Settlements this person recorded paying / receiving. */
  sentMinor: bigint;
  receivedMinor: bigint;
  /** paid − share + sent − received. Positive: others owe them. Negative: they owe. */
  netMinor: bigint;
}

/**
 * Per-currency balances from paid expenses and recorded settlements.
 * Sign convention: net > 0 means the person is owed that much; net < 0
 * means they owe it. In each currency the nets add up to exactly zero.
 */
export function computeBalances(
  expenses: readonly LedgerExpense[],
  settlements: readonly LedgerSettlement[],
): Map<string, PersonBalanceMinor[]> {
  const perCurrency = new Map<string, Map<string, PersonBalanceMinor>>();
  const row = (currency: string, personId: string) => {
    let people = perCurrency.get(currency);
    if (!people) {
      people = new Map();
      perCurrency.set(currency, people);
    }
    let r = people.get(personId);
    if (!r) {
      r = {
        personId,
        paidMinor: 0n,
        shareMinor: 0n,
        sentMinor: 0n,
        receivedMinor: 0n,
        netMinor: 0n,
      };
      people.set(personId, r);
    }
    return r;
  };
  for (const e of expenses) {
    for (const p of e.parts) {
      const r = row(e.currency, p.personId);
      r.paidMinor += p.paidMinor;
      r.shareMinor += p.shareMinor;
    }
  }
  for (const s of settlements) {
    row(s.currency, s.fromId).sentMinor += s.amountMinor;
    row(s.currency, s.toId).receivedMinor += s.amountMinor;
  }
  const out = new Map<string, PersonBalanceMinor[]>();
  for (const [currency, people] of [...perCurrency.entries()].sort(([a], [b]) => byId(a, b))) {
    const list = [...people.values()].map((r) => ({
      ...r,
      netMinor: r.paidMinor - r.shareMinor + r.sentMinor - r.receivedMinor,
    }));
    list.sort((a, b) => byId(a.personId, b.personId));
    out.set(currency, list);
  }
  return out;
}

export interface TransferMinor {
  fromId: string;
  toId: string;
  amountMinor: bigint;
}

/**
 * Suggested transfers that settle every balance in one currency. Greedy and
 * deterministic: repeatedly the person who owes most pays the person owed
 * most (ties: id order) the smaller of the two amounts. Uses at most n − 1
 * transfers; after them every net balance is exactly zero.
 */
export function suggestSettlements(
  balances: readonly Pick<PersonBalanceMinor, 'personId' | 'netMinor'>[],
): TransferMinor[] {
  const debtors = balances
    .filter((b) => b.netMinor < 0n)
    .map((b) => ({ id: b.personId, left: -b.netMinor }));
  const creditors = balances
    .filter((b) => b.netMinor > 0n)
    .map((b) => ({ id: b.personId, left: b.netMinor }));
  const order = (a: { id: string; left: bigint }, b: { id: string; left: bigint }) =>
    a.left === b.left ? byId(a.id, b.id) : a.left > b.left ? -1 : 1;
  const transfers: TransferMinor[] = [];
  for (;;) {
    debtors.sort(order);
    creditors.sort(order);
    const d = debtors.find((x) => x.left > 0n);
    const c = creditors.find((x) => x.left > 0n);
    if (!d || !c) break;
    const amount = d.left < c.left ? d.left : c.left;
    transfers.push({ fromId: d.id, toId: c.id, amountMinor: amount });
    d.left -= amount;
    c.left -= amount;
  }
  return transfers;
}

// ─── Ids and params ──────────────────────────────────────────────────────

export const expenseIdSchema = z.uuid({ error: 'Not a valid expense id.' });
export const settlementIdSchema = z.uuid({ error: 'Not a valid settlement id.' });
/** A person on a plan (their account id). */
export const personIdSchema = z.uuid({ error: 'Not a valid person.' });

export const expenseParamsSchema = z.object({
  tripId: plannedTripIdSchema,
  expenseId: expenseIdSchema,
});
export const settlementParamsSchema = z.object({
  tripId: plannedTripIdSchema,
  settlementId: settlementIdSchema,
});

// ─── Input ───────────────────────────────────────────────────────────────

const text = (label: string, max: number) =>
  z
    .string({ error: `Enter ${label}.` })
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(1, `Enter ${label}.`).max(max, `Use ${max} characters or fewer.`));
const note = z
  .string()
  .transform((v) => v.replace(/\r\n?/g, '\n').trim())
  .pipe(z.string().max(500, 'Use 500 characters or fewer.'))
  .transform((v) => (v === '' ? null : v))
  .nullable();

/** Create or replace the plan's budget. Category amounts are in the budget's currency. */
export const putBudgetSchema = z
  .object({
    /** The version this edit is based on; omit when creating the budget. */
    version: z.number().int().min(1).optional(),
    currency: budgetCurrencySchema,
    totalMinor: positiveMinorSchema,
    categories: z
      .array(
        z.object({ category: expenseCategorySchema, amountMinor: positiveMinorSchema }).strict(),
      )
      .max(EXPENSE_CATEGORIES.length)
      .default([])
      .refine(
        (list) => new Set(list.map((c) => c.category)).size === list.length,
        'Each category may appear only once.',
      ),
  })
  .strict();
export type PutBudgetInput = z.input<typeof putBudgetSchema>;

const peopleList = z
  .array(personIdSchema)
  .min(1, 'Choose at least one person.')
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length, 'Each person may appear only once.');

/** How the expense is shared. The server computes every share from this. */
export const expenseSplitSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('equal'), participants: peopleList }).strict(),
  z
    .object({
      method: z.literal('custom'),
      shares: z
        .array(z.object({ personId: personIdSchema, amountMinor: positiveMinorSchema }).strict())
        .min(1)
        .max(50),
    })
    .strict(),
  z
    .object({
      method: z.literal('percent'),
      shares: z
        .array(
          z
            .object({ personId: personIdSchema, basisPoints: z.number().int().min(1).max(10_000) })
            .strict(),
        )
        .min(1)
        .max(50),
    })
    .strict(),
]);
export type ExpenseSplitInput = z.infer<typeof expenseSplitSchema>;
export type SplitMethod = ExpenseSplitInput['method'];

/** Who paid: one person (the whole amount) or several with amounts. */
export const expensePayersSchema = z
  .array(z.object({ personId: personIdSchema, amountMinor: positiveMinorSchema }).strict())
  .min(1, 'Choose who paid.')
  .max(50);

/**
 * `paid`: money actually spent — needs payers and a split, and counts in
 * balances. `planned`: an estimate (no payer, no split) — counts only toward
 * planned totals.
 */
export const expenseStatusSchema = z.enum(['paid', 'planned']);
export type ExpenseStatus = z.infer<typeof expenseStatusSchema>;

const expenseBase = {
  description: text('a description', 120),
  category: expenseCategorySchema,
  amountMinor: positiveMinorSchema,
  currency: budgetCurrencySchema,
  spentOn: isoDateSchema,
  notes: note.optional(),
};

const expenseRefinement = (
  v: {
    status: ExpenseStatus;
    paidBy?: unknown;
    split?: unknown;
  },
  ctx: z.RefinementCtx,
) => {
  if (v.status === 'paid') {
    if (!v.paidBy) ctx.addIssue({ code: 'custom', path: ['paidBy'], message: 'Choose who paid.' });
    if (!v.split)
      ctx.addIssue({ code: 'custom', path: ['split'], message: 'Choose who shares this expense.' });
  } else {
    if (v.paidBy !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['paidBy'],
        message: 'A planned expense has no payer yet.',
      });
    if (v.split !== undefined)
      ctx.addIssue({ code: 'custom', path: ['split'], message: 'A planned expense isn’t split.' });
  }
};

export const createExpenseSchema = z
  .object({
    ...expenseBase,
    status: expenseStatusSchema,
    paidBy: expensePayersSchema.optional(),
    split: expenseSplitSchema.optional(),
  })
  .strict()
  .superRefine(expenseRefinement);
export type CreateExpenseInput = z.input<typeof createExpenseSchema>;

/**
 * Replaces an expense (every field is sent again, so nothing is changed
 * silently). `version` is the version the edit is based on.
 */
export const updateExpenseSchema = z
  .object({
    version: z.number({ error: 'Send the expense’s version.' }).int().min(1),
    ...expenseBase,
    status: expenseStatusSchema,
    paidBy: expensePayersSchema.optional(),
    split: expenseSplitSchema.optional(),
  })
  .strict()
  .superRefine(expenseRefinement);
export type UpdateExpenseInput = z.input<typeof updateExpenseSchema>;

/** Turn the owner's linked booking into an expense (once). */
export const expenseFromBookingSchema = z.object({ split: expenseSplitSchema.optional() }).strict();

export const expenseListQuerySchema = z
  .object({
    category: expenseCategorySchema.optional(),
    status: expenseStatusSchema.optional(),
    payer: personIdSchema.optional(),
    participant: personIdSchema.optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    currency: budgetCurrencySchema.optional(),
    sort: z.enum(['date-desc', 'date-asc', 'amount-desc']).default('date-desc'),
    page: z.coerce.number().int().min(1).max(100).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type ExpenseListQuery = z.input<typeof expenseListQuerySchema>;

/** Record that one person paid another, outside Wayora. */
export const createSettlementSchema = z
  .object({
    fromId: personIdSchema,
    toId: personIdSchema,
    amountMinor: positiveMinorSchema,
    currency: budgetCurrencySchema,
    settledOn: isoDateSchema,
    note: note.optional(),
  })
  .strict()
  .refine((v) => v.fromId !== v.toId, {
    path: ['toId'],
    message: 'Choose two different people.',
  });
export type CreateSettlementInput = z.input<typeof createSettlementSchema>;

// ─── Output ──────────────────────────────────────────────────────────────

const minor = z.string().regex(/^-?(0|[1-9]\d*)$/);

/** Someone who can appear on an expense: current members, and former ones still on expenses. */
export const budgetPersonSchema = z.object({
  id: personIdSchema,
  name: z.string(),
  initials: z.string(),
  isYou: z.boolean(),
  /** `former`: left or was removed, but still appears on expenses. */
  role: z.enum(['owner', 'editor', 'viewer', 'former']),
});
export type BudgetPerson = z.infer<typeof budgetPersonSchema>;

export const budgetSchema = z.object({
  currency: budgetCurrencySchema,
  totalMinor: minor,
  categories: z.array(z.object({ category: expenseCategorySchema, amountMinor: minor })),
  version: z.number().int().min(1),
  updatedAt: offsetDateTimeSchema,
});
export type Budget = z.infer<typeof budgetSchema>;

/** Totals in one currency. Never mixed with other currencies. */
export const currencyTotalsSchema = z.object({
  currency: budgetCurrencySchema,
  /** Paid expenses. */
  recordedMinor: minor,
  /** Planned (estimated, not yet paid) expenses. */
  plannedMinor: minor,
  recordedCount: z.number().int(),
  plannedCount: z.number().int(),
});
export type CurrencyTotals = z.infer<typeof currencyTotalsSchema>;

export const categoryBreakdownSchema = z.object({
  category: expenseCategorySchema,
  /** Category budget, if set (budget currency). */
  budgetMinor: minor.nullable(),
  recordedMinor: minor,
  plannedMinor: minor,
});

/** The budget compared with expenses in the budget's own currency only. */
export const budgetProgressSchema = z.object({
  currency: budgetCurrencySchema,
  totalMinor: minor,
  recordedMinor: minor,
  plannedMinor: minor,
  /** total − recorded (negative when over budget). */
  remainingMinor: minor,
  /** total − recorded − planned. */
  remainingAfterPlannedMinor: minor,
  /** recorded ÷ total, in basis points (10000 = 100%), rounded down. */
  utilizationBasisPoints: z.number().int().min(0),
  overBudget: z.boolean(),
  categories: z.array(categoryBreakdownSchema),
});
export type BudgetProgress = z.infer<typeof budgetProgressSchema>;

export const budgetOverviewSchema = z.object({
  tripId: plannedTripIdSchema,
  access: tripAccessSchema,
  /** Add expenses (owner, editors). */
  canAddExpenses: z.boolean(),
  /** Set or change the budget (owner, editors). */
  canManageBudget: z.boolean(),
  budget: budgetSchema.nullable(),
  /** Null when there is no budget. */
  progress: budgetProgressSchema.nullable(),
  /** Totals per currency, budget currency first. */
  totals: z.array(currencyTotalsSchema),
  people: z.array(budgetPersonSchema),
  /** The owner's linked booking can be added as an expense (not yet added). */
  bookingImport: z
    .object({
      reference: z.string(),
      amountMinor: minor,
      currency: z.string(),
      /** Whether it would be recorded as paid (only a confirmed real payment counts). */
      paid: z.boolean(),
      demo: z.boolean(),
    })
    .nullable(),
});
export type BudgetOverview = z.infer<typeof budgetOverviewSchema>;

export const expensePartSchema = z.object({
  personId: personIdSchema,
  paidMinor: minor,
  shareMinor: minor,
  /** For percentage splits: the person's percentage in basis points. */
  basisPoints: z.number().int().nullable(),
});

export const expenseSchema = z.object({
  id: expenseIdSchema,
  description: z.string(),
  category: expenseCategorySchema,
  amountMinor: minor,
  currency: budgetCurrencySchema,
  spentOn: isoDateSchema,
  status: expenseStatusSchema,
  splitMethod: z.enum(['equal', 'custom', 'percent']).nullable(),
  /** Visible to everyone on the plan. */
  notes: z.string().nullable(),
  parts: z.array(expensePartSchema),
  /** The linked booking it came from, if any. */
  bookingReference: z.string().nullable(),
  createdBy: z.object({ id: personIdSchema, name: z.string(), isYou: z.boolean() }).nullable(),
  /** Whether the signed-in user may edit or delete it (the API checks again). */
  canEdit: z.boolean(),
  version: z.number().int().min(1),
  createdAt: offsetDateTimeSchema,
  updatedAt: offsetDateTimeSchema,
});
export type Expense = z.infer<typeof expenseSchema>;

export const expenseListSchema = z.object({
  items: z.array(expenseSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  people: z.array(budgetPersonSchema),
});
export type ExpenseList = z.infer<typeof expenseListSchema>;

export const expenseDeletedSchema = z.object({ deleted: z.literal(true) });

export const personBalanceSchema = z.object({
  personId: personIdSchema,
  paidMinor: minor,
  shareMinor: minor,
  sentMinor: minor,
  receivedMinor: minor,
  /** Positive: others owe them. Negative: they owe. */
  netMinor: minor,
});

export const settlementSchema = z.object({
  id: settlementIdSchema,
  fromId: personIdSchema,
  toId: personIdSchema,
  amountMinor: minor,
  currency: budgetCurrencySchema,
  settledOn: isoDateSchema,
  note: z.string().nullable(),
  recordedBy: z.object({ name: z.string(), isYou: z.boolean() }).nullable(),
  canDelete: z.boolean(),
  createdAt: offsetDateTimeSchema,
});
export type Settlement = z.infer<typeof settlementSchema>;

export const currencyBalancesSchema = z.object({
  currency: budgetCurrencySchema,
  people: z.array(personBalanceSchema),
  /** Recommendations only: nothing is paid by Wayora. */
  suggestions: z.array(
    z.object({ fromId: personIdSchema, toId: personIdSchema, amountMinor: minor }),
  ),
});
export type CurrencyBalances = z.infer<typeof currencyBalancesSchema>;

export const balancesSchema = z.object({
  /** One entry per currency with paid expenses or settlements. */
  currencies: z.array(currencyBalancesSchema),
  settlements: z.array(settlementSchema),
  people: z.array(budgetPersonSchema),
  /** Record a settlement (owner, editors, or either party). */
  canRecordSettlements: z.boolean(),
});
export type Balances = z.infer<typeof balancesSchema>;

export const settlementDeletedSchema = z.object({ deleted: z.literal(true) });

/** DELETE /budget?version=: the budget version the removal is based on. */
export const budgetVersionQuerySchema = z
  .object({ version: z.coerce.number().int().min(1) })
  .strict();
