import { randomInt } from 'node:crypto';
import {
  ACTIVE_SUPPORT_STATUSES,
  SUPPORT_REFERENCE_ALPHABET,
  SUPPORT_STATUS_LABEL,
  canTransition,
  hasPermission,
  supportBookingContextSchema,
  type AdminSupportEvent,
  type AdminSupportMessage,
  type AdminSupportMessagePage,
  type AdminSupportTicket,
  type AdminSupportTicketList,
  type AdminSupportTicketSummary,
  type Booking,
  type SupportAiSuggestion,
  type SupportBookingContext,
  type SupportCategory,
  type SupportMessage,
  type SupportMessagePage,
  type SupportMetrics,
  type SupportPriority,
  type SupportStaff,
  type SupportStatus,
  type SupportTicket,
  type SupportTicketList,
  type SupportTicketSummary,
  type UserRole,
} from '@wayora/contracts';
import type {
  adminSupportListQuerySchema,
  adminSupportReplySchema,
  createSupportTicketSchema,
  supportListQuerySchema,
  supportMessageInputSchema,
} from '@wayora/contracts';
import type { z } from 'zod';
import {
  Prisma,
  type PrismaClient,
  type SupportAuthorKind,
  type SupportEventType,
  type SupportTicketCategory,
  type SupportTicketPriority,
  type SupportTicketStatus,
} from '@wayora/database';
import { AppError } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import { errorForLog } from '../../utils/log-safety.js';
import type { AssistantProvider } from '../assistant/provider.js';
import { AssistantProviderError } from '../assistant/provider.js';
import { notify } from '../notifications/notify.js';
import { suggest, supportAiAvailable, type SupportAiInput } from './ai.js';
import {
  allowedFor,
  assignableRole,
  isActive,
  medianMinutes,
  share,
  targetState,
  targetsFor,
  type Viewer,
} from './rules.js';

/*
 * Customer support (Phase 27, docs/support.md).
 *
 * - Customers see only their own tickets (another customer's reference is
 *   "not found", exactly like one that doesn't exist) and only public
 *   messages; internal notes never leave the staff methods.
 * - Every change runs in one transaction with the ticket row locked: it bumps
 *   `revision`, appends a history row with that sequence number (announced to
 *   live streams on commit), and writes its notifications in the same
 *   transaction (deduplicated per event and recipient).
 * - Status changes are validated here and again by a database trigger.
 * - Linking a booking checks it belongs to the customer; its context is read
 *   from Wayora's own records, never from the request. Opening a ticket never
 *   changes the booking.
 */

type Tx = Prisma.TransactionClient;
type CreateInput = z.output<typeof createSupportTicketSchema>;
type MessageInput = z.output<typeof supportMessageInputSchema>;
type ReplyInput = z.output<typeof adminSupportReplySchema>;
type AdminListQuery = z.output<typeof adminSupportListQuerySchema>;
type ListQuery = z.output<typeof supportListQuerySchema>;

export interface StaffUser {
  id: string;
  role: UserRole;
  name: string;
}
export interface RequestContext {
  requestId?: string | undefined;
}

export interface SupportServiceOptions {
  prisma: PrismaClient;
  logger: Logger;
  /** Reads a customer's booking as they see it (owner-scoped). Absent: no booking context (maintenance). */
  bookings?: { get(userId: string, reference: string): Promise<Booking> } | undefined;
  /** The assistant's provider (null: AI suggestions off). */
  ai?: { provider: AssistantProvider | null; timeoutMs: number; maxOutputTokens: number };
  /** Resolved tickets close by themselves after this many days without a reply. */
  autoCloseDays?: number;
  now?: () => Date;
}

const NOT_FOUND = "We couldn't find that ticket.";
const STALE = 'This ticket changed since you opened it. Review the latest version and try again.';
const CLOSED = 'This ticket is closed. To ask something new, open a new ticket.';

const lower = <T extends string>(v: string) => v.toLowerCase() as T;
const upper = <T extends string>(v: string) => v.toUpperCase() as T;
const firstName = (name: string) => name.trim().split(/\s+/)[0] || 'Support';
/** Display names are optional on accounts. */
const customerName = (u: { displayName: string | null }) => u.displayName?.trim() || 'Customer';
const staffName = (u: { displayName: string | null } | null) =>
  u?.displayName?.trim() || 'Support team member';

function newReference(): string {
  const pick = () => SUPPORT_REFERENCE_ALPHABET[randomInt(SUPPORT_REFERENCE_ALPHABET.length)];
  const group = () => Array.from({ length: 4 }, pick).join('');
  return `WYS-${group()}-${group()}`;
}

const isUnique = (e: unknown, target?: string) =>
  e instanceof Prisma.PrismaClientKnownRequestError &&
  e.code === 'P2002' &&
  (!target || JSON.stringify(e.meta ?? {}).includes(target));

const ticketInclude = {
  user: { select: { id: true, displayName: true, email: true } },
  assignee: { select: { id: true, displayName: true, role: true } },
  booking: { select: { reference: true, userId: true } },
} satisfies Prisma.SupportTicketInclude;
type TicketRow = Prisma.SupportTicketGetPayload<{ include: typeof ticketInclude }>;

const ACTIVE_DB = ACTIVE_SUPPORT_STATUSES.map((s) => upper<SupportTicketStatus>(s));

export class SupportService {
  private readonly prisma: PrismaClient;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(private readonly options: SupportServiceOptions) {
    this.prisma = options.prisma;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
  }

  get aiAvailable(): boolean {
    return supportAiAvailable(this.options.ai?.provider ?? null);
  }

  // ─── Shared write helpers ──────────────────────────────────────────────

  /** Locks the ticket row for this transaction and returns it. */
  private async lock(tx: Tx, ticketId: string): Promise<TicketRow> {
    await tx.$queryRaw`SELECT id FROM support_tickets WHERE id = ${ticketId}::uuid FOR UPDATE`;
    return tx.supportTicket.findUniqueOrThrow({ where: { id: ticketId }, include: ticketInclude });
  }

  /** Next sequence number (the ticket's new revision). */
  private async bump(tx: Tx, ticketId: string, data: Prisma.SupportTicketUpdateInput = {}) {
    const t = await tx.supportTicket.update({
      where: { id: ticketId },
      data: { ...data, revision: { increment: 1 } },
      select: { revision: true },
    });
    return t.revision;
  }

  private async event(
    tx: Tx,
    ticketId: string,
    seq: number,
    e: {
      type: SupportEventType;
      actor: { kind: SupportAuthorKind; id: string | null };
      from?: string | null;
      to?: string | null;
      reason?: string | null;
      internal?: boolean;
      messageId?: string | null;
    },
  ) {
    await tx.supportTicketEvent.create({
      data: {
        ticketId,
        seq,
        type: e.type,
        actorKind: e.actor.kind,
        actorId: e.actor.id,
        fromValue: e.from ?? null,
        toValue: e.to ?? null,
        reason: e.reason ?? null,
        internal: e.internal ?? false,
        messageId: e.messageId ?? null,
        createdAt: this.now(),
      },
    });
  }

  private audit(
    tx: Tx,
    actor: { type: 'USER' | 'ADMIN' | 'SYSTEM'; id: string | null },
    action: string,
    ticketId: string,
    metadata: Record<string, unknown>,
    ctx: RequestContext = {},
  ) {
    return tx.auditLog.create({
      data: {
        actorType: actor.type,
        actorId: actor.id,
        action,
        entityType: 'support_ticket',
        entityId: ticketId,
        requestId: ctx.requestId ?? null,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }

  /** Active staff who may work tickets (support or admin), optionally admins only. */
  private staffRecipients(tx: Tx, adminsOnly = false) {
    return tx.user.findMany({
      where: { status: 'ACTIVE', role: { in: adminsOnly ? ['ADMIN'] : ['SUPPORT', 'ADMIN'] } },
      select: { id: true },
    });
  }

  private async notifyCustomer(
    tx: Tx,
    ticket: { id: string; userId: string; reference: string; subject: string },
    seq: number,
    title: string,
    message: string,
  ) {
    await notify(tx, this.now(), {
      userId: ticket.userId,
      type: 'SUPPORT_TICKET',
      title,
      message,
      isDemo: false,
      supportTicketId: ticket.id,
      dedupeKey: `support:${ticket.id}:${seq}:${ticket.userId}`,
    });
  }

  private async notifyStaff(
    tx: Tx,
    userIds: string[],
    ticket: { id: string; reference: string },
    seq: number,
    title: string,
    message: string,
  ) {
    for (const userId of new Set(userIds)) {
      await notify(tx, this.now(), {
        userId,
        type: 'SUPPORT_QUEUE',
        title,
        message,
        isDemo: false,
        supportTicketId: ticket.id,
        dedupeKey: `support:${ticket.id}:${seq}:${userId}`,
      });
    }
  }

  // ─── Booking context ───────────────────────────────────────────────────

  /** The owner's booking, as support may see it (null if it can't be read). */
  private async bookingContext(
    userId: string,
    reference: string,
  ): Promise<SupportBookingContext | null> {
    if (!this.options.bookings) return null;
    try {
      const b = await this.options.bookings.get(userId, reference);
      return supportBookingContextSchema.parse({
        reference: b.reference,
        category: b.serviceType,
        title: b.offer.title,
        demo: b.demo,
        status: b.status,
        paymentState: b.payment.state,
        reservationState: b.reservation.state,
        refundState: b.refund.state,
        startsOn: b.startsOn,
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') return null;
      this.logger.warn({ err: errorForLog(error) }, 'Could not read booking context for support');
      return null;
    }
  }

  private storedContext(row: { bookingContext: unknown }): SupportBookingContext | null {
    const parsed = supportBookingContextSchema.safeParse(row.bookingContext);
    return parsed.success ? parsed.data : null;
  }

  // ─── Customer: tickets ────────────────────────────────────────────────

  private async findOwned(userId: string, reference: string): Promise<TicketRow> {
    const row = await this.prisma.supportTicket.findFirst({
      where: { reference, userId },
      include: ticketInclude,
    });
    if (!row) throw new AppError('NOT_FOUND', NOT_FOUND);
    return row;
  }

  async create(
    user: { id: string },
    input: CreateInput,
    ctx: RequestContext = {},
  ): Promise<SupportTicket> {
    // A retried submission returns the ticket the first one created.
    const existing = await this.prisma.supportTicket.findUnique({
      where: { userId_clientKey: { userId: user.id, clientKey: input.clientKey } },
      select: { reference: true },
    });
    if (existing) return this.get(user.id, existing.reference);

    let bookingId: string | null = null;
    let context: SupportBookingContext | null = null;
    if (input.bookingReference) {
      const booking = await this.prisma.booking.findFirst({
        where: { reference: input.bookingReference, userId: user.id },
        select: { id: true },
      });
      // Someone else's booking looks exactly like one that doesn't exist.
      if (!booking) {
        throw new AppError('NOT_FOUND', "We couldn't find that booking in your trips.", {
          details: [
            {
              path: 'bookingReference',
              message: 'Choose one of your own bookings.',
              code: 'not_found',
            },
          ],
        });
      }
      bookingId = booking.id;
      context = await this.bookingContext(user.id, input.bookingReference);
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const reference = await this.prisma.$transaction(async (tx) => {
          const now = this.now();
          const priority = upper<SupportTicketPriority>(input.priority);
          const ticket = await tx.supportTicket.create({
            data: {
              reference: newReference(),
              userId: user.id,
              bookingId,
              category: upper<SupportTicketCategory>(input.category),
              priority,
              subject: input.subject,
              bookingContext: (context ?? Prisma.DbNull) as Prisma.InputJsonValue,
              clientKey: input.clientKey,
              revision: 2,
              customerReadSeq: 2,
              lastCustomerMessageAt: now,
              ...targetsFor(input.priority, now),
              createdAt: now,
            },
          });
          const message = await tx.supportMessage.create({
            data: {
              ticketId: ticket.id,
              seq: 1,
              authorKind: 'CUSTOMER',
              authorId: user.id,
              body: input.description,
              clientKey: input.clientKey,
              createdAt: now,
            },
          });
          await this.event(tx, ticket.id, 1, {
            type: 'CREATED',
            actor: { kind: 'CUSTOMER', id: user.id },
            to: 'OPEN',
            messageId: message.id,
          });
          // An automatic acknowledgement: from Wayora, never a first response.
          const ack = await tx.supportMessage.create({
            data: {
              ticketId: ticket.id,
              seq: 2,
              authorKind: 'SYSTEM',
              authorId: null,
              body: `Thanks, we’ve received your request. Your ticket reference is ${ticket.reference}. A member of the Wayora support team will reply here, and you’ll get a notification when they do.`,
              createdAt: now,
            },
          });
          await this.event(tx, ticket.id, 2, {
            type: 'SYSTEM_MESSAGE',
            actor: { kind: 'SYSTEM', id: null },
            messageId: ack.id,
          });
          await this.audit(
            tx,
            { type: 'USER', id: user.id },
            'support.ticket_created',
            ticket.id,
            {
              reference: ticket.reference,
              category: input.category,
              priority: input.priority,
              bookingLinked: bookingId !== null,
            },
            ctx,
          );
          await this.notifyCustomer(
            tx,
            ticket,
            1,
            'Support request received',
            `We’ve received your request ${ticket.reference}. We’ll reply in the ticket.`,
          );
          const staff = await this.staffRecipients(tx);
          await this.notifyStaff(
            tx,
            staff.map((s) => s.id),
            ticket,
            1,
            'New support ticket',
            `${ticket.reference}: “${input.subject.slice(0, 80)}” is waiting in the queue.`,
          );
          return ticket.reference;
        });
        return this.get(user.id, reference);
      } catch (error) {
        if (isUnique(error, 'client_key') || isUnique(error, 'clientKey')) {
          const again = await this.prisma.supportTicket.findUnique({
            where: { userId_clientKey: { userId: user.id, clientKey: input.clientKey } },
            select: { reference: true },
          });
          if (again) return this.get(user.id, again.reference);
        }
        if (isUnique(error, 'reference')) continue;
        throw error;
      }
    }
    throw new AppError('INTERNAL_ERROR', 'Could not create the ticket. Try again.');
  }

  private async unreadCounts(ticketIds: string[]): Promise<Map<string, number>> {
    if (ticketIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<{ ticket_id: string; n: bigint }[]>`
      SELECT m.ticket_id, count(*) AS n
      FROM support_messages m JOIN support_tickets t ON t.id = m.ticket_id
      WHERE m.ticket_id = ANY(${ticketIds}::uuid[])
        AND m.author_kind <> 'CUSTOMER' AND NOT m.internal AND m.seq > t.customer_read_seq
      GROUP BY m.ticket_id`;
    return new Map(rows.map((r) => [r.ticket_id, Number(r.n)]));
  }

  private summary(row: TicketRow, unread: number): SupportTicketSummary {
    return {
      reference: row.reference,
      subject: row.subject,
      category: lower<SupportCategory>(row.category),
      priority: lower<SupportPriority>(row.priority),
      status: lower<SupportStatus>(row.status),
      bookingReference: row.booking?.reference ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      unread,
    };
  }

  async list(userId: string, query: ListQuery): Promise<SupportTicketList> {
    const where: Prisma.SupportTicketWhereInput = { userId };
    if (query.view === 'active') where.status = { not: 'CLOSED' };
    if (query.view === 'closed') where.status = 'CLOSED';
    if (query.booking) where.booking = { reference: query.booking, userId };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.findMany({
        where,
        include: ticketInclude,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    const unread = await this.unreadCounts(rows.map((r) => r.id));
    return {
      items: rows.map((r) => this.summary(r, unread.get(r.id) ?? 0)),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalResults: total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  async get(userId: string, reference: string): Promise<SupportTicket> {
    const row = await this.findOwned(userId, reference);
    const [unread, events] = await Promise.all([
      this.unreadCounts([row.id]),
      this.prisma.supportTicketEvent.findMany({
        where: { ticketId: row.id, internal: false, type: { in: ['CREATED', 'STATUS_CHANGED'] } },
        orderBy: { seq: 'asc' },
        select: { createdAt: true, toValue: true, actorKind: true },
      }),
    ]);
    const booking = row.booking
      ? ((await this.bookingContext(userId, row.booking.reference)) ?? this.storedContext(row))
      : null;
    const status = lower<SupportStatus>(row.status);
    return {
      ...this.summary(row, unread.get(row.id) ?? 0),
      revision: row.revision,
      booking,
      canReply: status !== 'closed',
      canClose: status !== 'closed',
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      closedAt: row.closedAt?.toISOString() ?? null,
      history: events
        .filter((e) => e.toValue)
        .map((e) => ({
          at: e.createdAt.toISOString(),
          status: lower<SupportStatus>(e.toValue!),
          by: e.actorKind === 'CUSTOMER' ? 'you' : e.actorKind === 'AGENT' ? 'support' : 'wayora',
        })),
    };
  }

  async messages(
    userId: string,
    reference: string,
    query: { before?: number | undefined; limit: number },
  ): Promise<SupportMessagePage> {
    const row = await this.findOwned(userId, reference);
    const rows = await this.prisma.supportMessage.findMany({
      where: {
        ticketId: row.id,
        internal: false,
        ...(query.before ? { seq: { lt: query.before } } : {}),
      },
      orderBy: { seq: 'desc' },
      take: query.limit + 1,
      include: { author: { select: { displayName: true } } },
    });
    const more = rows.length > query.limit;
    const page = rows.slice(0, query.limit).reverse();
    return {
      items: page.map((m): SupportMessage => ({
        id: m.id,
        seq: m.seq,
        author: lower(m.authorKind),
        authorName:
          m.authorKind === 'CUSTOMER'
            ? 'You'
            : m.authorKind === 'SYSTEM'
              ? 'Wayora'
              : `${firstName(m.author?.displayName ?? '')} · Wayora support`,
        body: m.body,
        createdAt: m.createdAt.toISOString(),
        seenBySupport: m.authorKind === 'CUSTOMER' ? m.seq <= row.staffReadSeq : null,
        readByCustomer: null,
      })),
      nextBefore: more ? page[0]!.seq : null,
    };
  }

  /** The customer adds a message. Reopens a resolved ticket; answers a request for information. */
  async reply(
    user: { id: string },
    reference: string,
    input: MessageInput,
    ctx: RequestContext = {},
  ): Promise<SupportTicket> {
    const owned = await this.findOwned(user.id, reference);
    const repeat = await this.prisma.supportMessage.findFirst({
      where: { ticketId: owned.id, authorId: user.id, clientKey: input.clientKey },
      select: { id: true },
    });
    if (repeat) return this.get(user.id, reference);
    try {
      await this.prisma.$transaction(async (tx) => {
        const t = await this.lock(tx, owned.id);
        if (t.status === 'CLOSED') throw new AppError('CONFLICT', CLOSED);
        const now = this.now();
        const reopen = t.status === 'RESOLVED';
        const resume = reopen || t.status === 'WAITING_FOR_CUSTOMER';
        const seq = await this.bump(tx, t.id, { lastCustomerMessageAt: now });
        const message = await tx.supportMessage.create({
          data: {
            ticketId: t.id,
            seq,
            authorKind: 'CUSTOMER',
            authorId: user.id,
            body: input.body,
            clientKey: input.clientKey,
            createdAt: now,
          },
        });
        await this.event(tx, t.id, seq, {
          type: 'CUSTOMER_MESSAGE',
          actor: { kind: 'CUSTOMER', id: user.id },
          messageId: message.id,
        });
        let last = seq;
        if (resume) {
          // The reply puts the ticket back in support's hands.
          last = await this.bump(tx, t.id, {
            status: 'IN_PROGRESS',
            ...(reopen ? { reopenCount: { increment: 1 }, resolvedAt: null } : {}),
          });
          await this.event(tx, t.id, last, {
            type: 'STATUS_CHANGED',
            actor: { kind: 'CUSTOMER', id: user.id },
            from: t.status,
            to: 'IN_PROGRESS',
            reason: reopen
              ? 'The customer replied after it was resolved.'
              : 'The customer replied.',
          });
        }
        await tx.supportTicket.update({ where: { id: t.id }, data: { customerReadSeq: last } });
        await this.audit(
          tx,
          { type: 'USER', id: user.id },
          'support.customer_replied',
          t.id,
          {
            reference: t.reference,
            reopened: reopen,
          },
          ctx,
        );
        if (t.assigneeId) {
          await this.notifyStaff(
            tx,
            [t.assigneeId],
            t,
            seq,
            reopen ? 'Customer reopened a ticket' : 'Customer replied',
            `${t.reference}: the customer ${reopen ? 'replied after it was resolved' : 'replied'}.`,
          );
        }
      });
    } catch (error) {
      if (isUnique(error, 'client_key') || isUnique(error, 'clientKey'))
        return this.get(user.id, reference);
      throw error;
    }
    return this.get(user.id, reference);
  }

  async markRead(userId: string, reference: string, seq: number): Promise<{ unread: number }> {
    const row = await this.findOwned(userId, reference);
    const upTo = Math.min(seq, row.revision);
    if (upTo > row.customerReadSeq) {
      await this.prisma.supportTicket.updateMany({
        where: { id: row.id, customerReadSeq: { lt: upTo } },
        data: { customerReadSeq: upTo },
      });
    }
    const unread = await this.unreadCounts([row.id]);
    return { unread: unread.get(row.id) ?? 0 };
  }

  /** The customer closes their own ticket ("I no longer need help"). */
  async close(
    user: { id: string },
    reference: string,
    reason: string | undefined,
    ctx: RequestContext = {},
  ): Promise<SupportTicket> {
    const owned = await this.findOwned(user.id, reference);
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lock(tx, owned.id);
      if (t.status === 'CLOSED') return;
      const now = this.now();
      const seq = await this.bump(tx, t.id, { status: 'CLOSED', closedAt: now });
      await tx.supportTicket.update({ where: { id: t.id }, data: { customerReadSeq: seq } });
      await this.event(tx, t.id, seq, {
        type: 'STATUS_CHANGED',
        actor: { kind: 'CUSTOMER', id: user.id },
        from: t.status,
        to: 'CLOSED',
        reason: reason?.trim() || 'Closed by the customer.',
      });
      await this.audit(
        tx,
        { type: 'USER', id: user.id },
        'support.ticket_closed_by_customer',
        t.id,
        {
          reference: t.reference,
        },
        ctx,
      );
      if (t.assigneeId) {
        await this.notifyStaff(
          tx,
          [t.assigneeId],
          t,
          seq,
          'Ticket closed by the customer',
          `${t.reference} was closed by the customer.`,
        );
      }
    });
    return this.get(user.id, reference);
  }

  // ─── Staff ─────────────────────────────────────────────────────────────

  private staffOf(
    u: { id: string; displayName: string | null; role: string } | null,
  ): SupportStaff | null {
    if (!u) return null;
    const role = lower<UserRole>(u.role);
    return { id: u.id, name: staffName(u), role: role === 'admin' ? 'admin' : 'support' };
  }

  private targets(row: TicketRow, now: Date) {
    return {
      firstResponse: {
        dueAt: row.firstResponseDueAt.toISOString(),
        metAt: row.firstResponseAt?.toISOString() ?? null,
        state: targetState(row.firstResponseDueAt, row.firstResponseAt, now, row.closedAt),
      },
      resolution: {
        dueAt: row.resolutionDueAt.toISOString(),
        metAt: (row.resolvedAt ?? row.closedAt)?.toISOString() ?? null,
        state: targetState(row.resolutionDueAt, row.resolvedAt ?? row.closedAt, now),
      },
    };
  }

  private adminSummary(row: TicketRow, now: Date): AdminSupportTicketSummary {
    const { unread: _unread, ...base } = this.summary(row, 0);
    const active = isActive(lower(row.status));
    return {
      ...base,
      customerName: customerName(row.user),
      assignee: this.staffOf(row.assignee),
      escalated: row.escalated,
      ...this.targets(row, now),
      awaitingReply:
        active &&
        row.lastCustomerMessageAt !== null &&
        (row.lastAgentReplyAt === null || row.lastCustomerMessageAt > row.lastAgentReplyAt),
    };
  }

  async adminList(viewer: Viewer, query: AdminListQuery): Promise<AdminSupportTicketList> {
    const now = this.now();
    const and: Prisma.SupportTicketWhereInput[] = [];
    if (query.view === 'mine') and.push({ assigneeId: viewer.id });
    if (query.view === 'unassigned') and.push({ assigneeId: null, status: { in: ACTIVE_DB } });
    if (query.view === 'escalated') and.push({ escalated: true, status: { in: ACTIVE_DB } });
    if (query.status === 'active') and.push({ status: { in: ACTIVE_DB } });
    else if (query.status) and.push({ status: upper<SupportTicketStatus>(query.status) });
    if (query.priority) and.push({ priority: upper<SupportTicketPriority>(query.priority) });
    if (query.category) and.push({ category: upper<SupportTicketCategory>(query.category) });
    if (query.overdue) {
      and.push({
        status: { in: ACTIVE_DB },
        OR: [
          { firstResponseAt: null, firstResponseDueAt: { lt: now } },
          { resolutionDueAt: { lt: now } },
        ],
      });
    }
    if (query.q) {
      const q = query.q.trim();
      const or: Prisma.SupportTicketWhereInput[] = [
        { reference: q.toUpperCase() },
        { booking: { reference: q.toUpperCase() } },
        { subject: { contains: q, mode: 'insensitive' } },
      ];
      // Customer lookup only for staff allowed to read customer accounts.
      if (q.includes('@') && hasPermission(viewer.role, 'admin.users.read')) {
        or.push({ user: { email: { equals: q.toLowerCase(), mode: 'insensitive' } } });
      }
      and.push({ OR: or });
    }
    const where: Prisma.SupportTicketWhereInput = and.length ? { AND: and } : {};
    const orderBy: Prisma.SupportTicketOrderByWithRelationInput[] =
      query.sort === 'created'
        ? [{ createdAt: 'desc' }, { id: 'desc' }]
        : query.sort === 'due'
          ? [{ resolutionDueAt: 'asc' }, { id: 'asc' }]
          : [{ updatedAt: 'desc' }, { id: 'desc' }];
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.findMany({
        where,
        include: ticketInclude,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: rows.map((r) => this.adminSummary(r, now)),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalResults: total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  private async findForStaff(reference: string): Promise<TicketRow> {
    const row = await this.prisma.supportTicket.findUnique({
      where: { reference },
      include: ticketInclude,
    });
    if (!row) throw new AppError('NOT_FOUND', NOT_FOUND);
    return row;
  }

  async adminGet(
    viewer: Viewer,
    reference: string,
    ctx: RequestContext = {},
  ): Promise<AdminSupportTicket> {
    const row = await this.findForStaff(reference);
    const now = this.now();
    const events = await this.prisma.supportTicketEvent.findMany({
      where: { ticketId: row.id },
      orderBy: { seq: 'asc' },
      include: { actor: { select: { displayName: true, role: true } } },
    });
    const bookingNow = row.booking
      ? await this.bookingContext(row.userId, row.booking.reference)
      : null;
    await this.prisma.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorId: viewer.id,
        action: 'admin.support_ticket_viewed',
        entityType: 'support_ticket',
        entityId: row.id,
        requestId: ctx.requestId ?? null,
        metadata: { reference: row.reference, role: viewer.role },
      },
    });
    const history: AdminSupportEvent[] = events.map((e) => ({
      seq: e.seq,
      type: lower(e.type),
      actor: {
        kind:
          e.actorKind === 'CUSTOMER' ? 'customer' : e.actorKind === 'AGENT' ? 'staff' : 'system',
        name:
          e.actorKind === 'SYSTEM'
            ? 'Wayora'
            : e.actorKind === 'CUSTOMER'
              ? 'Customer'
              : staffName(e.actor),
      },
      from: e.fromValue,
      to: e.toValue,
      reason: e.reason,
      internal: e.internal,
      at: e.createdAt.toISOString(),
    }));
    const status = lower<SupportStatus>(row.status);
    return {
      ...this.adminSummary(row, now),
      revision: row.revision,
      customer: {
        id: row.user.id,
        name: customerName(row.user),
        email: hasPermission(viewer.role, 'admin.users.read') ? row.user.email : null,
      },
      bookingAtOpen: this.storedContext(row),
      bookingNow,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      closedAt: row.closedAt?.toISOString() ?? null,
      reopenCount: row.reopenCount,
      history,
      allowed: {
        ...allowedFor(viewer, { status, escalated: row.escalated, assigneeId: row.assigneeId }),
        ai:
          allowedFor(viewer, { status, escalated: row.escalated, assigneeId: row.assigneeId }).ai &&
          this.aiAvailable,
      },
    };
  }

  async adminMessages(
    reference: string,
    query: { before?: number | undefined; limit: number },
  ): Promise<AdminSupportMessagePage> {
    const row = await this.findForStaff(reference);
    const rows = await this.prisma.supportMessage.findMany({
      where: { ticketId: row.id, ...(query.before ? { seq: { lt: query.before } } : {}) },
      orderBy: { seq: 'desc' },
      take: query.limit + 1,
      include: { author: { select: { id: true, displayName: true, role: true } } },
    });
    const more = rows.length > query.limit;
    const page = rows.slice(0, query.limit).reverse();
    return {
      items: page.map((m): AdminSupportMessage => ({
        id: m.id,
        seq: m.seq,
        author: lower(m.authorKind),
        authorName:
          m.authorKind === 'CUSTOMER'
            ? customerName(row.user)
            : m.authorKind === 'SYSTEM'
              ? 'Wayora (automatic)'
              : staffName(m.author),
        body: m.body,
        createdAt: m.createdAt.toISOString(),
        readByCustomer:
          m.authorKind !== 'CUSTOMER' && !m.internal ? m.seq <= row.customerReadSeq : null,
        internal: m.internal,
        staff: m.authorKind === 'AGENT' ? this.staffOf(m.author) : null,
        aiAssisted: m.aiAssisted,
      })),
      nextBefore: more ? page[0]!.seq : null,
    };
  }

  private forbid(message: string): never {
    throw new AppError('FORBIDDEN', message);
  }

  private checkRevision(t: TicketRow, revision: number) {
    if (t.revision !== revision) throw new AppError('CONFLICT', STALE);
  }

  /** A public reply, or an internal note (`internal: true`). */
  async adminReply(
    viewer: StaffUser,
    reference: string,
    input: ReplyInput,
    ctx: RequestContext = {},
  ): Promise<AdminSupportTicket> {
    const found = await this.findForStaff(reference);
    const repeat = await this.prisma.supportMessage.findFirst({
      where: { ticketId: found.id, authorId: viewer.id, clientKey: input.clientKey },
      select: { id: true },
    });
    if (repeat) return this.adminGet(viewer, reference, ctx);
    try {
      await this.prisma.$transaction(async (tx) => {
        const t = await this.lock(tx, found.id);
        const status = lower<SupportStatus>(t.status);
        const allowed = allowedFor(viewer, {
          status,
          escalated: t.escalated,
          assigneeId: t.assigneeId,
        });
        if (status === 'closed') throw new AppError('CONFLICT', CLOSED);
        if (input.internal ? !allowed.note : !allowed.reply) {
          this.forbid(
            t.escalated
              ? 'This ticket is escalated: administrators reply to it. You can add an internal note.'
              : 'You can’t reply to this ticket.',
          );
        }
        const now = this.now();
        const seq = await this.bump(
          tx,
          t.id,
          input.internal
            ? {}
            : {
                lastAgentReplyAt: now,
                ...(t.firstResponseAt ? {} : { firstResponseAt: now }),
              },
        );
        const message = await tx.supportMessage.create({
          data: {
            ticketId: t.id,
            seq,
            authorKind: 'AGENT',
            authorId: viewer.id,
            internal: input.internal,
            aiAssisted: input.aiAssisted,
            body: input.body,
            clientKey: input.clientKey,
            createdAt: now,
          },
        });
        await this.event(tx, t.id, seq, {
          type: input.internal ? 'INTERNAL_NOTE' : 'AGENT_REPLY',
          actor: { kind: 'AGENT', id: viewer.id },
          internal: input.internal,
          messageId: message.id,
        });
        let last = seq;
        if (!input.internal) {
          const next: SupportStatus | null = input.requestInfo
            ? status === 'waiting_for_customer'
              ? null
              : 'waiting_for_customer'
            : status === 'open'
              ? 'in_progress'
              : null;
          if (next) {
            if (!canTransition(status, next)) {
              throw new AppError(
                'CONFLICT',
                `A ticket that is ${SUPPORT_STATUS_LABEL[status].toLowerCase()} can’t wait for the customer.`,
              );
            }
            last = await this.bump(tx, t.id, { status: upper<SupportTicketStatus>(next) });
            await this.event(tx, t.id, last, {
              type: 'STATUS_CHANGED',
              actor: { kind: 'AGENT', id: viewer.id },
              from: t.status,
              to: upper(next),
              reason: input.requestInfo ? 'More information requested from the customer.' : null,
            });
          }
          await this.notifyCustomer(
            tx,
            t,
            seq,
            input.requestInfo ? 'Support needs more information' : 'Support replied',
            input.requestInfo
              ? `Support asked for more information on ${t.reference}. Reply in the ticket.`
              : `Support replied to your ticket ${t.reference}.`,
          );
        }
        await tx.supportTicket.update({ where: { id: t.id }, data: { staffReadSeq: last } });
        await this.audit(
          tx,
          { type: 'ADMIN', id: viewer.id },
          input.internal ? 'support.note_added' : 'support.agent_replied',
          t.id,
          { reference: t.reference, requestInfo: input.requestInfo, aiAssisted: input.aiAssisted },
          ctx,
        );
      });
    } catch (error) {
      if (isUnique(error, 'client_key') || isUnique(error, 'clientKey')) {
        return this.adminGet(viewer, reference, ctx);
      }
      throw error;
    }
    return this.adminGet(viewer, reference, ctx);
  }

  async adminStatus(
    viewer: StaffUser,
    reference: string,
    input: { status: SupportStatus; reason?: string | undefined; revision: number },
    ctx: RequestContext = {},
  ): Promise<AdminSupportTicket> {
    const found = await this.findForStaff(reference);
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lock(tx, found.id);
      this.checkRevision(t, input.revision);
      const from = lower<SupportStatus>(t.status);
      const allowed = allowedFor(viewer, {
        status: from,
        escalated: t.escalated,
        assigneeId: t.assigneeId,
      });
      if (from === 'closed') throw new AppError('CONFLICT', CLOSED);
      if (t.escalated && !hasPermission(viewer.role, 'admin.support.supervise')) {
        this.forbid('This ticket is escalated: an administrator changes its status.');
      }
      if (!canTransition(from, input.status) || !allowed.status.includes(input.status)) {
        throw new AppError(
          'CONFLICT',
          `A ticket can’t move from ${SUPPORT_STATUS_LABEL[from].toLowerCase()} to ${SUPPORT_STATUS_LABEL[input.status].toLowerCase()}.`,
        );
      }
      const now = this.now();
      const to = upper<SupportTicketStatus>(input.status);
      const reopen = from === 'resolved' && input.status === 'in_progress';
      const seq = await this.bump(tx, t.id, {
        status: to,
        ...(to === 'RESOLVED' ? { resolvedAt: now } : {}),
        ...(to === 'CLOSED' ? { closedAt: now } : {}),
        ...(reopen ? { resolvedAt: null, reopenCount: { increment: 1 } } : {}),
      });
      await tx.supportTicket.update({ where: { id: t.id }, data: { staffReadSeq: seq } });
      await this.event(tx, t.id, seq, {
        type: 'STATUS_CHANGED',
        actor: { kind: 'AGENT', id: viewer.id },
        from: t.status,
        to,
        reason: input.reason ?? null,
      });
      await this.audit(
        tx,
        { type: 'ADMIN', id: viewer.id },
        'support.status_changed',
        t.id,
        {
          reference: t.reference,
          from: t.status,
          to,
        },
        ctx,
      );
      const words: Partial<Record<SupportStatus, [string, string]>> = {
        resolved: [
          'Your support ticket was resolved',
          `Support marked ${t.reference} as resolved. Reply in the ticket if you still need help.`,
        ],
        closed: ['Your support ticket was closed', `${t.reference} was closed.`],
        waiting_for_customer: [
          'Support needs more information',
          `Support asked for more information on ${t.reference}. Reply in the ticket.`,
        ],
      };
      const [title, message] = words[input.status] ?? [
        'Support ticket updated',
        `${t.reference} is now ${SUPPORT_STATUS_LABEL[input.status].toLowerCase()}.`,
      ];
      await this.notifyCustomer(tx, t, seq, title, message);
    });
    return this.adminGet(viewer, reference, ctx);
  }

  async adminAssign(
    viewer: StaffUser,
    reference: string,
    input: { assigneeId: string | null; revision: number },
    ctx: RequestContext = {},
  ): Promise<AdminSupportTicket> {
    const found = await this.findForStaff(reference);
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lock(tx, found.id);
      this.checkRevision(t, input.revision);
      const status = lower<SupportStatus>(t.status);
      const allowed = allowedFor(viewer, {
        status,
        escalated: t.escalated,
        assigneeId: t.assigneeId,
      });
      if (status === 'closed') throw new AppError('CONFLICT', CLOSED);
      if (input.assigneeId === t.assigneeId) return;
      if (input.assigneeId === null) {
        if (!allowed.unassign) this.forbid('You can only release tickets assigned to you.');
      } else if (input.assigneeId === viewer.id) {
        if (!allowed.assignSelf) {
          this.forbid(
            t.escalated
              ? 'Escalated tickets are assigned to administrators.'
              : 'You can’t take this ticket.',
          );
        }
      } else if (!allowed.assignOthers) {
        this.forbid('Only administrators assign tickets to other people.');
      }
      let assignee: { id: string; displayName: string | null } | null = null;
      if (input.assigneeId) {
        const u = await tx.user.findUnique({
          where: { id: input.assigneeId },
          select: { id: true, displayName: true, role: true, status: true },
        });
        const role = u ? lower<UserRole>(u.role) : 'user';
        // Never assigned to a customer, a suspended account, or (escalated) non-admins.
        if (!u || u.status !== 'ACTIVE' || !assignableRole(role, t.escalated)) {
          throw new AppError('VALIDATION_FAILED', 'That person can’t be assigned this ticket.', {
            details: [
              {
                code: 'invalid_value',
                path: 'assigneeId',
                message: t.escalated
                  ? 'Escalated tickets go to an active administrator.'
                  : 'Choose an active member of the support team.',
              },
            ],
          });
        }
        assignee = u;
      }
      const seq = await this.bump(tx, t.id, {
        assignee: assignee ? { connect: { id: assignee.id } } : { disconnect: true },
      });
      await this.event(tx, t.id, seq, {
        type: assignee ? 'ASSIGNED' : 'UNASSIGNED',
        actor: { kind: 'AGENT', id: viewer.id },
        from: t.assignee ? staffName(t.assignee).slice(0, 40) : null,
        to: assignee ? staffName(assignee).slice(0, 40) : null,
        internal: true,
      });
      await this.audit(
        tx,
        { type: 'ADMIN', id: viewer.id },
        assignee ? 'support.assigned' : 'support.unassigned',
        t.id,
        {
          reference: t.reference,
          from: t.assigneeId,
          to: assignee?.id ?? null,
        },
        ctx,
      );
      if (assignee && assignee.id !== viewer.id) {
        await this.notifyStaff(
          tx,
          [assignee.id],
          t,
          seq,
          'Ticket assigned to you',
          `${t.reference}: “${t.subject.slice(0, 80)}” was assigned to you by ${firstName(viewer.name)}.`,
        );
      }
    });
    return this.adminGet(viewer, reference, ctx);
  }

  async adminEscalate(
    viewer: StaffUser,
    reference: string,
    input: { escalate: boolean; reason: string; revision: number },
    ctx: RequestContext = {},
  ): Promise<AdminSupportTicket> {
    const found = await this.findForStaff(reference);
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lock(tx, found.id);
      this.checkRevision(t, input.revision);
      const status = lower<SupportStatus>(t.status);
      const allowed = allowedFor(viewer, {
        status,
        escalated: t.escalated,
        assigneeId: t.assigneeId,
      });
      if (status === 'closed') throw new AppError('CONFLICT', CLOSED);
      if (input.escalate ? !allowed.escalate : !allowed.deEscalate) {
        if (input.escalate === t.escalated) {
          throw new AppError(
            'CONFLICT',
            input.escalate ? 'This ticket is already escalated.' : 'This ticket isn’t escalated.',
          );
        }
        this.forbid('Only administrators de-escalate tickets.');
      }
      const now = this.now();
      // Escalating hands the ticket to administrators: a support agent's assignment ends.
      const release =
        input.escalate && t.assignee !== null && lower<UserRole>(t.assignee.role) !== 'admin';
      const seq = await this.bump(tx, t.id, {
        escalated: input.escalate,
        escalatedAt: input.escalate ? now : null,
        ...(release ? { assignee: { disconnect: true } } : {}),
      });
      await this.event(tx, t.id, seq, {
        type: input.escalate ? 'ESCALATED' : 'DE_ESCALATED',
        actor: { kind: 'AGENT', id: viewer.id },
        from: release ? staffName(t.assignee).slice(0, 40) : null,
        reason: input.reason,
        internal: true,
      });
      await this.audit(
        tx,
        { type: 'ADMIN', id: viewer.id },
        input.escalate ? 'support.escalated' : 'support.de_escalated',
        t.id,
        {
          reference: t.reference,
          reason: input.reason,
          released: release ? t.assigneeId : null,
        },
        ctx,
      );
      if (input.escalate) {
        const admins = await this.staffRecipients(tx, true);
        await this.notifyStaff(
          tx,
          admins.map((a) => a.id).filter((id) => id !== viewer.id),
          t,
          seq,
          'Ticket escalated',
          `${t.reference} was escalated by ${firstName(viewer.name)}: ${input.reason.slice(0, 160)}`,
        );
      } else if (t.assigneeId && t.assigneeId !== viewer.id) {
        await this.notifyStaff(
          tx,
          [t.assigneeId],
          t,
          seq,
          'Ticket de-escalated',
          `${t.reference} is no longer escalated.`,
        );
      }
    });
    return this.adminGet(viewer, reference, ctx);
  }

  async adminPriority(
    viewer: StaffUser,
    reference: string,
    input: { priority: SupportPriority; reason: string; revision: number },
    ctx: RequestContext = {},
  ): Promise<AdminSupportTicket> {
    const found = await this.findForStaff(reference);
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lock(tx, found.id);
      this.checkRevision(t, input.revision);
      const status = lower<SupportStatus>(t.status);
      const allowed = allowedFor(viewer, {
        status,
        escalated: t.escalated,
        assigneeId: t.assigneeId,
      });
      if (status === 'closed') throw new AppError('CONFLICT', CLOSED);
      if (!allowed.changePriority) this.forbid('You can’t change this ticket’s priority.');
      const to = upper<SupportTicketPriority>(input.priority);
      if (to === t.priority) return;
      // Targets are recalculated from when the ticket opened.
      const seq = await this.bump(tx, t.id, {
        priority: to,
        ...targetsFor(input.priority, t.createdAt),
      });
      await this.event(tx, t.id, seq, {
        type: 'PRIORITY_CHANGED',
        actor: { kind: 'AGENT', id: viewer.id },
        from: t.priority,
        to,
        reason: input.reason,
        internal: true,
      });
      await this.audit(
        tx,
        { type: 'ADMIN', id: viewer.id },
        'support.priority_changed',
        t.id,
        {
          reference: t.reference,
          from: t.priority,
          to,
        },
        ctx,
      );
    });
    return this.adminGet(viewer, reference, ctx);
  }

  async adminMarkRead(reference: string, seq: number): Promise<void> {
    const row = await this.findForStaff(reference);
    const upTo = Math.min(seq, row.revision);
    await this.prisma.supportTicket.updateMany({
      where: { id: row.id, staffReadSeq: { lt: upTo } },
      data: { staffReadSeq: upTo },
    });
  }

  /** People who may be assigned tickets (active support and admin staff). Names only. */
  async staff(): Promise<SupportStaff[]> {
    const rows = await this.prisma.user.findMany({
      where: { status: 'ACTIVE', role: { in: ['SUPPORT', 'ADMIN'] } },
      select: { id: true, displayName: true, role: true },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take: 200,
    });
    return rows.map((r) => this.staffOf(r)!);
  }

  // ─── AI ────────────────────────────────────────────────────────────────

  async aiSuggestion(
    viewer: StaffUser,
    reference: string,
    kind: 'draft' | 'summary',
    ctx: RequestContext = {},
  ): Promise<SupportAiSuggestion> {
    const ai = this.options.ai;
    if (!ai || !this.aiAvailable) {
      throw new AppError(
        'ASSISTANT_UNAVAILABLE',
        'AI suggestions aren’t available on this server.',
      );
    }
    const t = await this.findForStaff(reference);
    const status = lower<SupportStatus>(t.status);
    if (!allowedFor(viewer, { status, escalated: t.escalated, assigneeId: t.assigneeId }).ai) {
      this.forbid('You can’t use AI suggestions on this ticket.');
    }
    // Customer-visible messages only: internal notes never reach the provider.
    const messages = await this.prisma.supportMessage.findMany({
      where: { ticketId: t.id, internal: false },
      orderBy: { seq: 'desc' },
      take: 20,
      select: { authorKind: true, body: true },
    });
    const input: SupportAiInput = {
      kind,
      subject: t.subject,
      category: lower(t.category),
      status,
      booking: t.booking ? await this.bookingContext(t.userId, t.booking.reference) : null,
      conversation: messages.reverse().map((m) => ({
        from:
          m.authorKind === 'CUSTOMER'
            ? 'customer'
            : m.authorKind === 'AGENT'
              ? 'support'
              : 'wayora',
        text: m.body,
      })),
    };
    try {
      const out = await suggest(ai, input);
      await this.prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: viewer.id,
          action: 'support.ai_suggestion',
          entityType: 'support_ticket',
          entityId: t.id,
          requestId: ctx.requestId ?? null,
          // What was asked for and by which provider; never the text.
          metadata: {
            reference: t.reference,
            kind,
            provider: ai.provider?.id ?? null,
            warnings: out.warnings.length,
          },
        },
      });
      return out;
    } catch (error) {
      if (error instanceof AssistantProviderError) {
        this.logger.warn(
          { kind: error.kind, status: error.status },
          'Support AI suggestion failed',
        );
        throw new AppError(
          error.kind === 'timeout' ? 'ASSISTANT_TIMEOUT' : 'ASSISTANT_UNAVAILABLE',
          'The AI suggestion isn’t available right now. You can still reply yourself.',
        );
      }
      throw error;
    }
  }

  // ─── Metrics ───────────────────────────────────────────────────────────

  /**
   * docs/support.md#metrics. "Now" counts are over active tickets; range
   * figures over tickets created (first response) or resolved (resolution)
   * in the range. Durations come from stored timestamps; the automatic
   * acknowledgement never counts as a first response.
   */
  async metrics(range: '24h' | '7d' | '30d'): Promise<SupportMetrics> {
    const now = this.now();
    const since = new Date(now.getTime() - { '24h': 1, '7d': 7, '30d': 30 }[range] * 86_400_000);
    const [active, created, resolvedRows, staff] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where: { status: { in: ACTIVE_DB } },
        select: {
          status: true,
          priority: true,
          category: true,
          assigneeId: true,
          escalated: true,
          firstResponseAt: true,
          firstResponseDueAt: true,
          resolutionDueAt: true,
        },
      }),
      this.prisma.supportTicket.findMany({
        where: { createdAt: { gte: since } },
        select: {
          createdAt: true,
          firstResponseAt: true,
          firstResponseDueAt: true,
          closedAt: true,
        },
      }),
      this.prisma.supportTicket.findMany({
        where: { resolvedAt: { gte: since } },
        select: { createdAt: true, resolvedAt: true, resolutionDueAt: true },
      }),
      this.prisma.user.findMany({
        where: { status: 'ACTIVE', role: { in: ['SUPPORT', 'ADMIN'] } },
        select: { id: true, displayName: true, role: true },
      }),
    ]);
    const overdue = (t: (typeof active)[number]) =>
      (t.firstResponseAt === null && t.firstResponseDueAt < now) || t.resolutionDueAt < now;
    const responded = created.filter((t) => t.firstResponseAt);
    const resolved = resolvedRows.filter((t) => t.resolvedAt);
    const byCategory = new Map<string, number>();
    const byPriority = new Map<string, number>();
    for (const t of active) {
      byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + 1);
      byPriority.set(t.priority, (byPriority.get(t.priority) ?? 0) + 1);
    }
    return {
      range,
      generatedAt: now.toISOString(),
      open: active.filter((t) => t.status === 'OPEN').length,
      inProgress: active.filter((t) => t.status === 'IN_PROGRESS').length,
      pending: active.filter(
        (t) => t.status === 'WAITING_FOR_CUSTOMER' || t.status === 'WAITING_FOR_PROVIDER',
      ).length,
      unassigned: active.filter((t) => !t.assigneeId).length,
      escalated: active.filter((t) => t.escalated).length,
      overdue: active.filter(overdue).length,
      created: created.length,
      resolved: resolved.length,
      firstResponse: {
        count: responded.length,
        medianMinutes: medianMinutes(
          responded.map((t) => t.firstResponseAt!.getTime() - t.createdAt.getTime()),
        ),
        withinTarget: share(responded.map((t) => t.firstResponseAt! <= t.firstResponseDueAt)),
      },
      resolution: {
        count: resolved.length,
        medianMinutes: medianMinutes(
          resolved.map((t) => t.resolvedAt!.getTime() - t.createdAt.getTime()),
        ),
        withinTarget: share(resolved.map((t) => t.resolvedAt! <= t.resolutionDueAt)),
      },
      byCategory: [...byCategory].map(([c, n]) => ({
        category: lower<SupportCategory>(c),
        active: n,
      })),
      byPriority: [...byPriority].map(([p, n]) => ({
        priority: lower<SupportPriority>(p),
        active: n,
      })),
      workload: staff
        .map((s) => ({
          staff: this.staffOf(s)!,
          active: active.filter((t) => t.assigneeId === s.id).length,
          overdue: active.filter((t) => t.assigneeId === s.id && overdue(t)).length,
        }))
        .filter((w) => w.active > 0)
        .sort((a, b) => b.active - a.active || a.staff.name.localeCompare(b.staff.name)),
    };
  }

  // ─── Maintenance ───────────────────────────────────────────────────────

  /** Closes tickets resolved more than `autoCloseDays` ago with no reply since. */
  async sweep(): Promise<number> {
    const days = this.options.autoCloseDays ?? 7;
    const cutoff = new Date(this.now().getTime() - days * 86_400_000);
    const due = await this.prisma.supportTicket.findMany({
      where: { status: 'RESOLVED', resolvedAt: { lt: cutoff } },
      select: { id: true },
      take: 100,
    });
    let closed = 0;
    for (const { id } of due) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const t = await this.lock(tx, id);
          if (t.status !== 'RESOLVED' || !t.resolvedAt || t.resolvedAt >= cutoff) return;
          const now = this.now();
          const seq = await this.bump(tx, t.id, { status: 'CLOSED', closedAt: now });
          await this.event(tx, t.id, seq, {
            type: 'STATUS_CHANGED',
            actor: { kind: 'SYSTEM', id: null },
            from: 'RESOLVED',
            to: 'CLOSED',
            reason: `No reply ${days} days after it was resolved.`,
          });
          await this.audit(tx, { type: 'SYSTEM', id: null }, 'support.auto_closed', t.id, {
            reference: t.reference,
            days,
          });
          await this.notifyCustomer(
            tx,
            t,
            seq,
            'Your support ticket was closed',
            `${t.reference} was closed ${days} days after it was resolved. Open a new ticket if you need more help.`,
          );
          closed += 1;
        });
      } catch (error) {
        this.logger.warn({ err: errorForLog(error) }, 'Could not auto-close a support ticket');
      }
    }
    return closed;
  }
}
