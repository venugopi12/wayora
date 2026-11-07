import {
  EMAIL_NOT_CONFIGURED_STATUS,
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

export class NotificationsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly email: EmailStatus = { active: false },
    private readonly now: () => Date = () => new Date(),
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
      link: booking
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
    row: { emailBookings: boolean; emailPayments: boolean; emailReminders: boolean } | null,
  ): NotificationPreferences {
    return {
      emailBookings: row?.emailBookings ?? true,
      emailPayments: row?.emailPayments ?? true,
      emailReminders: row?.emailReminders ?? true,
      email: this.email.active
        ? { active: true, status: 'Emails are sent for the topics you choose.' }
        : { active: false, status: EMAIL_NOT_CONFIGURED_STATUS },
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
    const data = {
      ...(input.emailBookings !== undefined ? { emailBookings: input.emailBookings } : {}),
      ...(input.emailPayments !== undefined ? { emailPayments: input.emailPayments } : {}),
      ...(input.emailReminders !== undefined ? { emailReminders: input.emailReminders } : {}),
    };
    const row = await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return this.presentPreferences(row);
  }
}
