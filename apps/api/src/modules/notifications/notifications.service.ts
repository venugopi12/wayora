import {
  EMAIL_NOT_CONFIGURED_STATUS,
  PUSH_NOT_CONFIGURED_STATUS,
  type PushSubscriptionInput,
  type PushSubscriptionResult,
  hasPermission,
  type UserRole,
  notificationCategory,
  type Notification,
  type NotificationListQuery,
  type NotificationListResponse,
  type NotificationPreferences,
  type NotificationType,
  type UpdateNotificationPreferences,
} from '@wayora/contracts';
import type { Prisma, PrismaClient } from '@wayora/database';
import { AppError } from '../../utils/errors.js';

/*
 * Reading and managing notifications (docs/notifications.md#api). Every query
 * is scoped to the signed-in user (`user_id = ?`); another user's
 * notification is "not found", exactly like one that doesn't exist.
 */

const NOT_FOUND_MESSAGE = "We couldn't find that notification.";

const include = {
  booking: { select: { reference: true, userId: true } },
  // Planner links (Phase 19): only while the recipient can still open them.
  plannedTrip: { select: { id: true, userId: true, members: { select: { userId: true } } } },
  tripInvitation: { select: { id: true, inviteeId: true } },
  // Support (Phase 27): the customer's own ticket, or the staff workspace while still staff.
  supportTicket: { select: { reference: true, userId: true } },
  user: { select: { role: true, status: true } },
} satisfies Prisma.NotificationInclude;
type Row = Prisma.NotificationGetPayload<{ include: typeof include }>;

/** Whether email delivery is configured (no email provider exists yet). */
export interface EmailStatus {
  active: boolean;
}

/** Browser push (Phase 30): the VAPID public key, when push is set up. */
export interface PushStatus {
  publicKey: string | null;
}

export class NotificationsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly email: EmailStatus = { active: false },
    private readonly now: () => Date = () => new Date(),
    private readonly push: PushStatus = { publicKey: null },
  ) {}

  private present(row: Row): Notification {
    const type = row.type.toLowerCase() as NotificationType;
    // A link only to the owner's own booking (always theirs; checked anyway).
    const booking = row.booking && row.booking.userId === row.userId ? row.booking : null;
    return {
      id: row.id,
      type,
      category: notificationCategory(type),
      title: row.title,
      message: row.message,
      demo: row.isDemo,
      read: row.readAt !== null,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      link:
        row.type === 'REVIEW'
          ? { kind: 'my-reviews' }
          : booking
            ? row.paymentId
              ? { kind: 'payment', bookingReference: booking.reference, paymentId: row.paymentId }
              : { kind: 'booking', bookingReference: booking.reference }
            : this.planLink(row),
    };
  }

  /** A plan or invitation link, if the recipient may still open it (else none). */
  private planLink(row: Row): Notification['link'] {
    const ticket = row.supportTicket;
    if (ticket) {
      if (ticket.userId === row.userId)
        return { kind: 'support-ticket', reference: ticket.reference };
      const role = row.user.role.toLowerCase() as UserRole;
      return row.user.status === 'ACTIVE' && hasPermission(role, 'admin.support.read')
        ? { kind: 'admin-support-ticket', reference: ticket.reference }
        : null;
    }
    const invitation = row.tripInvitation;
    if (invitation && invitation.inviteeId === row.userId) {
      return { kind: 'plan-invitation', invitationId: invitation.id };
    }
    const trip = row.plannedTrip;
    if (trip && (trip.userId === row.userId || trip.members.some((m) => m.userId === row.userId))) {
      return { kind: 'plan', tripId: trip.id };
    }
    return null;
  }

  unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  /** Newest first; ties broken by id, so pages never overlap or skip. */
  async list(
    userId: string,
    query: Required<Omit<NotificationListQuery, 'unread'>> & { unread?: 'true' | 'false' },
  ): Promise<NotificationListResponse> {
    const page = Number(query.page);
    const pageSize = Number(query.pageSize);
    const where: Prisma.NotificationWhereInput = {
      userId,
      ...(query.unread === 'true' ? { readAt: null } : {}),
    };
    const [rows, total, unread] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        include,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    return {
      items: rows.map((row) => this.present(row)),
      pagination: { page, pageSize, totalResults: total, totalPages: Math.ceil(total / pageSize) },
      unreadCount: unread,
    };
  }

  /** Marks one as read (idempotent: an already-read one keeps its time). */
  async markRead(userId: string, id: string): Promise<Notification> {
    await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: this.now() },
    });
    const row = await this.prisma.notification.findFirst({ where: { id, userId }, include });
    if (!row) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
    return this.present(row);
  }

  async markAllRead(userId: string): Promise<{ updated: number; unread: number }> {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: this.now() },
    });
    return { updated: count, unread: await this.unreadCount(userId) };
  }

  // ─── Preferences ────────────────────────────────────────────────────────

  private presentPreferences(
    row: {
      emailBookings: boolean;
      emailPayments: boolean;
      emailReminders: boolean;
      pushBookings: boolean;
      pushPayments: boolean;
      pushReminders: boolean;
      pushSupport: boolean;
      pushRewards: boolean;
    } | null,
  ): NotificationPreferences {
    return {
      emailBookings: row?.emailBookings ?? true,
      emailPayments: row?.emailPayments ?? true,
      emailReminders: row?.emailReminders ?? true,
      email: this.email.active
        ? { active: true, status: 'Emails are sent for the topics you choose.' }
        : { active: false, status: EMAIL_NOT_CONFIGURED_STATUS },
      pushBookings: row?.pushBookings ?? true,
      pushPayments: row?.pushPayments ?? true,
      pushReminders: row?.pushReminders ?? true,
      pushSupport: row?.pushSupport ?? true,
      pushRewards: row?.pushRewards ?? true,
      push: this.push.publicKey
        ? {
            active: true,
            status: 'Devices where you turn push on get the topics you choose.',
            publicKey: this.push.publicKey,
          }
        : { active: false, status: PUSH_NOT_CONFIGURED_STATUS, publicKey: null },
    };
  }

  async preferences(userId: string): Promise<NotificationPreferences> {
    return this.presentPreferences(
      await this.prisma.notificationPreference.findUnique({ where: { userId } }),
    );
  }

  async updatePreferences(
    userId: string,
    input: UpdateNotificationPreferences,
  ): Promise<NotificationPreferences> {
    const keys = [
      'emailBookings',
      'emailPayments',
      'emailReminders',
      'pushBookings',
      'pushPayments',
      'pushReminders',
      'pushSupport',
      'pushRewards',
    ] as const;
    const data: Partial<Record<(typeof keys)[number], boolean>> = {};
    for (const key of keys) if (input[key] !== undefined) data[key] = input[key];
    const row = await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return this.presentPreferences(row);
  }

  // ─── Browser push subscriptions (Phase 30, docs/pwa.md#push) ──────────

  /**
   * Saves this browser's push subscription for the signed-in user and this
   * session. An endpoint is one browser profile: if another account turned
   * push on in it before (a shared device), it now belongs to this account
   * only, so the previous account's notifications stop reaching it.
   */
  async subscribePush(
    userId: string,
    sessionId: string,
    input: PushSubscriptionInput,
  ): Promise<PushSubscriptionResult> {
    if (!this.push.publicKey) {
      throw new AppError('SERVICE_UNAVAILABLE', PUSH_NOT_CONFIGURED_STATUS);
    }
    const fields = {
      userId,
      sessionId,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      expiresAt:
        input.expirationTime === null || input.expirationTime === undefined
          ? null
          : new Date(input.expirationTime),
      failureCount: 0,
    };
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: { endpoint: input.endpoint, ...fields },
      update: fields,
    });
    return { subscribed: true };
  }

  /** Removes this browser's subscription (only if it's the signed-in user's). */
  async unsubscribePush(userId: string, endpoint: string): Promise<PushSubscriptionResult> {
    await this.prisma.pushSubscription.deleteMany({ where: { endpoint, userId } });
    return { subscribed: false };
  }
}
