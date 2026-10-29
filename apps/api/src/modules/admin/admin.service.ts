import {
  ADMIN_PERMISSIONS,
  ADMIN_RANGE_MS,
  ROLE_PERMISSIONS,
  type AdminAuditEntry,
  type adminAuditListQuerySchema,
  type adminBookingListQuerySchema,
  type adminPaymentListQuerySchema,
  type adminUserListQuerySchema,
  type AdminBookingDetail,
  type AdminBookingSummary,
  type AdminNotificationHealth,
  type AdminOverview,
  type AdminPaymentDetail,
  type AdminPaymentSummary,
  type AdminRange,
  type AdminSearchAnalytics,
  type AdminUserDetail,
  type AdminUserSummary,
  type BookingStatus,
  type Money,
  type NotificationType,
  type Pagination,
  type PaymentStatus,
  type UserRole,
} from '@wayora/contracts';
import type { z } from 'zod';
import type { Prisma, PrismaClient } from '@wayora/database';
import type {
  BookingStatus as DbBookingStatus,
  PaymentStatus as DbPaymentStatus,
  UserRole as DbUserRole,
  UserStatus as DbUserStatus,
} from '@wayora/database';
import { CATEGORY, SERVICE_TYPE } from '../../utils/categories.js';
import { AppError } from '../../utils/errors.js';
import { toUserRole } from '../auth/safe-user.js';

/*
 * Admin read models (docs/admin.md). Read-only: nothing here changes a
 * booking, payment or user. Every figure is computed in the database
 * (COUNT / GROUP BY / SUM over indexed columns) for a bounded window; lists
 * are paginated. What the database doesn't know is reported as unavailable,
 * never filled in.
 */

type UsersQuery = z.output<typeof adminUserListQuerySchema>;
type BookingsQuery = z.output<typeof adminBookingListQuerySchema>;
type PaymentsQuery = z.output<typeof adminPaymentListQuerySchema>;
type AuditQuery = z.output<typeof adminAuditListQuerySchema>;
type UserStatus = AdminUserSummary['status'];

const lower = <T extends string>(v: string) => v.toLowerCase() as T;

const BOOKING_STATUS: Record<DbBookingStatus, BookingStatus> = {
  PENDING: 'pending',
  HELD: 'pending',
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  EXPIRED: 'expired',
};
const DB_BOOKING_STATUSES: Record<BookingStatus, DbBookingStatus[]> = {
  pending: ['PENDING', 'HELD'],
  confirmed: ['CONFIRMED'],
  cancelled: ['CANCELLED'],
  failed: ['FAILED'],
  expired: ['EXPIRED'],
};
const upper = <T extends string>(v: string) => v.toUpperCase() as T;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const fromDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const money = (amountMinor: bigint, currency: string): Money => ({
  amountMinor: amountMinor.toString(),
  currency,
});

function pagination(page: number, pageSize: number, total: number): Pagination {
  return { page, pageSize, totalResults: total, totalPages: Math.ceil(total / pageSize) };
}

/** `from`/`to` (UTC days, inclusive) → a createdAt filter. */
function dayRange(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: new Date(`${from}T00:00:00Z`) } : {}),
    ...(to ? { lt: new Date(Date.parse(`${to}T00:00:00Z`) + 24 * 3600 * 1000) } : {}),
  };
}

/** `{ KEY: n }` from a groupBy, with every known key present (0 is a real count here). */
function counts<K extends string>(
  keys: readonly K[],
  rows: { key: string; n: number }[],
  map: (k: string) => string = (k) => k.toLowerCase(),
): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(keys.map((k) => [map(k), 0]));
  for (const { key, n } of rows) out[map(key)] = (out[map(key)] ?? 0) + n;
  return out;
}

const DB_BOOKING_KEYS: DbBookingStatus[] = [
  'PENDING',
  'HELD',
  'CONFIRMED',
  'CANCELLED',
  'FAILED',
  'EXPIRED',
];
const DB_PAYMENT_KEYS: DbPaymentStatus[] = [
  'CREATED',
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'REFUND_PENDING',
  'REFUNDED',
];
const bookingKey = (k: string) => BOOKING_STATUS[k as DbBookingStatus];

/** Last four digits only. */
const maskPhone = (phone: string | null) => (phone ? `•••• ${phone.slice(-4)}` : null);

const paymentSelect = {
  id: true,
  userId: true,
  attempt: true,
  status: true,
  mode: true,
  provider: true,
  currency: true,
  amountMinor: true,
  demoScenario: true,
  refundRequired: true,
  createdAt: true,
  completedAt: true,
  booking: { select: { reference: true } },
} satisfies Prisma.PaymentSelect;
type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof paymentSelect }>;

function presentPayment(row: PaymentRow): AdminPaymentSummary {
  return {
    id: row.id,
    bookingReference: row.booking.reference,
    userId: row.userId,
    attempt: row.attempt,
    status: lower<PaymentStatus>(row.status),
    mode: lower<'demo' | 'live'>(row.mode),
    provider: row.provider,
    amount: money(row.amountMinor, row.currency),
    demoScenario: row.demoScenario,
    refundRequired: row.refundRequired,
    createdAt: iso(row.createdAt),
    completedAt: isoOrNull(row.completedAt),
  };
}

const bookingSelect = {
  reference: true,
  category: true,
  status: true,
  isDemo: true,
  paymentMode: true,
  userId: true,
  currency: true,
  totalAmountMinor: true,
  startsOn: true,
  createdAt: true,
  user: { select: { email: true } },
} satisfies Prisma.BookingSelect;
type BookingRow = Prisma.BookingGetPayload<{ select: typeof bookingSelect }>;

function presentBooking(row: BookingRow): AdminBookingSummary {
  return {
    reference: row.reference,
    serviceType: SERVICE_TYPE[row.category],
    status: BOOKING_STATUS[row.status],
    demo: row.isDemo,
    paymentMode: lower<'none' | 'demo'>(row.paymentMode),
    userId: row.userId,
    userEmail: row.user.email,
    total: row.totalAmountMinor === null ? null : money(row.totalAmountMinor, row.currency),
    startsOn: fromDate(row.startsOn),
    createdAt: iso(row.createdAt),
  };
}

const notFound = (what: string) => new AppError('NOT_FOUND', `There is no ${what} with that id.`);

export interface AdminServiceOptions {
  prisma: PrismaClient;
  now?: () => Date;
  /** Whether an email provider delivers notifications (none exists yet). */
  emailConfigured: boolean;
}

export class AdminService {
  private readonly prisma: PrismaClient;
  private readonly now: () => Date;

  constructor(private readonly options: AdminServiceOptions) {
    this.prisma = options.prisma;
    this.now = options.now ?? (() => new Date());
  }

  me(role: UserRole) {
    return {
      role,
      permissions: ADMIN_PERMISSIONS.filter((p) => ROLE_PERMISSIONS[role].includes(p)),
    };
  }

  private window(range: AdminRange) {
    const to = this.now();
    return { from: new Date(to.getTime() - ADMIN_RANGE_MS[range]), to };
  }

  private async searchTrackedSince(): Promise<Date | null> {
    const first = await this.prisma.searchEvent.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    return first?.createdAt ?? null;
  }

  // ─── Overview ───────────────────────────────────────────────────────────

  async overview(range: AdminRange): Promise<AdminOverview> {
    const { from, to } = this.window(range);
    const inRange = { gte: from, lt: to };
    const db = this.prisma;
    const [
      usersTotal,
      usersNew,
      bookingsTotal,
      bookingsByStatus,
      bookingsByDemo,
      paymentsByStatus,
      paymentsByMode,
      liveRevenue,
      trackedSince,
      searchesByOutcome,
      conversion,
      recentBookings,
      recentPayments,
    ] = await Promise.all([
      db.user.count(),
      db.user.count({ where: { createdAt: inRange } }),
      db.booking.count(),
      db.booking.groupBy({ by: ['status'], where: { createdAt: inRange }, _count: { _all: true } }),
      db.booking.groupBy({ by: ['isDemo'], where: { createdAt: inRange }, _count: { _all: true } }),
      db.payment.groupBy({ by: ['status'], where: { createdAt: inRange }, _count: { _all: true } }),
      db.payment.groupBy({ by: ['mode'], where: { createdAt: inRange }, _count: { _all: true } }),
      // Real revenue: LIVE payments only. Demo payments never count: no money moved.
      db.payment.groupBy({
        by: ['currency'],
        where: {
          mode: 'LIVE',
          status: { in: ['SUCCEEDED', 'REFUND_PENDING'] },
          completedAt: inRange,
        },
        _sum: { amountMinor: true },
      }),
      this.searchTrackedSince(),
      db.searchEvent.groupBy({
        by: ['outcome'],
        where: { createdAt: inRange },
        _count: { _all: true },
      }),
      this.conversion(from, to),
      db.booking.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 8,
        select: { reference: true, status: true, isDemo: true, createdAt: true },
      }),
      db.payment.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 8,
        select: {
          status: true,
          mode: true,
          createdAt: true,
          booking: { select: { reference: true } },
        },
      }),
    ]);

    const bookingsInRange = bookingsByStatus.reduce((n, r) => n + r._count._all, 0);
    const demoCount = bookingsByDemo.find((r) => r.isDemo)?._count._all ?? 0;
    const liveCount = paymentsByMode.find((r) => r.mode === 'LIVE')?._count._all ?? 0;
    const unavailable: AdminOverview['unavailable'] = [];
    if (liveCount === 0) {
      unavailable.push({
        metric: 'Revenue',
        reason:
          'No live payment provider is configured, so there is no real revenue. Demo payments are simulated and never counted.',
      });
    }
    if (!trackedSince || trackedSince > from) {
      unavailable.push({
        metric: 'Searches before tracking began',
        reason: trackedSince
          ? `Searches are recorded from ${iso(trackedSince)}; earlier searches were never stored.`
          : 'No searches have been recorded yet. Searches are recorded from the Phase 15 release onwards.',
      });
    }

    const recent = [
      ...recentBookings.map((b) => ({
        kind: 'booking' as const,
        bookingReference: b.reference,
        status: BOOKING_STATUS[b.status],
        demo: b.isDemo,
        at: b.createdAt,
      })),
      ...recentPayments.map((p) => ({
        kind: 'payment' as const,
        bookingReference: p.booking.reference,
        status: p.status.toLowerCase(),
        demo: p.mode === 'DEMO',
        at: p.createdAt,
      })),
    ]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, 10)
      .map((r) => ({ ...r, at: iso(r.at) }));

    return {
      range,
      from: iso(from),
      to: iso(to),
      timezone: 'UTC',
      users: { total: usersTotal, newInRange: usersNew },
      bookings: {
        total: bookingsTotal,
        inRange: bookingsInRange,
        byStatus: counts(
          DB_BOOKING_KEYS,
          bookingsByStatus.map((r) => ({ key: r.status, n: r._count._all })),
          bookingKey,
        ),
        demo: demoCount,
        real: bookingsInRange - demoCount,
      },
      payments: {
        attemptsInRange: paymentsByStatus.reduce((n, r) => n + r._count._all, 0),
        byStatus: counts(
          DB_PAYMENT_KEYS,
          paymentsByStatus.map((r) => ({ key: r.status, n: r._count._all })),
        ),
        byMode: {
          demo: paymentsByMode.find((r) => r.mode === 'DEMO')?._count._all ?? 0,
          live: liveCount,
        },
        realRevenue: {
          totals: liveRevenue
            .filter((r) => r._sum.amountMinor !== null)
            .map((r) => money(r._sum.amountMinor!, r.currency)),
          note: 'Succeeded live payments completed in the range (refunded ones excluded). Demo payments are never counted.',
        },
      },
      searches: {
        trackedSince: isoOrNull(trackedSince),
        inRange: searchesByOutcome.reduce((n, r) => n + r._count._all, 0),
        byOutcome: counts(
          ['SUCCESS', 'PARTIAL', 'EMPTY', 'FAILED'],
          searchesByOutcome.map((r) => ({ key: r.outcome, n: r._count._all })),
        ),
      },
      conversion,
      recent,
      unavailable,
    };
  }

  /** Distinct recorded search sessions in the window, and how many led to a booking. */
  private async conversion(from: Date, to: Date): Promise<AdminOverview['conversion']> {
    const [row] = await this.prisma.$queryRaw<{ searches: number; converted: number }[]>`
      SELECT count(DISTINCT se.search_id)::int AS searches,
             count(DISTINCT se.search_id) FILTER (
               WHERE EXISTS (SELECT 1 FROM bookings b WHERE b.search_id = se.search_id)
             )::int AS converted
        FROM search_events se
       WHERE se.created_at >= ${from} AND se.created_at < ${to}
         AND se.search_id IS NOT NULL`;
    const searches = row?.searches ?? 0;
    const converted = row?.converted ?? 0;
    return {
      definition:
        'Search sessions recorded in the range that at least one booking was created from (any booking status; demo bookings included, as all bookings are demo bookings today).',
      searches,
      searchesWithBooking: converted,
      rate: searches === 0 ? null : converted / searches,
    };
  }

  // ─── Users ──────────────────────────────────────────────────────────────

  async users(query: UsersQuery) {
    const where: Prisma.UserWhereInput = {
      ...(query.role ? { role: upper<DbUserRole>(query.role) } : {}),
      ...(query.status ? { status: upper<DbUserStatus>(query.status) } : {}),
      ...(query.q
        ? UUID.test(query.q)
          ? { id: query.q }
          : {
              OR: [
                { email: { contains: query.q, mode: 'insensitive' } },
                { displayName: { contains: query.q, mode: 'insensitive' } },
              ],
            }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          displayName: true,
          email: true,
          role: true,
          status: true,
          createdAt: true,
          _count: { select: { bookings: true } },
        },
      }),
    ]);
    return {
      items: rows.map((u): AdminUserSummary => ({
        id: u.id,
        name: u.displayName,
        email: u.email,
        role: toUserRole(u.role),
        status: lower<UserStatus>(u.status),
        createdAt: iso(u.createdAt),
        bookingCount: u._count.bookings,
      })),
      pagination: pagination(query.page, query.pageSize, total),
    };
  }

  async user(id: string): Promise<AdminUserDetail> {
    if (!UUID.test(id)) throw notFound('user');
    const now = this.now();
    // An explicit allow-list: no password hash, phone, session tokens or traveller details.
    const u = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        displayName: true,
        email: true,
        emailVerifiedAt: true,
        role: true,
        status: true,
        createdAt: true,
        _count: { select: { bookings: true, travellers: true } },
      },
    });
    if (!u) throw notFound('user');
    const [
      sessions,
      lastActive,
      bookingsByStatus,
      paymentsByStatus,
      notifications,
      unread,
      recent,
    ] = await Promise.all([
      this.prisma.session.count({
        where: { userId: id, revokedAt: null, expiresAt: { gt: now } },
      }),
      this.prisma.session.aggregate({ where: { userId: id }, _max: { lastActivityAt: true } }),
      this.prisma.booking.groupBy({
        by: ['status'],
        where: { userId: id },
        _count: { _all: true },
      }),
      this.prisma.payment.groupBy({
        by: ['status'],
        where: { userId: id },
        _count: { _all: true },
      }),
      this.prisma.notification.count({ where: { userId: id } }),
      this.prisma.notification.count({ where: { userId: id, readAt: null } }),
      this.prisma.booking.findMany({
        where: { userId: id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 10,
        select: { reference: true, category: true, status: true, isDemo: true, createdAt: true },
      }),
    ]);
    return {
      id: u.id,
      name: u.displayName,
      email: u.email,
      role: toUserRole(u.role),
      status: lower<UserStatus>(u.status),
      createdAt: iso(u.createdAt),
      bookingCount: u._count.bookings,
      emailVerified: u.emailVerifiedAt !== null,
      savedTravellers: u._count.travellers,
      activeSessions: sessions,
      lastActiveAt: isoOrNull(lastActive._max.lastActivityAt),
      bookingsByStatus: counts(
        DB_BOOKING_KEYS,
        bookingsByStatus.map((r) => ({ key: r.status, n: r._count._all })),
        bookingKey,
      ),
      paymentsByStatus: counts(
        DB_PAYMENT_KEYS,
        paymentsByStatus.map((r) => ({ key: r.status, n: r._count._all })),
      ),
      notifications: { total: notifications, unread },
      recentBookings: recent.map((b) => ({
        reference: b.reference,
        serviceType: SERVICE_TYPE[b.category],
        status: BOOKING_STATUS[b.status],
        demo: b.isDemo,
        createdAt: iso(b.createdAt),
      })),
    };
  }

  // ─── Bookings ───────────────────────────────────────────────────────────

  async bookings(query: BookingsQuery) {
    const where: Prisma.BookingWhereInput = {
      ...(query.reference ? { reference: { startsWith: query.reference } } : {}),
      ...(query.serviceType ? { category: CATEGORY[query.serviceType] } : {}),
      ...(query.status ? { status: { in: DB_BOOKING_STATUSES[query.status] } } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(dayRange(query.from, query.to) ? { createdAt: dayRange(query.from, query.to)! } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.booking.count({ where }),
      this.prisma.booking.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: bookingSelect,
      }),
    ]);
    return {
      items: rows.map(presentBooking),
      pagination: pagination(query.page, query.pageSize, total),
    };
  }

  async booking(reference: string): Promise<AdminBookingDetail> {
    const row = await this.prisma.booking.findUnique({
      where: { reference: reference.toUpperCase() },
      select: {
        ...bookingSelect,
        id: true,
        provider: true,
        providerReference: true,
        partySize: true,
        endsOn: true,
        contactPhone: true,
        paymentDueAt: true,
        confirmedAt: true,
        cancelledAt: true,
        offerSnapshot: true,
        travellers: {
          orderBy: { position: 'asc' },
          select: { firstName: true, lastName: true, type: true },
        },
        events: {
          orderBy: { createdAt: 'asc' },
          select: { toStatus: true, actorType: true, note: true, createdAt: true },
        },
        payments: { orderBy: { attempt: 'asc' }, select: paymentSelect },
        notifications: {
          orderBy: { createdAt: 'asc' },
          take: 50,
          select: { type: true, title: true, readAt: true, createdAt: true },
        },
      },
    });
    if (!row) throw new AppError('NOT_FOUND', 'There is no booking with that reference.');
    const snapshot = row.offerSnapshot as { providerName?: unknown } | null;
    return {
      ...presentBooking(row),
      providerName:
        typeof snapshot?.providerName === 'string' ? snapshot.providerName : (row.provider ?? ''),
      supplierReference: row.isDemo ? null : row.providerReference,
      partySize: row.partySize,
      endsOn: fromDate(row.endsOn),
      paymentDueAt: isoOrNull(row.paymentDueAt),
      confirmedAt: isoOrNull(row.confirmedAt),
      cancelledAt: isoOrNull(row.cancelledAt),
      travellers: row.travellers.map((t) => ({
        firstName: t.firstName,
        lastName: t.lastName,
        type: t.type ? t.type.toLowerCase() : null,
      })),
      contactPhoneMasked: maskPhone(row.contactPhone),
      offerSnapshot: row.offerSnapshot,
      history: row.events.map((e) => ({
        status: BOOKING_STATUS[e.toStatus],
        at: iso(e.createdAt),
        by: e.actorType.toLowerCase(),
        note: e.note,
      })),
      payments: row.payments.map(presentPayment),
      notifications: row.notifications.map((n) => ({
        type: lower<NotificationType>(n.type),
        title: n.title,
        read: n.readAt !== null,
        createdAt: iso(n.createdAt),
      })),
    };
  }

  // ─── Payments ───────────────────────────────────────────────────────────

  async payments(query: PaymentsQuery) {
    const q = query.q;
    const where: Prisma.PaymentWhereInput = {
      ...(q
        ? UUID.test(q)
          ? { id: q }
          : { booking: { reference: { startsWith: q.toUpperCase() } } }
        : {}),
      ...(query.status ? { status: upper<DbPaymentStatus>(query.status) } : {}),
      ...(query.mode ? { mode: upper<'DEMO' | 'LIVE'>(query.mode) } : {}),
      ...(dayRange(query.from, query.to) ? { createdAt: dayRange(query.from, query.to)! } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: paymentSelect,
      }),
    ]);
    return {
      items: rows.map(presentPayment),
      pagination: pagination(query.page, query.pageSize, total),
    };
  }

  async payment(id: string): Promise<AdminPaymentDetail> {
    if (!UUID.test(id)) throw notFound('payment');
    // No idempotency key hash, raw provider payloads or signatures.
    const row = await this.prisma.payment.findUnique({
      where: { id },
      select: {
        ...paymentSelect,
        providerReference: true,
        failureCode: true,
        failureMessage: true,
        events: {
          orderBy: { createdAt: 'asc' },
          select: { toStatus: true, actorType: true, note: true, createdAt: true },
        },
      },
    });
    if (!row) throw notFound('payment');
    const providerEvents = row.providerReference
      ? await this.prisma.webhookEvent.findMany({
          where: {
            provider: row.provider,
            payload: { path: ['providerReference'], equals: row.providerReference },
          },
          orderBy: { receivedAt: 'asc' },
          take: 50,
          select: {
            eventType: true,
            status: true,
            payload: true,
            attempts: true,
            lastError: true,
            receivedAt: true,
            processedAt: true,
          },
        })
      : [];
    const demo = row.mode === 'DEMO';
    return {
      ...presentPayment(row),
      providerReference: row.providerReference,
      failure:
        row.failureCode !== null
          ? { code: row.failureCode, message: row.failureMessage ?? '' }
          : null,
      refund: {
        required: row.refundRequired,
        supported: false,
        note: demo
          ? 'Demo payment: no money moved, so there is nothing to refund. Refunds are not available from the dashboard.'
          : 'Refunds are not available from the dashboard: no live payment provider is integrated.',
      },
      history: row.events.map((e) => ({
        status: e.toStatus.toLowerCase(),
        at: iso(e.createdAt),
        by: e.actorType.toLowerCase(),
        note: e.note,
      })),
      providerEvents: providerEvents.map((e) => {
        const source = (e.payload as { source?: unknown } | null)?.source;
        return {
          type: e.eventType,
          status: e.status.toLowerCase(),
          source: typeof source === 'string' ? source : null,
          attempts: e.attempts,
          lastError: e.lastError ? e.lastError.slice(0, 255) : null,
          receivedAt: iso(e.receivedAt),
          processedAt: isoOrNull(e.processedAt),
        };
      }),
    };
  }

  // ─── Search analytics ───────────────────────────────────────────────────

  async searchAnalytics(range: AdminRange): Promise<AdminSearchAnalytics> {
    const { from, to } = this.window(range);
    const inRange = { gte: from, lt: to };
    const bucket = range === '24h' ? 'hour' : 'day';
    const [trackedSince, byOutcome, byCategory, series, providerCounts, providerTimes] =
      await Promise.all([
        this.searchTrackedSince(),
        this.prisma.searchEvent.groupBy({
          by: ['outcome'],
          where: { createdAt: inRange },
          _count: { _all: true },
        }),
        this.prisma.searchEvent.groupBy({
          by: ['category'],
          where: { createdAt: inRange },
          _count: { _all: true },
        }),
        this.prisma.$queryRaw<{ start: Date; count: number; failed: number }[]>`
          SELECT date_trunc(${bucket}, created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS start,
                 count(*)::int AS count,
                 count(*) FILTER (WHERE outcome = 'FAILED')::int AS failed
            FROM search_events
           WHERE created_at >= ${from} AND created_at < ${to}
           GROUP BY 1 ORDER BY 1`,
        this.prisma.$queryRaw<{ id: string; status: string; n: number }[]>`
          SELECT p->>'id' AS id, p->>'status' AS status, count(*)::int AS n
            FROM search_events se, jsonb_array_elements(se.providers) p
           WHERE se.created_at >= ${from} AND se.created_at < ${to}
           GROUP BY 1, 2`,
        this.prisma.$queryRaw<
          { id: string; calls: number; avg: number | null; p95: number | null }[]
        >`
          SELECT p->>'id' AS id, count(*)::int AS calls,
                 avg((p->>'durationMs')::int)::float8 AS avg,
                 percentile_cont(0.95) WITHIN GROUP (ORDER BY (p->>'durationMs')::int)::float8 AS p95
            FROM search_events se, jsonb_array_elements(se.providers) p
           WHERE se.created_at >= ${from} AND se.created_at < ${to}
           GROUP BY 1 ORDER BY 1`,
      ]);

    // Buckets with no rows are real zeros only once tracking had begun.
    const step = bucket === 'hour' ? 3600_000 : 24 * 3600_000;
    const floor = (d: Date) =>
      bucket === 'hour'
        ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())
        : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const byStart = new Map(series.map((r) => [r.start.getTime(), r]));
    const filled: AdminSearchAnalytics['series'] = [];
    if (trackedSince) {
      const first = Math.max(floor(from), floor(trackedSince));
      for (let t = first; t <= floor(to); t += step) {
        const r = byStart.get(t);
        filled.push({
          start: new Date(t).toISOString(),
          count: r?.count ?? 0,
          failed: r?.failed ?? 0,
        });
      }
    }

    const unavailable: AdminSearchAnalytics['unavailable'] = [
      {
        metric: 'Search details',
        reason:
          'Routes, dates, travellers and who searched are deliberately not recorded; only category, outcome, timing and provider status are.',
      },
    ];
    if (!trackedSince || trackedSince > from) {
      unavailable.push({
        metric: 'Earlier searches',
        reason: trackedSince
          ? `Searches are recorded from ${iso(trackedSince)}; earlier ones were never stored (search sessions expire from Redis).`
          : 'No searches have been recorded yet.',
      });
    }

    return {
      range,
      from: iso(from),
      to: iso(to),
      timezone: 'UTC',
      trackedSince: isoOrNull(trackedSince),
      total: byOutcome.reduce((n, r) => n + r._count._all, 0),
      byOutcome: counts(
        ['SUCCESS', 'PARTIAL', 'EMPTY', 'FAILED'],
        byOutcome.map((r) => ({ key: r.outcome, n: r._count._all })),
      ),
      byCategory: counts(
        Object.keys(SERVICE_TYPE),
        byCategory.map((r) => ({ key: r.category, n: r._count._all })),
        (k) => SERVICE_TYPE[k as keyof typeof SERVICE_TYPE],
      ),
      series: filled,
      bucket,
      providers: providerTimes.map((p) => ({
        id: p.id,
        calls: p.calls,
        byStatus: Object.fromEntries(
          providerCounts.filter((c) => c.id === p.id).map((c) => [c.status, c.n]),
        ),
        avgMs: p.avg === null ? null : Math.round(p.avg),
        p95Ms: p.p95 === null ? null : Math.round(p.p95),
      })),
      unavailable,
    };
  }

  // ─── Notifications ──────────────────────────────────────────────────────

  async notificationHealth(range: AdminRange): Promise<AdminNotificationHealth> {
    const { from, to } = this.window(range);
    const inRange = { gte: from, lt: to };
    const [byType, deliveries, oldestPending] = await Promise.all([
      this.prisma.notification.groupBy({
        by: ['type'],
        where: { createdAt: inRange },
        _count: { _all: true },
      }),
      this.prisma.notificationDelivery.groupBy({
        by: ['status'],
        where: { createdAt: inRange },
        _count: { _all: true },
      }),
      this.prisma.notificationDelivery.findFirst({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);
    return {
      range,
      from: iso(from),
      to: iso(to),
      timezone: 'UTC',
      createdInRange: byType.reduce((n, r) => n + r._count._all, 0),
      byType: counts(
        [
          'BOOKING_CREATED',
          'BOOKING_CONFIRMED',
          'BOOKING_CANCELLED',
          'BOOKING_EXPIRED',
          'PAYMENT_PENDING',
          'PAYMENT_SUCCEEDED',
          'PAYMENT_FAILED',
          'PAYMENT_REFUNDED',
          'TRAVEL_REMINDER',
          'TRIP_DISRUPTION',
          'PLAN_INVITATION',
          'PLAN_INVITATION_ACCEPTED',
          'PLAN_INVITATION_DECLINED',
          'PLAN_MEMBER_CHANGED',
          'PLAN_UPDATED',
        ],
        byType.map((r) => ({ key: r.type, n: r._count._all })),
      ),
      deliveries: {
        byStatus: counts(
          ['PENDING', 'SENT', 'FAILED', 'NOT_CONFIGURED'],
          deliveries.map((r) => ({ key: r.status, n: r._count._all })),
        ),
        oldestPendingAt: isoOrNull(oldestPending?.createdAt),
      },
      email: this.options.emailConfigured
        ? { configured: true, note: 'An email provider is configured.' }
        : {
            configured: false,
            note: 'No email provider is configured: email deliveries are recorded as "not configured" and nothing is sent. In-app notifications work normally.',
          },
    };
  }

  // ─── Audit logs ─────────────────────────────────────────────────────────

  async auditLogs(query: AuditQuery) {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.action ? { action: { startsWith: query.action } } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(dayRange(query.from, query.to) ? { createdAt: dayRange(query.from, query.to)! } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: rows.map((r): AdminAuditEntry => ({
        id: r.id,
        at: iso(r.createdAt),
        actorType: lower<AdminAuditEntry['actorType']>(r.actorType),
        actorId: r.actorId,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        requestId: r.requestId,
        metadata:
          r.metadata && typeof r.metadata === 'object' && !Array.isArray(r.metadata)
            ? (r.metadata as Record<string, unknown>)
            : null,
      })),
      pagination: pagination(query.page, query.pageSize, total),
    };
  }
}
