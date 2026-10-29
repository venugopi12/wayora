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
import { notify } from '../notifications/notify.js';
import {
  TRIP_NOT_FOUND,
  recordActivity,
  tripAccess,
  tripAudience,
  type TripContext,
} from './access.js';
import { PLANNER_CATALOG, catalogActivity, catalogDestination } from './catalog.js';
import { planMessages } from './messages.js';
import {
  LINKED_BOOKING_SELECT,
  PERSON_SELECT,
  dateOnly,
  fromDbCategory,
  presentPreferences,
  presentSummary,
  presentTrip,
  toDbCategory,
  toDbDate,
  type Viewer,
} from './presenter.js';
import { suggest } from './recommend.js';
import { parseLocalTime } from './schedule.js';

/*
 * Trip planner (docs/planner.md). Every operation resolves the signed-in
 * user's access first (access.ts): the owner and members can see a plan,
 * owners and editors can change it, only the owner manages members, the
 * booking link and deletion. Anyone else gets the same 404 as for a plan
 * that doesn't exist.
 *
 * Concurrent edits (Phase 19) are never silently overwritten: trip details
 * carry `version`, activities carry their own `version`, and a reorder
 * carries the order it was based on. A stale write is refused with
 * PLAN_OUT_OF_DATE. Every change bumps the plan's `revision` and appends one
 * history row (recordActivity), which also announces it to live streams.
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

const ITEM_NOT_FOUND =
  'This activity doesn’t exist in this plan. It may have been deleted by another member.';

const TRIP_MESSAGES: IdempotencyMessages = {
  inProgress: 'This trip is already being created. Wait a moment, then check your planned trips.',
  reused: 'This request key was already used for a different trip. Try again.',
};
const ITEM_MESSAGES: IdempotencyMessages = {
  inProgress: 'This activity is already being added. Wait a moment.',
  reused: 'This request key was already used for a different activity. Try again.',
};

type LockedTrip = TripContext;

/** A write based on data that changed since it was read (Phase 19). */
const outOfDate = (path: string, message: string) =>
  new AppError('PLAN_OUT_OF_DATE', message, {
    details: [{ path, message, code: 'stale_version' }],
  });
const ITEM_CHANGED =
  'Someone else changed this activity since you opened it. Load the latest version, then make your change again.';

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

  /** Plans the user owns or is a member of, by start date. */
  async list(userId: string, query: PlannedTripListQuery): Promise<PlannedTripList> {
    const where: Prisma.PlannedTripWhereInput = {
      OR: [{ userId }, { members: { some: { userId } } }],
    };
    const [rows, total] = await Promise.all([
      this.prisma.plannedTrip.findMany({
        where,
        orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          booking: { select: LINKED_BOOKING_SELECT },
          user: { select: { displayName: true } },
          members: { where: { userId }, select: { role: true } },
          _count: { select: { items: true, members: true } },
        },
      }),
      this.prisma.plannedTrip.count({ where }),
    ]);
    return {
      items: rows.map((row) =>
        presentSummary(row, {
          userId,
          role:
            row.userId === userId
              ? 'owner'
              : (row.members[0]?.role.toLowerCase() as 'editor' | 'viewer'),
        }),
      ),
      page: query.page,
      pageSize: query.pageSize,
      total,
      limit: PLANNER_LIMITS.maxTrips,
    };
  }

  async get(userId: string, tripId: string, db: PrismaClient | Tx = this.prisma) {
    const access = await tripAccess(db, userId, tripId, 'view');
    const trip = await db.plannedTrip.findUnique({
      where: { id: tripId },
      include: {
        booking: { select: LINKED_BOOKING_SELECT },
        user: { select: { displayName: true } },
        items: {
          orderBy: [{ day: 'asc' }, { position: 'asc' }],
          take: PLANNER_LIMITS.maxItemsPerTrip,
          include: { createdBy: { select: PERSON_SELECT } },
        },
        _count: { select: { members: true } },
      },
    });
    if (!trip) throw notFound(TRIP_NOT_FOUND);
    const viewer: Viewer = { userId, role: access.role };
    return presentTrip(trip, viewer);
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
      const trip = await this.lockTrip(tx, userId, tripId, 'edit');
      // The booking link is the owner's own booking: only the owner sets it.
      if (input.bookingReference !== undefined && trip.role !== 'owner') {
        throw new AppError('FORBIDDEN', 'Only the plan’s owner can link a booking.');
      }
      if (trip.version !== input.version) {
        throw outOfDate(
          'body.version',
          'This plan’s details were changed by someone else since you opened them. Load the latest version, then make your change again.',
        );
      }
      const data: Prisma.PlannedTripUncheckedUpdateInput = { version: { increment: 1 } };
      const fields: string[] = [];
      if (input.title !== undefined && input.title !== trip.title) {
        data.title = input.title;
        fields.push('title');
      }
      if (input.notes !== undefined) {
        data.notes = input.notes;
        fields.push('notes');
      }
      let datesChanged = false;
      if (input.startDate !== undefined && input.endDate !== undefined) {
        this.checkDates(input.startDate, input.endDate, trip.startDate);
        data.startDate = toDbDate(input.startDate);
        data.endDate = toDbDate(input.endDate);
        datesChanged = input.startDate !== trip.startDate || input.endDate !== trip.endDate;
        if (datesChanged) fields.push('dates');
      }
      let destinationChanged = false;
      if (input.destinationId !== undefined || input.destinationName !== undefined) {
        const destination = this.resolveDestination(
          input.destinationId ?? null,
          input.destinationName ?? null,
        );
        Object.assign(data, destination);
        destinationChanged =
          destination.destinationId !== trip.destinationId ||
          destination.destinationName !== trip.destinationName;
        if (destinationChanged) fields.push('destination');
      }
      if (input.preferences !== undefined) {
        Object.assign(data, toDbPreferences(input.preferences));
        fields.push('preferences');
      }
      if (input.bookingReference !== undefined) {
        data.bookingId =
          input.bookingReference === null
            ? null
            : await this.linkableBooking(tx, userId, input.bookingReference);
        fields.push('booking');
      }
      const updated = await tx.plannedTrip.update({
        where: { id: trip.id },
        data,
        select: { title: true, destinationName: true, startDate: true, endDate: true },
      });
      const revision = await recordActivity(tx, {
        tripId: trip.id,
        actorId: userId,
        type: 'TRIP_UPDATED',
        data: { fields },
        now: this.now(),
      });
      // Members hear about changes that affect their travel plans, not every edit.
      if (datesChanged || destinationChanged) {
        const actor = await tx.user.findUnique({
          where: { id: userId },
          select: { displayName: true },
        });
        const message = planMessages.planUpdated(
          actor?.displayName ?? null,
          updated.title,
          updated.destinationName,
          dateOnly(updated.startDate),
          dateOnly(updated.endDate),
        );
        for (const recipient of await tripAudience(tx, trip)) {
          if (recipient === userId) continue;
          await notify(tx, this.now(), {
            userId: recipient,
            ...message,
            isDemo: false,
            plannedTripId: trip.id,
            dedupeKey: `plan-updated:${trip.id}:${revision}:${recipient}`,
          });
        }
      }
    });
    return this.get(userId, tripId);
  }

  /** Deletes the plan with its itinerary, members, invitations and history (owner only). */
  async remove(userId: string, tripId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockTrip(tx, userId, tripId, 'manage');
      await tx.plannedTrip.delete({ where: { id: tripId } });
    });
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
          const trip = await this.lockTrip(tx, userId, tripId, 'edit');
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
              createdById: userId,
            },
            select: { id: true },
          });
          await recordActivity(tx, {
            tripId,
            actorId: userId,
            type: 'ITEM_ADDED',
            data: {
              itemId: item.id,
              title: input.title,
              day: input.day,
              fromSuggestion: Boolean(input.suggestionId),
            },
            now: this.now(),
          });
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
      const trip = await this.lockTrip(tx, userId, tripId, 'edit');
      const item = await tx.itineraryItem.findFirst({ where: { id: itemId, tripId } });
      if (!item) throw notFound(ITEM_NOT_FOUND);
      if (item.version !== input.version) throw outOfDate('body.version', ITEM_CHANGED);
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
      const changed = Object.keys(data).filter((k) => k !== 'day' && k !== 'position');
      if (Object.keys(data).length > 0) {
        await tx.itineraryItem.update({
          where: { id: item.id },
          data: { ...data, version: { increment: 1 } },
        });
        const title = input.title ?? item.title;
        const moved = toDay !== fromDay;
        await recordActivity(tx, {
          tripId,
          actorId: userId,
          type: moved ? 'ITEM_MOVED' : changed.length > 0 ? 'ITEM_UPDATED' : 'DAY_REORDERED',
          data: moved
            ? { itemId: item.id, title, from: fromDay, to: toDay, fields: changed }
            : changed.length > 0
              ? { itemId: item.id, title, day: fromDay, fields: changed }
              : { day: fromDay },
          now: this.now(),
        });
      }
    });
    return this.get(userId, tripId);
  }

  async deleteItem(userId: string, tripId: string, itemId: string): Promise<PlannedTripDto> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockTrip(tx, userId, tripId, 'edit');
      const item = await tx.itineraryItem.findFirst({ where: { id: itemId, tripId } });
      if (!item) throw notFound(ITEM_NOT_FOUND);
      await tx.itineraryItem.delete({ where: { id: item.id } });
      await tx.$executeRaw`
        UPDATE itinerary_items SET position = position - 1
        WHERE trip_id = ${tripId}::uuid AND day = ${dateOnly(item.day)}::date AND position > ${item.position}`;
      await recordActivity(tx, {
        tripId,
        actorId: userId,
        type: 'ITEM_DELETED',
        data: { itemId: item.id, title: item.title, day: dateOnly(item.day) },
        now: this.now(),
      });
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
          const trip = await this.lockTrip(tx, userId, tripId, 'edit');
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
              createdById: userId,
            },
            select: { id: true },
          });
          await recordActivity(tx, {
            tripId,
            actorId: userId,
            type: 'ITEM_DUPLICATED',
            data: { itemId: copy.id, sourceId: source.id, title: source.title, day },
            now: this.now(),
          });
          await complete(tx, copy.id);
          return copy.id;
        }),
    );
    return { trip: await this.get(userId, tripId), replayed: result.replayed };
  }

  /**
   * Sets the order of one day. `itemIds` must be exactly the activities on
   * that day, and `previousOrder` the day's current order: anything else means
   * the client's view is stale (someone else changed the day) or forged, and
   * nothing changes.
   */
  async reorderDay(
    userId: string,
    tripId: string,
    day: string,
    order: { itemIds: readonly string[]; previousOrder: readonly string[] },
  ): Promise<PlannedTripDto> {
    const { itemIds, previousOrder } = order;
    await this.prisma.$transaction(async (tx) => {
      await this.lockTrip(tx, userId, tripId, 'edit');
      const current = await tx.itineraryItem.findMany({
        where: { tripId, day: toDbDate(day) },
        select: { id: true, position: true },
        orderBy: { position: 'asc' },
      });
      const ids = new Set(current.map((i) => i.id));
      if (current.length !== itemIds.length || itemIds.some((id) => !ids.has(id))) {
        throw outOfDate(
          'body.itemIds',
          'This day changed since you loaded it (an activity was added, moved or deleted). Load the latest version, then reorder again.',
        );
      }
      if (current.map((i) => i.id).join() !== previousOrder.join()) {
        throw outOfDate(
          'body.previousOrder',
          'Someone else reordered this day since you loaded it. Load the latest order, then try again.',
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
      await recordActivity(tx, {
        tripId,
        actorId: userId,
        type: 'DAY_REORDERED',
        data: { day },
        now: this.now(),
      });
    });
    return this.get(userId, tripId);
  }

  // ─── Suggestions ──────────────────────────────────────────────────────

  async suggestions(
    userId: string,
    tripId: string,
    category?: PlannerInterest,
  ): Promise<SuggestionsResponse> {
    await tripAccess(this.prisma, userId, tripId, 'view');
    const trip = await this.prisma.plannedTrip.findUnique({
      where: { id: tripId },
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

  /** Locks the plan row for this transaction and checks the user's access (access.ts). */
  private lockTrip(
    tx: Tx,
    userId: string,
    tripId: string,
    need: 'edit' | 'manage',
  ): Promise<LockedTrip> {
    return tripAccess(tx, userId, tripId, need, { lock: true });
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
