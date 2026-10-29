import type {
  AssistantBlockOf,
  AssistantIntent,
  AssistantTripContext,
  BudgetCurrency,
  ExpenseCategory,
  PlanningPace,
} from '@wayora/contracts';
import type { Prisma, PrismaClient } from '@wayora/database';
import { tripAccess, type TripContext } from '../planner/access.js';
import { dateOnly, datesBetween, fromDbCategory } from '../planner/presenter.js';
import { formatMinute, scheduleWarnings } from '../planner/schedule.js';

/*
 * What the assistant may know about a plan (docs/assistant.md#context).
 *
 * Built only after `tripAccess(..., 'view')` for the signed-in user, from
 * saved data, on every request. Minimal by design:
 *
 * - Included: destination, dates, day count, group size (a number), pace,
 *   interests, group type, budget level; activity titles, categories, times
 *   and durations (not for budget or packing questions); schedule warnings;
 *   for budget questions only, budget and expense totals per currency and
 *   category, computed here in integer minor units.
 * - Never included: member names or emails, user ids, plan or activity
 *   notes, expense descriptions or notes, who paid what, booking references,
 *   prices paid, payment details, tokens or anything about other plans.
 * - The owner (only) also gets the linked booking's category, start date and
 *   status, so suggestions can work around it.
 *
 * Activities are referred to as `a1`, `a2`… — the model never sees database
 * ids; `refs` maps them back, with each activity's version for conflict checks.
 */

const MAX_ACTIVITIES = 120;

export const EXCLUDED_FROM_CONTEXT = [
  'Names and emails of plan members',
  'Notes on the plan and its activities',
  'Expense descriptions and notes, and who paid what',
  'Booking references, prices paid and payment details',
  'Anything from other plans or other people’s accounts',
];

export interface ActivityRef {
  itemId: string;
  version: number;
  day: string;
  title: string;
}

export interface BuiltContext {
  access: TripContext;
  context: AssistantTripContext;
  refs: Map<string, ActivityRef>;
}

type Db = PrismaClient | Prisma.TransactionClient;

const needsActivities = (intent: AssistantIntent) => intent !== 'budget' && intent !== 'packing';

export async function buildTripContext(
  db: Db,
  userId: string,
  tripId: string,
  intent: AssistantIntent,
): Promise<BuiltContext> {
  const access = await tripAccess(db, userId, tripId, 'view');
  const trip = await db.plannedTrip.findUniqueOrThrow({
    where: { id: tripId },
    select: {
      title: true,
      destinationName: true,
      startDate: true,
      endDate: true,
      pace: true,
      budget: true,
      groupType: true,
      interests: true,
      booking: { select: { category: true, startsOn: true, status: true } },
      _count: { select: { members: true } },
      items: {
        orderBy: [{ day: 'asc' }, { position: 'asc' }],
        take: 200,
        select: {
          id: true,
          day: true,
          position: true,
          title: true,
          category: true,
          startMinute: true,
          durationMinutes: true,
          version: true,
        },
      },
    },
  });
  const startDate = dateOnly(trip.startDate);
  const endDate = dateOnly(trip.endDate);
  const dates = datesBetween(startDate, endDate);
  const items = trip.items.map((i) => ({ ...i, day: dateOnly(i.day) }));

  const refs = new Map<string, ActivityRef>();
  const activities: AssistantTripContext['activities'] = [];
  if (needsActivities(intent)) {
    for (const [index, item] of items.slice(0, MAX_ACTIVITIES).entries()) {
      const ref = `a${index + 1}`;
      refs.set(ref, { itemId: item.id, version: item.version, day: item.day, title: item.title });
      activities.push({
        ref,
        day: item.day,
        title: item.title,
        category: fromDbCategory(item.category),
        startTime: item.startMinute === null ? null : formatMinute(item.startMinute),
        durationMinutes: item.durationMinutes,
      });
    }
  }

  const warnings = scheduleWarnings(
    items.map((i) => ({
      id: i.id,
      day: i.day,
      position: i.position,
      title: i.title,
      startMinute: i.startMinute,
      durationMinutes: i.durationMinutes,
    })),
    { startDate, endDate },
  ).map((w) => ({ code: w.code, day: w.day, message: w.message }));

  const context: AssistantTripContext = {
    source: 'plan',
    trip: {
      id: tripId,
      title: trip.title,
      destination: trip.destinationName,
      startDate,
      endDate,
      dayCount: dates.length,
      groupSize: trip._count.members + 1,
      pace: trip.pace ? (trip.pace.toLowerCase() as PlanningPace) : null,
    },
    days: dates.map((date, i) => ({
      date,
      dayNumber: i + 1,
      activities: items.filter((it) => it.day === date).length,
    })),
    warnings,
    budget: intent === 'budget' ? await budgetFacts(db, tripId) : null,
    activities,
    interests: trip.interests.map(fromDbCategory),
    group: trip.groupType ? trip.groupType.toLowerCase() : null,
    budgetLevel: trip.budget ? trip.budget.toLowerCase() : null,
    linkedBooking:
      access.role === 'owner' && trip.booking
        ? {
            category: trip.booking.category.toLowerCase(),
            startsOn: trip.booking.startsOn ? dateOnly(trip.booking.startsOn) : null,
            status: trip.booking.status.toLowerCase(),
          }
        : null,
    excluded: EXCLUDED_FROM_CONTEXT,
  };
  return { access, context, refs };
}

/** Budget and expense totals from saved rows, per currency, in integer minor units. */
async function budgetFacts(db: Db, tripId: string): Promise<AssistantTripContext['budget']> {
  const [budget, sums] = await Promise.all([
    db.planBudget.findUnique({
      where: { tripId },
      select: { currency: true, totalAmountMinor: true },
    }),
    db.planExpense.groupBy({
      by: ['currency', 'category', 'status'],
      where: { tripId },
      _sum: { amountMinor: true },
    }),
  ]);
  const totals = new Map<string, { recorded: bigint; planned: bigint }>();
  const categories = new Map<string, { recorded: bigint; planned: bigint }>();
  for (const row of sums) {
    const value = row._sum.amountMinor ?? 0n;
    const t = totals.get(row.currency) ?? { recorded: 0n, planned: 0n };
    const key = `${row.currency}:${row.category}`;
    const c = categories.get(key) ?? { recorded: 0n, planned: 0n };
    if (row.status === 'PAID') {
      t.recorded += value;
      c.recorded += value;
    } else {
      t.planned += value;
      c.planned += value;
    }
    totals.set(row.currency, t);
    categories.set(key, c);
  }
  const currency = (budget?.currency ?? null) as BudgetCurrency | null;
  const recordedInBudget = currency ? (totals.get(currency)?.recorded ?? 0n) : 0n;
  const top = [...categories.entries()]
    .map(([key, v]) => {
      const [cur, category] = key.split(':') as [string, string];
      return {
        currency: cur as BudgetCurrency,
        category: category.toLowerCase() as ExpenseCategory,
        recordedMinor: v.recorded.toString(),
        plannedMinor: v.planned.toString(),
        size: v.recorded + v.planned,
      };
    })
    .sort((a, b) =>
      a.size === b.size
        ? a.currency.localeCompare(b.currency) || a.category.localeCompare(b.category)
        : a.size > b.size
          ? -1
          : 1,
    )
    .slice(0, 4)
    .map(({ size: _size, ...rest }) => rest);
  return {
    currency,
    totalMinor: budget ? budget.totalAmountMinor.toString() : null,
    remainingMinor: budget ? (budget.totalAmountMinor - recordedInBudget).toString() : null,
    overBudget: budget ? recordedInBudget > budget.totalAmountMinor : false,
    totals: [...totals.entries()]
      .sort(([a], [b]) => (a === currency ? -1 : b === currency ? 1 : a.localeCompare(b)))
      .map(([cur, v]) => ({
        currency: cur as BudgetCurrency,
        recordedMinor: v.recorded.toString(),
        plannedMinor: v.planned.toString(),
      })),
    topCategories: top,
  };
}

/** The "From your plan" block shown to the user: Wayora's own figures, never the model's. */
export function factsBlock(context: AssistantTripContext): AssistantBlockOf<'facts'> {
  return {
    type: 'facts',
    id: 'b1',
    source: 'plan',
    trip: context.trip,
    days: context.days,
    warnings: context.warnings,
    budget: context.budget,
  };
}
