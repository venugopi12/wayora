import { z } from 'zod';
import { userRoleSchema, type UserRole } from './auth.js';
import { bookingReferenceSchema, bookingStatusSchema, reservationStateSchema } from './bookings.js';
import { moneySchema } from './money.js';
import { notificationTypeSchema } from './notifications.js';
import { paymentModeSchema, paymentStatusSchema } from './payments.js';
import { paginationSchema, searchServiceTypeSchema } from './search/common.js';

/*
 * Admin dashboard (Phase 15, docs/admin.md). Staff-only, read-only
 * operations views over data that exists in the database. Roles and
 * permissions live here so the API (which enforces them) and the web app
 * (which only hides what it can't use) can't disagree.
 */

// ─── Roles and permissions ────────────────────────────────────────────────

export const ADMIN_PERMISSIONS = [
  'admin.overview.read',
  'admin.users.read',
  'admin.bookings.read',
  'admin.payments.read',
  'admin.search.read',
  'admin.notifications.read',
  'admin.health.read',
  'admin.audit.read',
  /** Recheck a supplier reservation, or record a manual outcome (Phase 23). Admins only. */
  'admin.reservations.manage',
  /** Loyalty balances, transactions, credits and rules (Phase 25). Read-only. */
  'admin.rewards.read',
  /** Manual points adjustments, issuing or revoking travel credit, new rule versions (Phase 25). Admins only. */
  'admin.rewards.manage',
  /** Promotions and coupons, their usage and performance (Phase 26). Read-only. */
  'admin.promotions.read',
  /** Create, edit, activate or deactivate promotions (Phase 26). Admins only. */
  'admin.promotions.manage',
  /** Support queue, tickets, conversations, notes, history and metrics (Phase 27). Read-only. */
  'admin.support.read',
  /** Reply, add internal notes, change status, take or release tickets, escalate (Phase 27). */
  'admin.support.manage',
  /** Assign tickets to others, change priority, handle and de-escalate escalated tickets (Phase 27). Admins only. */
  'admin.support.supervise',
] as const;
export const adminPermissionSchema = z.enum(ADMIN_PERMISSIONS);
export type AdminPermission = z.infer<typeof adminPermissionSchema>;

/** The only place roles map to permissions. `user` has none. */
export const ROLE_PERMISSIONS: Record<UserRole, readonly AdminPermission[]> = {
  user: [],
  support: [
    'admin.overview.read',
    'admin.users.read',
    'admin.bookings.read',
    'admin.payments.read',
    'admin.search.read',
    'admin.notifications.read',
    'admin.health.read',
    'admin.rewards.read',
    'admin.promotions.read',
    'admin.support.read',
    'admin.support.manage',
  ],
  admin: ADMIN_PERMISSIONS,
};

export function hasPermission(role: UserRole, permission: AdminPermission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export const isStaff = (role: UserRole) => ROLE_PERMISSIONS[role].length > 0;

export const adminMeSchema = z.object({
  role: userRoleSchema,
  permissions: z.array(adminPermissionSchema),
});
export type AdminMe = z.infer<typeof adminMeSchema>;

// ─── Shared query parts ──────────────────────────────────────────────────

/** Fixed analytics windows (UTC), so no query is unbounded. */
export const adminRangeSchema = z.enum(['24h', '7d', '30d']);
export type AdminRange = z.infer<typeof adminRangeSchema>;
export const ADMIN_RANGE_MS: Record<AdminRange, number> = {
  '24h': 24 * 3600 * 1000,
  '7d': 7 * 24 * 3600 * 1000,
  '30d': 30 * 24 * 3600 * 1000,
};
export const rangeQuerySchema = z.object({ range: adminRangeSchema.default('7d') }).strict();

const page = {
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};
/** YYYY-MM-DD (UTC day). Lists may span at most a year. */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const dateFilter = {
  from: day.optional(),
  to: day.optional(),
};
const withDateLimit = <T extends z.ZodType<{ from?: string | undefined; to?: string | undefined }>>(
  schema: T,
) =>
  schema.refine(
    (v) => {
      if (!v.from || !v.to) return true;
      const span = Date.parse(`${v.to}T00:00:00Z`) - Date.parse(`${v.from}T00:00:00Z`);
      return span >= 0 && span <= 366 * 24 * 3600 * 1000;
    },
    { message: 'Choose a date range of at most a year, with "from" before "to".', path: ['to'] },
  );

/** Free-text search: trimmed, bounded, printable. */
const searchText = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((v) => ![...v].some((c) => c.charCodeAt(0) < 0x20), 'Remove control characters.');

/** Statuses "not available" metrics carry instead of a made-up zero. */
export const unavailableSchema = z.object({ metric: z.string(), reason: z.string() });

export const recordCountsSchema = z.record(z.string(), z.number().int().min(0));

// ─── Overview ─────────────────────────────────────────────────────────────

export const adminOverviewSchema = z.object({
  range: adminRangeSchema,
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  /** All windows are rolling, in UTC. */
  timezone: z.literal('UTC'),
  users: z.object({ total: z.number().int(), newInRange: z.number().int() }),
  bookings: z.object({
    total: z.number().int(),
    inRange: z.number().int(),
    /** Bookings created in the range, by their current status. */
    byStatus: recordCountsSchema,
    /** Of those, simulated (demo) versus real supplier bookings. */
    demo: z.number().int(),
    real: z.number().int(),
  }),
  payments: z.object({
    attemptsInRange: z.number().int(),
    byStatus: recordCountsSchema,
    byMode: z.object({ demo: z.number().int(), live: z.number().int() }),
    /**
     * Real revenue: succeeded LIVE payments (minus refunded) by currency, in
     * the range. Demo payments are never counted: no money moved.
     */
    realRevenue: z.object({ totals: z.array(moneySchema), note: z.string() }),
  }),
  searches: z.object({
    /** Recorded since Phase 15 (search_events); earlier searches were never stored. */
    trackedSince: z.iso.datetime().nullable(),
    inRange: z.number().int(),
    byOutcome: recordCountsSchema,
  }),
  conversion: z.object({
    definition: z.string(),
    searches: z.number().int(),
    searchesWithBooking: z.number().int(),
    /** null when there were no searches. */
    rate: z.number().min(0).max(1).nullable(),
  }),
  recent: z.array(
    z.object({
      kind: z.enum(['booking', 'payment']),
      bookingReference: bookingReferenceSchema,
      status: z.string(),
      demo: z.boolean(),
      at: z.iso.datetime(),
    }),
  ),
  unavailable: z.array(unavailableSchema),
});
export type AdminOverview = z.infer<typeof adminOverviewSchema>;

// ─── Users ───────────────────────────────────────────────────────────────

export const adminUserStatusSchema = z.enum(['active', 'suspended', 'deleted']);

export const adminUserListQuerySchema = z
  .object({
    q: searchText.optional(),
    role: userRoleSchema.optional(),
    status: adminUserStatusSchema.optional(),
    ...page,
  })
  .strict();
export type AdminUserListQuery = z.input<typeof adminUserListQuerySchema>;

export const adminUserSummarySchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  email: z.string(),
  role: userRoleSchema,
  status: adminUserStatusSchema,
  createdAt: z.iso.datetime(),
  bookingCount: z.number().int(),
});
export type AdminUserSummary = z.infer<typeof adminUserSummarySchema>;

export const adminUserListSchema = z.object({
  items: z.array(adminUserSummarySchema),
  pagination: paginationSchema,
});

export const adminUserDetailSchema = adminUserSummarySchema.extend({
  emailVerified: z.boolean(),
  savedTravellers: z.number().int(),
  activeSessions: z.number().int(),
  lastActiveAt: z.iso.datetime().nullable(),
  bookingsByStatus: recordCountsSchema,
  paymentsByStatus: recordCountsSchema,
  notifications: z.object({ total: z.number().int(), unread: z.number().int() }),
  recentBookings: z.array(
    z.object({
      reference: bookingReferenceSchema,
      serviceType: searchServiceTypeSchema,
      status: bookingStatusSchema,
      demo: z.boolean(),
      createdAt: z.iso.datetime(),
    }),
  ),
});
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>;

// ─── Bookings ────────────────────────────────────────────────────────────

export const adminBookingListQuerySchema = withDateLimit(
  z
    .object({
      reference: z
        .string()
        .trim()
        .toUpperCase()
        .regex(
          /^[A-Z0-9-]{1,13}$/,
          'Use letters, digits and "-" (a WYD- or WY- reference or its start).',
        )
        .optional(),
      serviceType: searchServiceTypeSchema.optional(),
      status: bookingStatusSchema.optional(),
      userId: z.uuid().optional(),
      /** Only supplier bookings whose reservation needs staff attention (Phase 23). */
      attention: z.literal('true').optional(),
      ...dateFilter,
      ...page,
    })
    .strict(),
);
export type AdminBookingListQuery = z.input<typeof adminBookingListQuerySchema>;

export const adminBookingSummarySchema = z.object({
  reference: bookingReferenceSchema,
  serviceType: searchServiceTypeSchema,
  status: bookingStatusSchema,
  demo: z.boolean(),
  paymentMode: z.enum(['none', 'demo']),
  userId: z.uuid(),
  userEmail: z.string(),
  total: moneySchema.nullable(),
  startsOn: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /** Supplier reservation state (null for demo bookings; Phase 23). */
  reservationStatus: reservationStateSchema.nullable(),
  /** Automatic recovery stopped: reconcile with the supplier. */
  needsAttention: z.boolean(),
});
export type AdminBookingSummary = z.infer<typeof adminBookingSummarySchema>;

export const adminBookingListSchema = z.object({
  items: z.array(adminBookingSummarySchema),
  pagination: paginationSchema,
});

export const adminPaymentSummarySchema = z.object({
  id: z.uuid(),
  bookingReference: bookingReferenceSchema,
  userId: z.uuid(),
  attempt: z.number().int(),
  status: paymentStatusSchema,
  mode: paymentModeSchema,
  provider: z.string(),
  amount: moneySchema,
  demoScenario: z.string().nullable(),
  refundRequired: z.boolean(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});
export type AdminPaymentSummary = z.infer<typeof adminPaymentSummarySchema>;

const historyItemSchema = z.object({
  status: z.string(),
  at: z.iso.datetime(),
  by: z.string(),
  note: z.string().nullable(),
});

/** The operational view of a supplier reservation (no payloads, secrets or traveller data). */
export const adminReservationSchema = z.object({
  provider: z.string(),
  status: reservationStateSchema,
  /**
   * The supplier's reference: in full for staff who can manage
   * reservations, otherwise masked to its last four characters.
   */
  supplierReference: z.string().nullable(),
  /** Correlation id of the request that last changed it. */
  requestId: z.string().nullable(),
  attempts: z.number().int(),
  checks: z.number().int(),
  cancelAttempts: z.number().int(),
  lastAttemptAt: z.iso.datetime().nullable(),
  nextCheckAt: z.iso.datetime().nullable(),
  errorCategory: z.string().nullable(),
  ambiguous: z.boolean(),
  needsAttention: z.boolean(),
  confirmedAt: z.iso.datetime().nullable(),
  cancellationRequestedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  /** What the supplier can do through its adapter (from the registry). */
  capabilities: z.object({
    lookup: z.boolean(),
    cancel: z.boolean(),
    idempotentReserve: z.boolean(),
  }),
  /** The safe admin actions available now. */
  actions: z.object({ recheck: z.boolean(), resolve: z.boolean() }),
  documents: z.array(
    z.object({ type: z.string(), reference: z.string(), issuedAt: z.iso.datetime() }),
  ),
  history: z.array(
    historyItemSchema.extend({
      errorCategory: z.string().nullable(),
      requestId: z.string().nullable(),
    }),
  ),
});
export type AdminReservation = z.infer<typeof adminReservationSchema>;

export const adminRefundSchema = z.object({
  id: z.uuid(),
  paymentId: z.uuid(),
  status: z.string(),
  reason: z.string(),
  mode: paymentModeSchema,
  amount: moneySchema,
  attempts: z.number().int(),
  failureCode: z.string().nullable(),
  needsAttention: z.boolean(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

export const adminBookingDetailSchema = adminBookingSummarySchema.extend({
  providerName: z.string(),
  /** The supplier's own reference; null for demo bookings (no supplier is contacted). */
  supplierReference: z.string().nullable(),
  partySize: z.number().int(),
  endsOn: z.string().nullable(),
  paymentDueAt: z.iso.datetime().nullable(),
  confirmedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  /** Names only (who travels); no other traveller data. */
  travellers: z.array(
    z.object({ firstName: z.string(), lastName: z.string(), type: z.string().nullable() }),
  ),
  /** Last four digits only. */
  contactPhoneMasked: z.string().nullable(),
  /** The offer exactly as booked (immutable). */
  offerSnapshot: z.unknown(),
  history: z.array(historyItemSchema),
  payments: z.array(adminPaymentSummarySchema),
  /** Supplier bookings only (Phase 23). */
  reservation: adminReservationSchema.nullable(),
  refunds: z.array(adminRefundSchema),
  notifications: z.array(
    z.object({
      type: notificationTypeSchema,
      title: z.string(),
      read: z.boolean(),
      createdAt: z.iso.datetime(),
    }),
  ),
});
export type AdminBookingDetail = z.infer<typeof adminBookingDetailSchema>;

/**
 * Recording the outcome of a reservation that automatic recovery couldn't
 * settle, after staff confirmed it with the supplier (Phase 23). Never sends
 * anything to the supplier.
 * - A reservation request: `confirmed` (with the supplier's reference) or `failed`.
 * - A cancellation: `cancelled`, or `confirmed` (the supplier kept the
 *   reservation; its reference must match the one on record).
 */
export const adminReservationResolveSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('confirmed'),
      supplierReference: z
        .string()
        .trim()
        .min(1)
        .max(128)
        .regex(/^[\x21-\x7e]+$/, 'Use the supplier’s reference exactly as it gave it.'),
      reason: z.string().trim().min(10, 'Say how this was confirmed (10+ characters).').max(500),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('failed'),
      reason: z.string().trim().min(10, 'Say how this was confirmed (10+ characters).').max(500),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('cancelled'),
      reason: z.string().trim().min(10, 'Say how this was confirmed (10+ characters).').max(500),
    })
    .strict(),
]);
export type AdminReservationResolve = z.input<typeof adminReservationResolveSchema>;

// ─── Payments ────────────────────────────────────────────────────────────

export const adminPaymentListQuerySchema = withDateLimit(
  z
    .object({
      /** A payment id, or a booking reference. */
      q: searchText.optional(),
      status: paymentStatusSchema.optional(),
      mode: paymentModeSchema.optional(),
      ...dateFilter,
      ...page,
    })
    .strict(),
);
export type AdminPaymentListQuery = z.input<typeof adminPaymentListQuerySchema>;

export const adminPaymentListSchema = z.object({
  items: z.array(adminPaymentSummarySchema),
  pagination: paginationSchema,
});

export const adminPaymentDetailSchema = adminPaymentSummarySchema.extend({
  /** The provider's id for the attempt (not a secret). */
  providerReference: z.string().nullable(),
  failure: z.object({ code: z.string(), message: z.string() }).nullable(),
  refund: z.object({ required: z.boolean(), supported: z.boolean(), note: z.string() }),
  history: z.array(historyItemSchema),
  providerEvents: z.array(
    z.object({
      type: z.string(),
      status: z.string(),
      source: z.string().nullable(),
      attempts: z.number().int(),
      lastError: z.string().nullable(),
      receivedAt: z.iso.datetime(),
      processedAt: z.iso.datetime().nullable(),
    }),
  ),
});
export type AdminPaymentDetail = z.infer<typeof adminPaymentDetailSchema>;

// ─── Search analytics ────────────────────────────────────────────────────

export const adminSearchAnalyticsSchema = z.object({
  range: adminRangeSchema,
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  timezone: z.literal('UTC'),
  trackedSince: z.iso.datetime().nullable(),
  total: z.number().int(),
  byOutcome: recordCountsSchema,
  byCategory: recordCountsSchema,
  /** Hourly (24h) or daily buckets, oldest first. */
  series: z.array(
    z.object({ start: z.iso.datetime(), count: z.number().int(), failed: z.number().int() }),
  ),
  bucket: z.enum(['hour', 'day']),
  providers: z.array(
    z.object({
      id: z.string(),
      calls: z.number().int(),
      byStatus: recordCountsSchema,
      avgMs: z.number().nullable(),
      p95Ms: z.number().nullable(),
    }),
  ),
  unavailable: z.array(unavailableSchema),
});
export type AdminSearchAnalytics = z.infer<typeof adminSearchAnalyticsSchema>;

// ─── Notifications ───────────────────────────────────────────────────────

export const adminNotificationHealthSchema = z.object({
  range: adminRangeSchema,
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  timezone: z.literal('UTC'),
  createdInRange: z.number().int(),
  byType: recordCountsSchema,
  deliveries: z.object({
    byStatus: recordCountsSchema,
    oldestPendingAt: z.iso.datetime().nullable(),
  }),
  email: z.object({ configured: z.boolean(), note: z.string() }),
});
export type AdminNotificationHealth = z.infer<typeof adminNotificationHealthSchema>;

// ─── Audit logs ──────────────────────────────────────────────────────────

export const adminAuditListQuerySchema = withDateLimit(
  z
    .object({
      action: z
        .string()
        .trim()
        .regex(/^[a-z0-9_.]{1,128}$/, 'Use an action name like "payment.created" or its start.')
        .optional(),
      actorId: z.string().trim().min(1).max(64).optional(),
      entityType: z
        .string()
        .trim()
        .regex(/^[a-z_]{1,64}$/)
        .optional(),
      entityId: z.string().trim().min(1).max(64).optional(),
      ...dateFilter,
      ...page,
    })
    .strict(),
);
export type AdminAuditListQuery = z.input<typeof adminAuditListQuerySchema>;

export const adminAuditEntrySchema = z.object({
  id: z.uuid(),
  at: z.iso.datetime(),
  actorType: z.enum(['user', 'system', 'admin', 'provider']),
  actorId: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  requestId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});
export type AdminAuditEntry = z.infer<typeof adminAuditEntrySchema>;

export const adminAuditListSchema = z.object({
  items: z.array(adminAuditEntrySchema),
  pagination: paginationSchema,
});

// ─── Health ──────────────────────────────────────────────────────────────

export const adminCheckStatusSchema = z.enum([
  'up',
  'down',
  'degraded',
  'unknown',
  'not-configured',
]);
export type AdminCheckStatus = z.infer<typeof adminCheckStatusSchema>;

export const adminHealthSchema = z.object({
  checkedAt: z.iso.datetime(),
  /** Seconds this report may be reused (it's cached briefly). */
  maxAgeSeconds: z.number().int(),
  api: z.object({ status: z.literal('up'), uptimeSeconds: z.number().int() }),
  database: z.object({ status: adminCheckStatusSchema, latencyMs: z.number().int().nullable() }),
  redis: z.object({ status: adminCheckStatusSchema, latencyMs: z.number().int().nullable() }),
  worker: z.object({
    status: adminCheckStatusSchema,
    lastHeartbeatAt: z.iso.datetime().nullable(),
    note: z.string(),
  }),
  queue: z.object({
    status: adminCheckStatusSchema,
    waiting: z.number().int().nullable(),
    active: z.number().int().nullable(),
    delayed: z.number().int().nullable(),
    failed: z.number().int().nullable(),
  }),
  outbox: z.object({
    status: adminCheckStatusSchema,
    pending: z.number().int().nullable(),
    failed: z.number().int().nullable(),
    notConfigured: z.number().int().nullable(),
    oldestPendingAt: z.iso.datetime().nullable(),
  }),
  payments: z.object({
    status: adminCheckStatusSchema,
    inProgress: z.number().int().nullable(),
    oldestInProgressAt: z.iso.datetime().nullable(),
  }),
  /** Travel-status provider (Phase 17, docs/trips.md#providers). */
  travelStatus: z.object({
    status: adminCheckStatusSchema,
    providerName: z.string().nullable(),
    /** The demo provider: simulated data. */
    simulated: z.boolean(),
    /** Bookings whose latest status check failed within the last hour. */
    failedChecksLastHour: z.number().int().nullable(),
  }),
  /**
   * Search providers (Phase 22, docs/providers.md#failures-retries-and-health): one entry per
   * registered adapter. Status comes from what is actually known: the
   * circuit breaker in this API process and provider calls recorded in the
   * last hour. A provider with no recent calls is `unknown`, never `up`.
   */
  searchProviders: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.enum(['demo', 'live']),
      serviceTypes: z.array(z.string()),
      enabled: z.boolean(),
      disabledReason: z.string().nullable(),
      status: adminCheckStatusSchema,
      breaker: z.enum(['closed', 'open', 'half-open']),
      callsLastHour: z.number().int().nullable(),
      failedLastHour: z.number().int().nullable(),
      /** Supports rechecking an offer's price and availability before booking. */
      revalidates: z.boolean(),
    }),
  ),
  /** Travel assistant provider (Phase 21, docs/assistant.md). No network check: it would cost money. */
  assistant: z.object({
    status: adminCheckStatusSchema,
    providerName: z.string().nullable(),
    /** The rule-based demo assistant, not AI. */
    simulated: z.boolean(),
    /** Provider calls that failed (error, timeout, unusable answer) in the last hour. */
    failedRequestsLastHour: z.number().int().nullable(),
  }),
});
export type AdminHealth = z.infer<typeof adminHealthSchema>;

/** Worker heartbeat key in Redis (written by the worker, read by the API). */
export const WORKER_HEARTBEAT_KEY = 'wayora:worker:heartbeat';
/** A heartbeat older than this means the worker isn't running. */
export const WORKER_HEARTBEAT_STALE_MS = 60_000;
