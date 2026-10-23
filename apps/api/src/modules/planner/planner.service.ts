import {
  PLANNER_LIMITS,
  daysBetween,
  utcDateFromToday,
  type CreatePlannedTrip,
  type PlannedTrip as PlannedTripDto,
  type PlannedTripList,
  type PlannedTripListQuery,
  type PlannerDestination,
  type PlannerInterest,
  type PlannerPreferences,
  type SuggestionsResponse,
  type createItineraryItemSchema,
  type updateItineraryItemSchema,
  type updatePlannedTripSchema,
} from '@wayora/contracts';
import { Prisma, type PrismaClient } from '@wayora/database';
import type { z } from 'zod';
import { AppError, notFound } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import {
  IdempotencyService,
  requestHash,
  type IdempotencyMessages,
} from '../bookings/idempotency.js';
import { PLANNER_CATALOG, catalogActivity, catalogDestination } from './catalog.js';
import {
  LINKED_BOOKING_SELECT,
  dateOnly,
  fromDbCategory,
  presentPreferences,
  presentSummary,
  presentTrip,
  toDbCategory,
  toDbDate,
} from './presenter.js';
import { suggest } from './recommend.js';
import { parseLocalTime } from './schedule.js';

/*
 * Trip planner (docs/planner.md). Every operation is scoped to the signed-in
 * user: trips are always looked up by (id, user_id), so another user's trip
 * is indistinguishable from a missing one (404, same message).
 *
 * Every itinerary write runs in one transaction that first locks the trip row
 * (SELECT … FOR UPDATE), so concurrent writes to one trip are serialized and
 * positions stay gap-free and unique. The (trip, day, position) uniqueness is
 * a deferrable constraint, deferred inside those transactions, so moves and
 * reorders can shift positions in any order.
 */

type Tx = Prisma.TransactionClient;
type UpdateTrip = z.output<typeof updatePlannedTripSchema>;
type CreateItem = z.output<typeof createItineraryItemSchema>;
type UpdateItem = z.output<typeof updateItineraryItemSchema>;

const TRIP_NOT_FOUND = 'This planned trip doesn’t exist, or it isn’t yours.';
const ITEM_NOT_FOUND = 'This activity doesn’t exist in this trip.';

const TRIP_MESSAGES: IdempotencyMessages = {
  inProgress: 'This trip is already being created. Wait a moment, then check your planned trips.',
  reused: 'This request key was already used for a different trip. Try again.',
};
const ITEM_MESSAGES: IdempotencyMessages = {
  inProgress: 'This activity is already being added. Wait a moment.',
  reused: 'This request key was already used for a different activity. Try again.',
};

interface LockedTrip {
  id: string;
  startDate: string;
  endDate: string;
  destinationId: string | null;
  version: number;
}

export interface WriteResult {
  trip: PlannedTripDto;
  /** True when an idempotent POST was answered from its stored outcome. */
  replayed: boolean;
}

const validation = (path: string, message: string) =>
  new AppError('VALIDATION_FAILED', 'The request is invalid.', {
    details: [{ path, message, code: 'custom' }],
  });

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

const toDbPreferences = (p: PlannerPreferences) => ({
  pace: p.pace ? (p.pace.toUpperCase() as 'RELAXED' | 'BALANCED' | 'PACKED') : null,
  budget: p.budget ? (p.budget.toUpperCase() as 'SHOESTRING' | 'MODERATE' | 'PREMIUM') : null,
  groupType: p.group ? (p.group.toUpperCase() as 'SOLO' | 'COUPLE' | 'FAMILY' | 'FRIENDS') : null,
  interests: p.interests.map(toDbCategory),
});

export class PlannerService {
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

  /** The curated sample destinations (for the destination picker). */
  destinations(): PlannerDestination[] {
    return PLANNER_CATALOG.map((d) => ({
      id: d.id,
      name: d.name,
      country: d.country,
      timeZone: d.timeZone,
      hasSuggestions: true,
    }));
  }

  // ─── Trips ─────────────────────────────────────────────────────────────

  async list(userId: string, query: PlannedTripListQuery): Promise<PlannedTripList> {
    const where = { userId };
    const [rows, total] = await Promise.all([
      this.prisma.plannedTrip.findMany({
        where,
        orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          booking: { select: LINKED_BOOKING_SELECT },
          _count: { select: { items: true } },
        },
      }),
      this.prisma.plannedTrip.count({ where }),
    ]);
    return {
      items: rows.map(presentSummary),
      page: query.page,
      pageSize: query.pageSize,
      total,
      limit: PLANNER_LIMITS.maxTrips,
    };
  }

  async get(userId: string, tripId: string, db: PrismaClient | Tx = this.prisma) {
    const trip = await db.plannedTrip.findFirst({
      where: { id: tripId, userId },
      include: {
        booking: { select: LINKED_BOOKING_SELECT },
        items: {
          orderBy: [{ day: 'asc' }, { position: 'asc' }],
          take: PLANNER_LIMITS.maxItemsPerTrip,
        },
      },
    });
    if (!trip) throw notFound(TRIP_NOT_FOUND);
    return presentTrip(trip);
  }

  async create(userId: string, input: CreatePlannedTrip, key: string): Promise<WriteResult> {
    const result = await this.idempotent(
      { operation: 'planner-trip', userId, key, payload: input, messages: TRIP_MESSAGES },
      async (complete) => {
        this.checkDates(input.startDate, input.endDate, null);
        const destination = this.resolveDestination(input.destinationId, input.destinationName);
        return this.prisma.$transaction(async (tx) => {
          // Serialize this user's trip creations so the per-account limit holds.
          await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
          const count = await tx.plannedTrip.count({ where: { userId } });
          if (count >= PLANNER_LIMITS.maxTrips) {
            throw new AppError(
              'PLAN_LIMIT_REACHED',
              `You can keep up to ${PLANNER_LIMITS.maxTrips} planned trips. Delete one you no longer need first.`,
            );
          }
          const trip = await tx.plannedTrip.create({
            data: {
              userId,
              title: input.title,
              ...destination,
              startDate: toDbDate(input.startDate),
              endDate: toDbDate(input.endDate),
              notes: input.notes ?? null,
              ...toDbPreferences(
                input.preferences ?? { pace: null, budget: null, group: null, interests: [] },
              ),
            },
            select: { id: true },
          });
          await complete(tx, trip.id);
          return trip.id;
        });
      },
    );
    return { trip: await this.get(userId, result.id), replayed: result.replayed };
  }

  async update(userId: string, tripId: string, input: UpdateTrip): Promise<PlannedTripDto> {
    await this.prisma.$transaction(async (tx) => {
      const trip = await this.lockTrip(tx, userId, tripId);
      if (trip.version !== input.version) {
        throw new AppError(
          'PLAN_OUT_OF_DATE',
          'This trip was changed somewhere else since you opened it. Reload it to see the latest version, then make your change again.',
        );
      }
      const data: Prisma.PlannedTripUncheckedUpdateInput = { version: { increment: 1 } };
      if (input.title !== undefined) data.title = input.title;
      if (input.notes !== undefined) data.notes = input.notes;
      if (input.startDate !== undefined && input.endDate !== undefined) {
        this.checkDates(input.startDate, input.endDate, trip.startDate);
        data.startDate = toDbDate(input.startDate);
        data.endDate = toDbDate(input.endDate);
      }
      if (input.destinationId !== undefined || input.destinationName !== undefined) {
        Object.assign(
          data,
          this.resolveDestination(input.destinationId ?? null, input.destinationName ?? null),
        );
      }
      if (input.preferences !== undefined) Object.assign(data, toDbPreferences(input.preferences));
      if (input.bookingReference !== undefined) {
        data.bookingId =
          input.bookingReference === null
            ? null
            : await this.linkableBooking(tx, userId, input.bookingReference);
      }
      await tx.plannedTrip.update({ where: { id: trip.id }, data });
    });
    return this.get(userId, tripId);
  }

  async remove(userId: string, tripId: string): Promise<void> {
    const { count } = await this.prisma.plannedTrip.deleteMany({ where: { id: tripId, userId } });
    if (count === 0) throw notFound(TRIP_NOT_FOUND);
  }

  // ─── Itinerary items ──────────────────────────────────────────────────

  async addItem(
    userId: string,
    tripId: string,
    input: CreateItem,
    key: string,
  ): Promise<WriteResult> {
    const result = await this.idempotent(
      {
        operation: 'planner-item',
        userId,
        key,
        payload: { tripId, ...input },
        messages: ITEM_MESSAGES,
      },
      (complete) =>
        this.prisma.$transaction(async (tx) => {
          const trip = await this.lockTrip(tx, userId, tripId);
          this.checkDayInTrip(trip, input.day, 'body.day');
          if (input.suggestionId) {
            const activity = catalogActivity(input.suggestionId);
            if (!activity || !input.suggestionId.startsWith(`${trip.destinationId ?? ''}:`)) {
              throw validation(
                'body.suggestionId',
                'This suggestion isn’t for this trip’s destination.',
              );
            }
            const existing = await tx.itineraryItem.count({
              where: { tripId, suggestionId: input.suggestionId },
            });
            if (existing > 0) {
              throw new AppError('CONFLICT', 'This suggestion is already in your itinerary.');
            }
          }
          const position = await this.checkCapacity(tx, tripId, input.day);
          const item = await tx.itineraryItem.create({
            data: {
              tripId,
              day: toDbDate(input.day),
              position,
              title: input.title,
              category: toDbCategory(input.category),
              startMinute: input.startTime ? parseLocalTime(input.startTime) : null,
              durationMinutes: input.durationMinutes ?? null,
              location: input.location ?? null,
              notes: input.notes ?? null,
              suggestionId: input.suggestionId ?? null,
            },
            select: { id: true },
          });
          await this.touch(tx, tripId);
          await complete(tx, item.id);
          return item.id;
        }),
    );
    return { trip: await this.get(userId, tripId), replayed: result.replayed };
  }

  async updateItem(
    userId: string,
    tripId: string,
    itemId: string,
    input: UpdateItem,
  ): Promise<PlannedTripDto> {
    await this.prisma.$transaction(async (tx) => {
      const trip = await this.lockTrip(tx, userId, tripId);
      const item = await tx.itineraryItem.findFirst({ where: { id: itemId, tripId } });
      if (!item) throw notFound(ITEM_NOT_FOUND);
      const fromDay = dateOnly(item.day);

      const data: Prisma.ItineraryItemUncheckedUpdateInput = {};
      if (input.title !== undefined) data.title = input.title;
      if (input.category !== undefined) data.category = toDbCategory(input.category);
      if (input.startTime !== undefined) {
        data.startMinute = input.startTime === null ? null : parseLocalTime(input.startTime);
      }
      if (input.durationMinutes !== undefined) data.durationMinutes = input.durationMinutes;
      if (input.location !== undefined) data.location = input.location;
      if (input.notes !== undefined) data.notes = input.notes;

      const toDay = input.day ?? fromDay;
      if (toDay !== fromDay || input.position !== undefined) {
        await this.deferPositions(tx);
        if (toDay !== fromDay) {
          this.checkDayInTrip(trip, toDay, 'body.day');
          const end = await this.checkCapacity(tx, tripId, toDay);
          const position = Math.min(input.position ?? end, end);
          // Close the gap on the old day, open one on the new day.
          await tx.$executeRaw`
            UPDATE itinerary_items SET position = position - 1
            WHERE trip_id = ${tripId}::uuid AND day = ${fromDay}::date AND position > ${item.position}`;
          await tx.$executeRaw`
            UPDATE itinerary_items SET position = position + 1
            WHERE trip_id = ${tripId}::uuid AND day = ${toDay}::date AND position >= ${position}`;
          data.day = toDbDate(toDay);
          data.position = position;
        } else {
          const count = await tx.itineraryItem.count({ where: { tripId, day: toDbDate(fromDay) } });
          const position = Math.min(input.position ?? item.position, count - 1);
          if (position !== item.position) {
            await this.shiftWithinDay(tx, tripId, fromDay, item.position, position);
            data.position = position;
          }
        }
      }
      if (Object.keys(data).length > 0) {
        await tx.itineraryItem.update({ where: { id: item.id }, data });
        await this.touch(tx, tripId);
      }
    });
    return this.get(userId, tripId);
  }

  async deleteItem(userId: string, tripId: string, itemId: string): Promise<PlannedTripDto> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockTrip(tx, userId, tripId);
      const item = await tx.itineraryItem.findFirst({ where: { id: itemId, tripId } });
      if (!item) throw notFound(ITEM_NOT_FOUND);
      await tx.itineraryItem.delete({ where: { id: item.id } });
      await tx.$executeRaw`
        UPDATE itinerary_items SET position = position - 1
        WHERE trip_id = ${tripId}::uuid AND day = ${dateOnly(item.day)}::date AND position > ${item.position}`;
      await this.touch(tx, tripId);
    });
    return this.get(userId, tripId);
  }

  /** Copies an activity (to the end of `day`, default its own day). The copy is the user's own: not linked to a suggestion. */
  async duplicateItem(
    userId: string,
    tripId: string,
    itemId: string,
    input: { day?: string | undefined },
    key: string,
  ): Promise<WriteResult> {
    const result = await this.idempotent(
      {
        operation: 'planner-item',
        userId,
        key,
        payload: { tripId, duplicate: itemId, ...input },
        messages: ITEM_MESSAGES,
      },
      (complete) =>
        this.prisma.$transaction(async (tx) => {
          const trip = await this.lockTrip(tx, userId, tripId);
          const source = await tx.itineraryItem.findFirst({ where: { id: itemId, tripId } });
          if (!source) throw notFound(ITEM_NOT_FOUND);
          const day = input.day ?? dateOnly(source.day);
          this.checkDayInTrip(trip, day, 'body.day');
          const position = await this.checkCapacity(tx, tripId, day);
          const copy = await tx.itineraryItem.create({
            data: {
              tripId,
              day: toDbDate(day),
              position,
              title: source.title,
              category: source.category,
              startMinute: source.startMinute,
              durationMinutes: source.durationMinutes,
              location: source.location,
              notes: source.notes,
              suggestionId: null,
            },
            select: { id: true },
          });
          await this.touch(tx, tripId);
          await complete(tx, copy.id);
          return copy.id;
        }),
    );
    return { trip: await this.get(userId, tripId), replayed: result.replayed };
  }

  /**
   * Sets the order of one day. `itemIds` must be exactly the activities on
   * that day; anything else means the client's view is stale (or forged) and
   * nothing changes.
   */
  async reorderDay(
    userId: string,
    tripId: string,
    day: string,
    itemIds: readonly string[],
  ): Promise<PlannedTripDto> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockTrip(tx, userId, tripId);
      const current = await tx.itineraryItem.findMany({
        where: { tripId, day: toDbDate(day) },
        select: { id: true, position: true },
      });
      const ids = new Set(current.map((i) => i.id));
      if (current.length !== itemIds.length || itemIds.some((id) => !ids.has(id))) {
        throw new AppError(
          'PLAN_OUT_OF_DATE',
          'This day changed since you loaded it. Reload the trip, then reorder again.',
        );
      }
      const unchanged = current.every((i) => itemIds[i.position] === i.id);
      if (unchanged) return;
      await this.deferPositions(tx);
      // One statement for the whole day.
      await tx.$executeRaw`
        UPDATE itinerary_items AS i SET position = (v.ord - 1)::int, updated_at = ${this.now()}
        FROM unnest(${[...itemIds]}::uuid[]) WITH ORDINALITY AS v(id, ord)
        WHERE i.id = v.id AND i.trip_id = ${tripId}::uuid`;
      await this.touch(tx, tripId);
    });
    return this.get(userId, tripId);
  }

  // ─── Suggestions ──────────────────────────────────────────────────────

  async suggestions(
    userId: string,
    tripId: string,
    category?: PlannerInterest,
  ): Promise<SuggestionsResponse> {
    const trip = await this.prisma.plannedTrip.findFirst({
      where: { id: tripId, userId },
      include: {
        items: {
          select: { suggestionId: true, title: true, category: true },
          take: PLANNER_LIMITS.maxItemsPerTrip,
        },
      },
    });
    if (!trip) throw notFound(TRIP_NOT_FOUND);
    return suggest({
      destination: catalogDestination(trip.destinationId),
      dayCount: daysBetween(dateOnly(trip.startDate), dateOnly(trip.endDate)) + 1,
      preferences: presentPreferences(trip),
      planned: {
        suggestionIds: new Set(trip.items.flatMap((i) => (i.suggestionId ? [i.suggestionId] : []))),
        titles: new Set(trip.items.map((i) => i.title.toLowerCase())),
        categories: new Set(trip.items.map((i) => fromDbCategory(i.category))),
        count: trip.items.length,
      },
      category,
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  /** Locks the user's trip row for this transaction; 404 when missing or not theirs. */
  private async lockTrip(tx: Tx, userId: string, tripId: string): Promise<LockedTrip> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        start_date: Date;
        end_date: Date;
        destination_id: string | null;
        version: number;
      }[]
    >`SELECT id, start_date, end_date, destination_id, version FROM planned_trips
      WHERE id = ${tripId}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
    const row = rows[0];
    if (!row) throw notFound(TRIP_NOT_FOUND);
    return {
      id: row.id,
      startDate: dateOnly(row.start_date),
      endDate: dateOnly(row.end_date),
      destinationId: row.destination_id,
      version: row.version,
    };
  }

  private async deferPositions(tx: Tx): Promise<void> {
    await tx.$executeRaw`SET CONSTRAINTS "itinerary_items_trip_day_position_key" DEFERRED`;
  }

  /** Moves the activity at `from` to `to` within one day, shifting those between. */
  private async shiftWithinDay(tx: Tx, tripId: string, day: string, from: number, to: number) {
    if (to > from) {
      await tx.$executeRaw`
        UPDATE itinerary_items SET position = position - 1
        WHERE trip_id = ${tripId}::uuid AND day = ${day}::date AND position > ${from} AND position <= ${to}`;
    } else {
      await tx.$executeRaw`
        UPDATE itinerary_items SET position = position + 1
        WHERE trip_id = ${tripId}::uuid AND day = ${day}::date AND position >= ${to} AND position < ${from}`;
    }
  }

  /** Throws PLAN_LIMIT_REACHED when the day or trip is full; else the next free position on `day`. */
  private async checkCapacity(tx: Tx, tripId: string, day: string): Promise<number> {
    const [onDay, total] = await Promise.all([
      tx.itineraryItem.count({ where: { tripId, day: toDbDate(day) } }),
      tx.itineraryItem.count({ where: { tripId } }),
    ]);
    if (onDay >= PLANNER_LIMITS.maxItemsPerDay) {
      throw new AppError(
        'PLAN_LIMIT_REACHED',
        `A day can hold up to ${PLANNER_LIMITS.maxItemsPerDay} activities. Choose another day.`,
      );
    }
    if (total >= PLANNER_LIMITS.maxItemsPerTrip) {
      throw new AppError(
        'PLAN_LIMIT_REACHED',
        `A trip can hold up to ${PLANNER_LIMITS.maxItemsPerTrip} activities.`,
      );
    }
    return onDay;
  }

  private checkDayInTrip(trip: LockedTrip, day: string, path: string): void {
    if (day < trip.startDate || day > trip.endDate) {
      throw validation(path, 'Choose a day within the trip dates.');
    }
  }

  /**
   * New trip dates: not in the past (yesterday in UTC still counts as today,
   * for travellers ahead of or behind UTC) and not too far ahead. An existing
   * trip that already started may keep its start date.
   */
  private checkDates(startDate: string, endDate: string, currentStart: string | null): void {
    const today = utcDateFromToday(-1, this.now());
    const earliest = currentStart && currentStart < today ? currentStart : today;
    if (startDate < earliest) throw validation('body.startDate', 'That date has already passed.');
    if (startDate > utcDateFromToday(PLANNER_LIMITS.maxDaysAhead, this.now())) {
      throw validation('body.startDate', 'Choose a start date within the next two years.');
    }
    // Shape rules (end ≥ start, length) are in the contract; re-checked for direct callers.
    const length = daysBetween(startDate, endDate) + 1;
    if (length < 1 || length > PLANNER_LIMITS.maxTripDays) {
      throw validation('body.endDate', `Plan between 1 and ${PLANNER_LIMITS.maxTripDays} days.`);
    }
  }

  private resolveDestination(
    destinationId: string | null | undefined,
    destinationName: string | null | undefined,
  ): { destinationId: string | null; destinationName: string } {
    if (destinationId) {
      const curated = catalogDestination(destinationId);
      if (!curated) throw validation('body.destinationId', 'Choose a destination from the list.');
      return { destinationId: curated.id, destinationName: curated.name };
    }
    if (!destinationName)
      throw validation('body.destinationName', 'Choose or enter a destination.');
    return { destinationId: null, destinationName };
  }

  /** The user's own confirmed booking, by reference (404 for anyone else's). */
  private async linkableBooking(tx: Tx, userId: string, reference: string): Promise<string> {
    const booking = await tx.booking.findFirst({
      where: { reference, userId },
      select: { id: true, status: true },
    });
    if (!booking) throw notFound('No booking with that reference in your account.');
    if (booking.status !== 'CONFIRMED') {
      throw new AppError('CONFLICT', 'Only confirmed bookings can be linked to a plan.');
    }
    return booking.id;
  }

  private async touch(tx: Tx, tripId: string): Promise<void> {
    await tx.plannedTrip.update({ where: { id: tripId }, data: { updatedAt: this.now() } });
  }

  /**
   * Runs a creating POST at most once per Idempotency-Key: a retry replays
   * the stored outcome (the new row's id), a concurrent duplicate is refused.
   */
  private async idempotent(
    claimInput: {
      operation: string;
      userId: string;
      key: string;
      payload: unknown;
      messages: IdempotencyMessages;
    },
    run: (complete: (tx: Tx, id: string) => Promise<void>) => Promise<string>,
  ): Promise<{ id: string; replayed: boolean }> {
    const claim = await this.idempotency.claim<{ id: string }>({
      operation: claimInput.operation,
      userId: claimInput.userId,
      key: claimInput.key,
      hash: requestHash(claimInput.payload),
      messages: claimInput.messages,
    });
    if (claim.kind === 'replay') return { id: claim.body.id, replayed: true };
    try {
      const id = await run((tx, created) =>
        this.idempotency.complete(tx, claim, { status: 201, body: { id: created } }),
      );
      return { id, replayed: false };
    } catch (error) {
      await this.idempotency.release(claim);
      if (isUniqueViolation(error)) {
        this.logger.warn(
          { operation: claimInput.operation },
          'Planner write hit a unique constraint',
        );
        throw new AppError(
          'CONFLICT',
          'That change clashes with another one. Reload and try again.',
        );
      }
      throw error;
    }
  }
}
