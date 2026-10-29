import type { TripRole } from '@wayora/contracts';
import { Prisma, type PlannerActivityType, type PrismaClient } from '@wayora/database';
import { AppError, notFound } from '../../utils/errors.js';
import { dateOnly } from './presenter.js';

/*
 * Who may do what with a plan (docs/planner.md#roles-and-permissions).
 *
 *            view  edit itinerary/details  invite/roles/remove  link booking  delete
 *   owner     ✓            ✓                       ✓                 ✓           ✓
 *   editor    ✓            ✓
 *   viewer    ✓
 *
 * Every planner request resolves access here, from the database, for the
 * signed-in user: the owner is planned_trips.user_id, members are rows in
 * trip_members. Someone who is neither gets the same 404 as for a plan that
 * doesn't exist, so knowing a plan id reveals nothing. A member without the
 * needed role gets 403 (they already know the plan exists).
 *
 * Writes pass `lock: true`: the plan row is locked (FOR UPDATE) before access
 * is checked, and membership changes lock it too, so a member removed a
 * moment ago can't slip a change in afterwards.
 */

type Db = PrismaClient | Prisma.TransactionClient;
export type Need = 'view' | 'edit' | 'manage';

export const TRIP_NOT_FOUND = 'This planned trip doesn’t exist, or you don’t have access to it.';

export interface TripContext {
  id: string;
  ownerId: string;
  title: string;
  destinationId: string | null;
  destinationName: string;
  startDate: string;
  endDate: string;
  version: number;
  revision: number;
  role: TripRole;
}

const ALLOWED: Record<Need, readonly TripRole[]> = {
  view: ['owner', 'editor', 'viewer'],
  edit: ['owner', 'editor'],
  manage: ['owner'],
};

const FORBIDDEN: Record<Exclude<Need, 'view'>, string> = {
  edit: 'You can view this plan but not change it. Ask its owner for editor access.',
  manage: 'Only the plan’s owner can do that.',
};

export async function tripAccess(
  db: Db,
  userId: string,
  tripId: string,
  need: Need,
  options: { lock?: boolean } = {},
): Promise<TripContext> {
  const rows = await db.$queryRaw<
    {
      id: string;
      user_id: string;
      title: string;
      destination_id: string | null;
      destination_name: string;
      start_date: Date;
      end_date: Date;
      version: number;
      revision: number;
      role: string | null;
    }[]
  >`SELECT t.id, t.user_id, t.title, t.destination_id, t.destination_name, t.start_date,
           t.end_date, t.version, t.revision,
           CASE WHEN t.user_id = ${userId}::uuid THEN 'owner' ELSE lower(m.role::text) END AS role
      FROM planned_trips t
      LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ${userId}::uuid
     WHERE t.id = ${tripId}::uuid AND (t.user_id = ${userId}::uuid OR m.id IS NOT NULL)
     ${options.lock ? Prisma.sql`FOR UPDATE OF t` : Prisma.empty}`;
  const row = rows[0];
  if (!row?.role) throw notFound(TRIP_NOT_FOUND);
  const role = row.role as TripRole;
  if (!ALLOWED[need].includes(role)) {
    throw new AppError('FORBIDDEN', FORBIDDEN[need as Exclude<Need, 'view'>]);
  }
  return {
    id: row.id,
    ownerId: row.user_id,
    title: row.title,
    destinationId: row.destination_id,
    destinationName: row.destination_name,
    startDate: dateOnly(row.start_date),
    endDate: dateOnly(row.end_date),
    version: row.version,
    revision: row.revision,
    role,
  };
}

/** Whether a user can still see a plan (live-update streams re-check this). */
export async function canView(db: Db, userId: string, tripId: string): Promise<boolean> {
  try {
    await tripAccess(db, userId, tripId, 'view');
    return true;
  } catch (error) {
    if (error instanceof AppError) return false;
    throw error;
  }
}

/**
 * Records one change: bumps the plan's revision and appends the matching
 * history row, in the caller's transaction (with the plan row locked). The
 * (trip, revision) pair is unique, so a change is recorded exactly once;
 * an idempotent retry that replays a stored outcome records nothing.
 * Returns the new revision.
 */
export async function recordActivity(
  tx: Prisma.TransactionClient,
  input: {
    tripId: string;
    actorId: string | null;
    type: PlannerActivityType;
    data: Record<string, unknown>;
    now: Date;
  },
): Promise<number> {
  const [row] = await tx.$queryRaw<{ revision: number }[]>`
    UPDATE planned_trips SET revision = revision + 1, updated_at = ${input.now}
     WHERE id = ${input.tripId}::uuid RETURNING revision`;
  const revision = row!.revision;
  await tx.plannerActivity.create({
    data: {
      tripId: input.tripId,
      revision,
      actorId: input.actorId,
      type: input.type,
      data: input.data as Prisma.InputJsonValue,
      createdAt: input.now,
    },
  });
  return revision;
}

/** Everyone who can see a plan: its owner and members (for notifications). */
export async function tripAudience(
  tx: Prisma.TransactionClient,
  trip: Pick<TripContext, 'id' | 'ownerId'>,
): Promise<string[]> {
  const members = await tx.tripMember.findMany({
    where: { tripId: trip.id },
    select: { userId: true },
  });
  return [trip.ownerId, ...members.map((m) => m.userId)];
}
