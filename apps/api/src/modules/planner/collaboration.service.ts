import {
  COLLABORATION_LIMITS,
  type InvitationResponse,
  type MemberRole,
  type PlannerActivity,
  type PlannerActivityList,
  type PlannerActivityType,
  type ReceivedInvitation,
  type ReceivedInvitationList,
  type SentInvitation,
  type TripMembers,
} from '@wayora/contracts';
import {
  Prisma,
  type PlannerActivityType as DbActivityType,
  type PrismaClient,
  type TripMemberRole,
} from '@wayora/database';
import { AppError, notFound } from '../../utils/errors.js';
import { notify } from '../notifications/notify.js';
import { recordActivity, tripAccess } from './access.js';
import { planMessages } from './messages.js';
import { accessFor, initials, maskEmail, personName } from './people.js';
import { dateOnly } from './presenter.js';

/*
 * Plan collaboration (docs/planner.md#collaboration): members, invitations
 * and the shared activity history.
 *
 * Rules:
 * - Only the owner invites, changes roles and removes members. Members may
 *   leave. The owner is planned_trips.user_id: never a member, never invited,
 *   so the plan always has exactly one owner and it can't be removed or
 *   demoted (database triggers enforce it too).
 * - An invitation is for one existing account, and only that account,
 *   signed in, can see, accept or decline it. There is no token: knowing an
 *   invitation's id gives nobody else anything.
 * - Membership changes lock the plan row (like itinerary writes), so they
 *   are serialized with each other and with edits: a removed member's next
 *   request is refused. Accepting locks the plan, then the invitation, so
 *   concurrent accepts (or accept vs revoke) settle one way only.
 * - Every change is one history row (recordActivity) and, where someone
 *   should know, one in-app notification (deduplicated by key).
 */

type Tx = Prisma.TransactionClient;

const INVITATION_NOT_FOUND = 'This invitation doesn’t exist, or it isn’t addressed to you.';
const MEMBER_NOT_FOUND = 'That person isn’t a member of this plan.';
const DAY_MS = 24 * 60 * 60 * 1000;

const toRole = (r: TripMemberRole) => r.toLowerCase() as MemberRole;
const fromRole = (r: MemberRole) => r.toUpperCase() as TripMemberRole;

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

const validation = (path: string, message: string) =>
  new AppError('VALIDATION_FAILED', 'The request is invalid.', {
    details: [{ path, message, code: 'custom' }],
  });

export class CollaborationService {
  private readonly prisma: PrismaClient;
  private readonly now: () => Date;

  constructor(options: { prisma: PrismaClient; now?: () => Date }) {
    this.prisma = options.prisma;
    this.now = options.now ?? (() => new Date());
  }

  // ─── Members ──────────────────────────────────────────────────────────

  /** Owner, members and (for the owner) open invitations. Any member may look. */
  async members(userId: string, tripId: string): Promise<TripMembers> {
    const access = await tripAccess(this.prisma, userId, tripId, 'view');
    const now = this.now();
    const [owner, members, invitations] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: access.ownerId },
        select: { displayName: true },
      }),
      this.prisma.tripMember.findMany({
        where: { tripId },
        orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
        include: { user: { select: { displayName: true } } },
      }),
      access.role === 'owner'
        ? this.prisma.tripInvitation.findMany({
            where: { tripId, status: 'PENDING', expiresAt: { gt: now } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            include: { invitee: { select: { id: true, displayName: true, email: true } } },
          })
        : Promise.resolve([]),
    ]);
    const ownerName = personName(owner.displayName);
    const used = members.length + (await this.openInvitationCount(this.prisma, tripId, now));
    return {
      owner: { name: ownerName, initials: initials(ownerName), isYou: access.ownerId === userId },
      members: members.map((m) => {
        const name = personName(m.user.displayName);
        return {
          id: m.id,
          name,
          initials: initials(name),
          isYou: m.userId === userId,
          role: toRole(m.role),
          joinedAt: m.joinedAt.toISOString(),
        };
      }),
      invitations: invitations.map((i) => this.presentSent(i, userId)),
      access: accessFor(access.role),
      limits: { maxMembers: COLLABORATION_LIMITS.maxMembers, used },
    };
  }

  /** Changes a member's role (owner only). Ownership itself can't be given. */
  async changeRole(
    userId: string,
    tripId: string,
    memberId: string,
    role: MemberRole,
  ): Promise<TripMembers> {
    await this.prisma.$transaction(async (tx) => {
      const trip = await tripAccess(tx, userId, tripId, 'manage', { lock: true });
      const member = await tx.tripMember.findFirst({ where: { id: memberId, tripId } });
      if (!member) throw notFound(MEMBER_NOT_FOUND);
      if (member.role === fromRole(role)) return;
      await tx.tripMember.update({ where: { id: member.id }, data: { role: fromRole(role) } });
      const revision = await recordActivity(tx, {
        tripId,
        actorId: userId,
        type: 'MEMBER_ROLE_CHANGED',
        data: { memberUserId: member.userId, from: toRole(member.role), to: role },
        now: this.now(),
      });
      await notify(tx, this.now(), {
        userId: member.userId,
        ...planMessages.roleChanged(trip.title, role),
        isDemo: false,
        plannedTripId: tripId,
        dedupeKey: `plan-role:${tripId}:${revision}`,
      });
    });
    return this.members(userId, tripId);
  }

  /**
   * Removes a member. The owner may remove anyone; a member may remove only
   * themselves (leave). Takes effect for their very next request.
   */
  async removeMember(userId: string, tripId: string, memberId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const trip = await tripAccess(tx, userId, tripId, 'view', { lock: true });
      const member = await tx.tripMember.findFirst({ where: { id: memberId, tripId } });
      if (!member) throw notFound(MEMBER_NOT_FOUND);
      const leaving = member.userId === userId;
      if (!leaving && trip.role !== 'owner') {
        throw new AppError('FORBIDDEN', 'Only the plan’s owner can remove other members.');
      }
      await tx.tripMember.delete({ where: { id: member.id } });
      const revision = await recordActivity(tx, {
        tripId,
        actorId: userId,
        type: leaving ? 'MEMBER_LEFT' : 'MEMBER_REMOVED',
        data: { memberUserId: member.userId },
        now: this.now(),
      });
      if (leaving) {
        const me = await tx.user.findUnique({
          where: { id: userId },
          select: { displayName: true },
        });
        await notify(tx, this.now(), {
          userId: trip.ownerId,
          ...planMessages.memberLeft(me?.displayName ?? null, trip.title),
          isDemo: false,
          plannedTripId: tripId,
          dedupeKey: `plan-left:${tripId}:${revision}`,
        });
      } else {
        await notify(tx, this.now(), {
          userId: member.userId,
          ...planMessages.removed(trip.title),
          isDemo: false,
          // No link: they can't open the plan any more.
          dedupeKey: `plan-removed:${tripId}:${revision}`,
        });
      }
    });
  }

  // ─── Invitations (owner side) ─────────────────────────────────────────

  /**
   * Invites an existing, active account by email (owner only). Refused for
   * the owner, existing members, someone already invited, unknown addresses
   * and full plans. One open invitation per person (a unique index).
   */
  async invite(
    userId: string,
    tripId: string,
    input: { email: string; role: MemberRole },
  ): Promise<SentInvitation> {
    const now = this.now();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const trip = await tripAccess(tx, userId, tripId, 'manage', { lock: true });
        const invitee = await tx.user.findFirst({
          where: { email: input.email, status: 'ACTIVE' },
          select: { id: true, displayName: true, email: true },
        });
        if (!invitee) {
          throw validation(
            'body.email',
            'There’s no Wayora account with that email. Ask them to create one, then invite them.',
          );
        }
        if (invitee.id === trip.ownerId) {
          throw validation('body.email', 'That’s you — you already own this plan.');
        }
        if (await tx.tripMember.findFirst({ where: { tripId, userId: invitee.id } })) {
          throw new AppError('CONFLICT', 'That person is already a member of this plan.');
        }
        await this.expireStale(tx, { tripId }, now);
        if (
          await tx.tripInvitation.findFirst({
            where: { tripId, inviteeId: invitee.id, status: 'PENDING' },
          })
        ) {
          throw new AppError(
            'CONFLICT',
            'That person already has an open invitation to this plan.',
          );
        }
        const members = await tx.tripMember.count({ where: { tripId } });
        if (
          members + (await this.openInvitationCount(tx, tripId, now)) >=
          COLLABORATION_LIMITS.maxMembers
        ) {
          throw new AppError(
            'PLAN_LIMIT_REACHED',
            `A plan can have up to ${COLLABORATION_LIMITS.maxMembers} members and open invitations.`,
          );
        }
        const invitation = await tx.tripInvitation.create({
          data: {
            tripId,
            inviteeId: invitee.id,
            invitedById: userId,
            role: fromRole(input.role),
            expiresAt: new Date(now.getTime() + COLLABORATION_LIMITS.invitationDays * DAY_MS),
            createdAt: now,
          },
        });
        await recordActivity(tx, {
          tripId,
          actorId: userId,
          type: 'MEMBER_INVITED',
          data: { invitationId: invitation.id, inviteeId: invitee.id, role: input.role },
          now,
        });
        const inviter = await tx.user.findUnique({
          where: { id: userId },
          select: { displayName: true },
        });
        await notify(tx, now, {
          userId: invitee.id,
          ...planMessages.invitation(inviter?.displayName ?? null, trip.title, input.role),
          isDemo: false,
          tripInvitationId: invitation.id,
          dedupeKey: `plan-invitation:${invitation.id}`,
        });
        return this.presentSent({ ...invitation, invitee }, userId);
      });
    } catch (error) {
      // Two invitations for the same person at once: the unique index keeps one.
      if (isUniqueViolation(error)) {
        throw new AppError('CONFLICT', 'That person already has an open invitation to this plan.');
      }
      throw error;
    }
  }

  /** Revokes an open invitation (owner only). */
  async revoke(userId: string, tripId: string, invitationId: string): Promise<SentInvitation> {
    const now = this.now();
    return this.prisma.$transaction(async (tx) => {
      await tripAccess(tx, userId, tripId, 'manage', { lock: true });
      const invitation = await tx.tripInvitation.findFirst({
        where: { id: invitationId, tripId },
        include: { invitee: { select: { id: true, displayName: true, email: true } } },
      });
      if (!invitation) throw notFound('That invitation doesn’t exist.');
      if (invitation.status !== 'PENDING' || invitation.expiresAt <= now) {
        throw new AppError('INVITATION_CLOSED', 'That invitation is no longer open.');
      }
      const updated = await tx.tripInvitation.update({
        where: { id: invitation.id },
        data: { status: 'REVOKED', respondedAt: now },
      });
      await recordActivity(tx, {
        tripId,
        actorId: userId,
        type: 'INVITATION_REVOKED',
        data: { invitationId: invitation.id, inviteeId: invitation.inviteeId },
        now,
      });
      return this.presentSent({ ...updated, invitee: invitation.invitee }, userId);
    });
  }

  // ─── Invitations (recipient side) ─────────────────────────────────────

  /** Invitations addressed to the user: open ones by default. */
  async received(userId: string, status: 'pending' | 'all'): Promise<ReceivedInvitationList> {
    const now = this.now();
    const rows = await this.prisma.tripInvitation.findMany({
      where: {
        inviteeId: userId,
        ...(status === 'pending' ? { status: 'PENDING', expiresAt: { gt: now } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
      include: RECEIVED_INCLUDE,
    });
    return { items: rows.map((r) => this.presentReceived(r)) };
  }

  async receivedOne(userId: string, invitationId: string): Promise<ReceivedInvitation> {
    const row = await this.prisma.tripInvitation.findFirst({
      where: { id: invitationId, inviteeId: userId },
      include: RECEIVED_INCLUDE,
    });
    if (!row) throw notFound(INVITATION_NOT_FOUND);
    return this.presentReceived(row);
  }

  /** Accepts (joins the plan with the invited role) or declines. Recipient only, once. */
  async respond(
    userId: string,
    invitationId: string,
    answer: 'accept' | 'decline',
  ): Promise<InvitationResponse> {
    const now = this.now();
    // Find the plan first (only via an invitation addressed to this user).
    const target = await this.prisma.tripInvitation.findFirst({
      where: { id: invitationId, inviteeId: userId },
      select: { tripId: true },
    });
    if (!target) throw notFound(INVITATION_NOT_FOUND);

    const outcome = await this.prisma.$transaction(async (tx) => {
      // Lock order: plan, then invitation (as revoke does), so they serialize.
      const [trip] = await tx.$queryRaw<{ id: string; user_id: string; title: string }[]>`
        SELECT id, user_id, title FROM planned_trips WHERE id = ${target.tripId}::uuid FOR UPDATE`;
      if (!trip) throw notFound(INVITATION_NOT_FOUND);
      const [invitation] = await tx.$queryRaw<
        { id: string; status: string; role: TripMemberRole; expires_at: Date }[]
      >`SELECT id, status, role, expires_at FROM trip_invitations
         WHERE id = ${invitationId}::uuid AND invitee_id = ${userId}::uuid FOR UPDATE`;
      if (!invitation) throw notFound(INVITATION_NOT_FOUND);
      if (invitation.status !== 'PENDING') return { closed: invitation.status } as const;
      if (invitation.expires_at <= now) {
        await tx.tripInvitation.update({
          where: { id: invitation.id },
          data: { status: 'EXPIRED' },
        });
        return { closed: 'EXPIRED' } as const;
      }
      await tx.tripInvitation.update({
        where: { id: invitation.id },
        data: { status: answer === 'accept' ? 'ACCEPTED' : 'DECLINED', respondedAt: now },
      });
      if (answer === 'accept') {
        await tx.tripMember.create({
          data: {
            tripId: trip.id,
            userId,
            role: invitation.role,
            invitedById: trip.user_id,
            joinedAt: now,
            createdAt: now,
          },
        });
      }
      await recordActivity(tx, {
        tripId: trip.id,
        actorId: userId,
        type: answer === 'accept' ? 'INVITATION_ACCEPTED' : 'INVITATION_DECLINED',
        data: { invitationId: invitation.id, role: toRole(invitation.role) },
        now,
      });
      const me = await tx.user.findUnique({ where: { id: userId }, select: { displayName: true } });
      await notify(tx, now, {
        userId: trip.user_id,
        ...(answer === 'accept'
          ? planMessages.invitationAccepted(me?.displayName ?? null, trip.title)
          : planMessages.invitationDeclined(me?.displayName ?? null, trip.title)),
        isDemo: false,
        plannedTripId: trip.id,
        dedupeKey: `plan-invitation-${answer}:${invitation.id}`,
      });
      return { tripId: answer === 'accept' ? trip.id : null } as const;
    });

    if ('closed' in outcome) {
      const reason: Record<string, string> = {
        ACCEPTED: 'You’ve already accepted this invitation.',
        DECLINED: 'You’ve already declined this invitation.',
        REVOKED: 'The owner withdrew this invitation.',
        EXPIRED: 'This invitation has expired. Ask the owner to invite you again.',
      };
      throw new AppError(
        'INVITATION_CLOSED',
        reason[String(outcome.closed)] ?? 'This invitation is closed.',
      );
    }
    return { invitation: await this.receivedOne(userId, invitationId), tripId: outcome.tripId };
  }

  // ─── Activity history ────────────────────────────────────────────────

  /** The plan's change history, newest first (any member). */
  async activity(
    userId: string,
    tripId: string,
    query: { before?: number | undefined; limit: number },
  ): Promise<PlannerActivityList> {
    await tripAccess(this.prisma, userId, tripId, 'view');
    const rows = await this.prisma.plannerActivity.findMany({
      where: { tripId, ...(query.before ? { revision: { lt: query.before } } : {}) },
      orderBy: { revision: 'desc' },
      take: query.limit + 1,
      include: { actor: { select: { id: true, displayName: true } } },
    });
    const page = rows.slice(0, query.limit);
    // Names of people the entries mention, in one query (no N+1).
    const subjectIds = new Set<string>();
    for (const r of page) {
      const data = r.data as Record<string, unknown>;
      for (const key of ['memberUserId', 'inviteeId']) {
        if (typeof data[key] === 'string') subjectIds.add(data[key]);
      }
    }
    const subjects = subjectIds.size
      ? await this.prisma.user.findMany({
          where: { id: { in: [...subjectIds] } },
          select: { id: true, displayName: true },
        })
      : [];
    const names = new Map(subjects.map((u) => [u.id, personName(u.displayName)]));
    return {
      items: page.map((r) => describeActivity(r, userId, names)),
      nextBefore: rows.length > query.limit ? (page.at(-1)?.revision ?? null) : null,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  /** Marks open invitations past their expiry as EXPIRED (frees the one-pending slot). */
  private async expireStale(tx: Tx, where: { tripId: string }, now: Date): Promise<void> {
    await tx.tripInvitation.updateMany({
      where: { ...where, status: 'PENDING', expiresAt: { lte: now } },
      data: { status: 'EXPIRED' },
    });
  }

  private openInvitationCount(db: PrismaClient | Tx, tripId: string, now: Date): Promise<number> {
    return db.tripInvitation.count({
      where: { tripId, status: 'PENDING', expiresAt: { gt: now } },
    });
  }

  private presentSent(
    i: {
      id: string;
      role: TripMemberRole;
      status: string;
      expiresAt: Date;
      createdAt: Date;
      invitee: { id: string; displayName: string | null; email: string };
    },
    viewerId: string,
  ): SentInvitation {
    const name = personName(i.invitee.displayName);
    const expired = i.status === 'PENDING' && i.expiresAt <= this.now();
    return {
      id: i.id,
      invitee: {
        name,
        initials: initials(name),
        isYou: i.invitee.id === viewerId,
        emailMasked: maskEmail(i.invitee.email),
      },
      role: toRole(i.role),
      status: expired ? 'expired' : (i.status.toLowerCase() as SentInvitation['status']),
      createdAt: i.createdAt.toISOString(),
      expiresAt: i.expiresAt.toISOString(),
    };
  }

  private presentReceived(
    r: Prisma.TripInvitationGetPayload<{ include: typeof RECEIVED_INCLUDE }>,
  ): ReceivedInvitation {
    const expired = r.status === 'PENDING' && r.expiresAt <= this.now();
    return {
      id: r.id,
      trip: {
        id: r.trip.id,
        title: r.trip.title,
        destinationName: r.trip.destinationName,
        startDate: dateOnly(r.trip.startDate),
        endDate: dateOnly(r.trip.endDate),
      },
      invitedBy: r.invitedBy ? { name: personName(r.invitedBy.displayName) } : null,
      role: toRole(r.role),
      status: expired ? 'expired' : (r.status.toLowerCase() as ReceivedInvitation['status']),
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
    };
  }
}

const RECEIVED_INCLUDE = {
  trip: {
    select: { id: true, title: true, destinationName: true, startDate: true, endDate: true },
  },
  invitedBy: { select: { displayName: true } },
} satisfies Prisma.TripInvitationInclude;

// ─── Readable history ─────────────────────────────────────────────────────

const FIELD_LABEL: Record<string, string> = {
  title: 'name',
  notes: 'notes',
  dates: 'dates',
  destination: 'destination',
  preferences: 'preferences',
  booking: 'linked booking',
  category: 'category',
  startMinute: 'start time',
  durationMinutes: 'duration',
  location: 'location',
};

const list = (fields: unknown) =>
  Array.isArray(fields)
    ? fields.map((f) => FIELD_LABEL[String(f)] ?? null).filter((f): f is string => f !== null)
    : [];
const join = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

function describeActivity(
  row: {
    revision: number;
    type: DbActivityType;
    data: Prisma.JsonValue;
    createdAt: Date;
    actor: { id: string; displayName: string | null } | null;
  },
  viewerId: string,
  names: Map<string, string>,
): PlannerActivity {
  const d = (row.data ?? {}) as Record<string, unknown>;
  const actorName = row.actor ? personName(row.actor.displayName) : null;
  const who = row.actor?.id === viewerId ? 'You' : (actorName ?? 'A former member');
  const title = typeof d.title === 'string' ? `“${d.title}”` : 'an activity';
  const subject = (key: string) => {
    const id = d[key];
    if (typeof id !== 'string') return 'someone';
    return id === viewerId ? 'you' : (names.get(id) ?? 'a former member');
  };
  const role = (key: string) => (d[key] === 'editor' ? 'editor' : 'viewer');
  let summary: string;
  let day: string | null = typeof d.day === 'string' ? d.day : null;
  switch (row.type) {
    case 'TRIP_UPDATED': {
      const fields = list(d.fields);
      summary = fields.length
        ? `${who} changed the plan’s ${join(fields)}`
        : `${who} saved the plan’s details`;
      break;
    }
    case 'ITEM_ADDED':
      summary = `${who} added ${title}${d.fromSuggestion ? ' (from sample suggestions)' : ''}`;
      break;
    case 'ITEM_UPDATED': {
      const fields = list(d.fields);
      summary = fields.length
        ? `${who} changed the ${join(fields)} of ${title}`
        : `${who} edited ${title}`;
      break;
    }
    case 'ITEM_MOVED':
      summary = `${who} moved ${title} to another day`;
      day = typeof d.to === 'string' ? d.to : null;
      break;
    case 'ITEM_DELETED':
      summary = `${who} deleted ${title}`;
      break;
    case 'ITEM_DUPLICATED':
      summary = `${who} duplicated ${title}`;
      break;
    case 'DAY_REORDERED':
      summary = `${who} reordered a day`;
      break;
    case 'MEMBER_INVITED':
      summary = `${who} invited ${subject('inviteeId')} as ${role('role')}`;
      break;
    case 'INVITATION_ACCEPTED':
      summary = `${who} joined the plan as ${role('role')}`;
      break;
    case 'INVITATION_DECLINED':
      summary = `${who} declined the invitation`;
      break;
    case 'INVITATION_REVOKED':
      summary = `${who} withdrew the invitation to ${subject('inviteeId')}`;
      break;
    case 'MEMBER_ROLE_CHANGED':
      summary = `${who} made ${subject('memberUserId')} ${role('to') === 'editor' ? 'an editor' : 'a viewer'}`;
      break;
    case 'MEMBER_REMOVED':
      summary = `${who} removed ${subject('memberUserId')} from the plan`;
      break;
    case 'MEMBER_LEFT':
      summary = `${who} left the plan`;
      break;
  }
  return {
    revision: row.revision,
    type: row.type.toLowerCase() as PlannerActivityType,
    actor: actorName
      ? { name: actorName, initials: initials(actorName), isYou: row.actor?.id === viewerId }
      : null,
    summary,
    day,
    createdAt: row.createdAt.toISOString(),
  };
}
