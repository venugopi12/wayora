import { z } from 'zod';
import {
  BOOKING_REFERENCE_ALPHABET,
  bookingPaymentStateSchema,
  bookingReferenceSchema,
  bookingStatusSchema,
  refundStateSchema,
  reservationStateSchema,
} from './bookings.js';
import { travelCategorySlugSchema } from './catalog.js';
import { offsetDateTimeSchema, paginationSchema } from './search/common.js';

/*
 * Customer support (Phase 27, docs/support.md).
 *
 * Tickets belong to the signed-in customer who opened them; support staff
 * (the existing `support` and `admin` roles) work them from the admin
 * dashboard. Everything here is validated on the server: the client never
 * names a user, an owner, a status it wasn't allowed, or booking details.
 * Internal notes exist only in the staff schemas.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────

export const SUPPORT_STATUSES = [
  'open',
  'in_progress',
  'waiting_for_customer',
  'waiting_for_provider',
  'resolved',
  'closed',
] as const;
export const supportStatusSchema = z.enum(SUPPORT_STATUSES);
export type SupportStatus = z.infer<typeof supportStatusSchema>;

export const SUPPORT_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const supportPrioritySchema = z.enum(SUPPORT_PRIORITIES);
export type SupportPriority = z.infer<typeof supportPrioritySchema>;
/** Customers choose among these; `urgent` is set by staff only. */
export const customerPrioritySchema = z.enum(['low', 'normal', 'high']);

export const SUPPORT_CATEGORIES = [
  'booking',
  'payment',
  'cancellation',
  'refund',
  'flight',
  'hotel',
  'train_bus',
  'rewards',
  'promotions',
  'account',
  'technical',
  'general',
] as const;
export const supportCategorySchema = z.enum(SUPPORT_CATEGORIES);
export type SupportCategory = z.infer<typeof supportCategorySchema>;

export const SUPPORT_CATEGORY_LABEL: Record<SupportCategory, string> = {
  booking: 'Booking assistance',
  payment: 'Payment issues',
  cancellation: 'Cancellation requests',
  refund: 'Refund status',
  flight: 'Flight-related issues',
  hotel: 'Hotel-related issues',
  train_bus: 'Train and bus issues',
  rewards: 'Travel credits and rewards',
  promotions: 'Coupons and promotions',
  account: 'Account and login issues',
  technical: 'Technical problems',
  general: 'General enquiries',
};

export const SUPPORT_STATUS_LABEL: Record<SupportStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  waiting_for_customer: 'Waiting for you',
  waiting_for_provider: 'Waiting for the provider',
  resolved: 'Resolved',
  closed: 'Closed',
};
/** Staff wording of the same statuses. */
export const SUPPORT_STATUS_STAFF_LABEL: Record<SupportStatus, string> = {
  ...SUPPORT_STATUS_LABEL,
  waiting_for_customer: 'Waiting for customer',
};

export const SUPPORT_PRIORITY_LABEL: Record<SupportPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

/**
 * Status transitions staff may make (docs/support.md#lifecycle). The server
 * applies them with `UPDATE … WHERE status = <from>`, and a database trigger
 * refuses any other change. `closed` is final: a new question is a new ticket.
 *
 * Automatic transitions (not chosen by staff):
 * - a customer reply on `waiting_for_customer` or `resolved` → `in_progress`;
 * - a customer closing their own ticket → `closed` (from any open status);
 * - `resolved` for SUPPORT_AUTO_CLOSE_DAYS without a reply → `closed`.
 */
export const SUPPORT_TRANSITIONS: Record<SupportStatus, readonly SupportStatus[]> = {
  open: ['in_progress', 'waiting_for_customer', 'waiting_for_provider', 'resolved', 'closed'],
  in_progress: ['waiting_for_customer', 'waiting_for_provider', 'resolved', 'closed'],
  waiting_for_customer: ['in_progress', 'waiting_for_provider', 'resolved', 'closed'],
  waiting_for_provider: ['in_progress', 'waiting_for_customer', 'resolved', 'closed'],
  resolved: ['in_progress', 'closed'],
  closed: [],
};

export const canTransition = (from: SupportStatus, to: SupportStatus) =>
  SUPPORT_TRANSITIONS[from].includes(to);

/** Statuses that still need something from support or the customer. */
export const ACTIVE_SUPPORT_STATUSES: readonly SupportStatus[] = [
  'open',
  'in_progress',
  'waiting_for_customer',
  'waiting_for_provider',
];

// ─── Targets (SLA) ───────────────────────────────────────────────────────

/**
 * Response targets in calendar hours (24/7: no business hours, no pauses),
 * per priority (docs/support.md#targets). Targets are deadlines Wayora aims
 * for, stored on each ticket when it opens (and recalculated if staff change
 * the priority); performance is measured separately from real timestamps.
 */
export const SUPPORT_TARGET_HOURS: Record<
  SupportPriority,
  { firstResponse: number; resolution: number }
> = {
  urgent: { firstResponse: 1, resolution: 8 },
  high: { firstResponse: 4, resolution: 24 },
  normal: { firstResponse: 8, resolution: 72 },
  low: { firstResponse: 24, resolution: 120 },
};

// ─── References ──────────────────────────────────────────────────────────

/** Public ticket reference: WYS-XXXX-XXXX (never a database id). */
export const supportReferenceSchema = z
  .string({ error: 'Name the ticket.' })
  .trim()
  .toUpperCase()
  .regex(/^WYS-[23456789A-HJKMNP-Z]{4}-[23456789A-HJKMNP-Z]{4}$/, 'Not a valid ticket reference.');
export const SUPPORT_REFERENCE_ALPHABET = BOOKING_REFERENCE_ALPHABET;
export const supportParamsSchema = z.object({ reference: supportReferenceSchema });

// ─── Input ───────────────────────────────────────────────────────────────

/** Printable text: no control characters except line breaks and tabs. */
const text = (min: number, max: number, what: string) =>
  z
    .string()
    .transform((v) => v.normalize('NFC').replace(/\r\n?/g, '\n').trim())
    .pipe(
      z
        .string()
        .min(min, `${what} needs at least ${min} characters.`)
        .max(max, `${what} can be at most ${max} characters.`)
        .refine(
          (v) =>
            ![...v].some((c) => {
              const n = c.charCodeAt(0);
              // Line breaks (\n) and tabs are allowed; other C0 controls and DEL are not.
              return (n < 0x20 && n !== 0x09 && n !== 0x0a) || n === 0x7f;
            }),
          'Remove control characters.',
        ),
    );
const oneLine = (min: number, max: number, what: string) =>
  text(min, max, what).refine((v) => !v.includes('\n'), `${what} must be one line.`);

/** Shared with reviews (Phase 28): normalized, printable plain text. */
export const plainText = text;
export const plainLine = oneLine;

export const SUPPORT_MESSAGE_MAX = 5000;
const clientKey = z.uuid({ error: 'Send a request key.' });

export const createSupportTicketSchema = z
  .object({
    subject: oneLine(5, 120, 'The subject'),
    category: supportCategorySchema,
    description: text(20, SUPPORT_MESSAGE_MAX, 'The description'),
    priority: customerPrioritySchema.default('normal'),
    /** One of the customer's own bookings (checked on the server). */
    bookingReference: bookingReferenceSchema.optional(),
    /** Makes a retried submission create one ticket, not two. */
    clientKey,
  })
  .strict();
export type CreateSupportTicket = z.input<typeof createSupportTicketSchema>;

export const supportMessageInputSchema = z
  .object({ body: text(1, SUPPORT_MESSAGE_MAX, 'The message'), clientKey })
  .strict();
export type SupportMessageInput = z.input<typeof supportMessageInputSchema>;

export const closeSupportTicketSchema = z
  .object({ reason: oneLine(0, 300, 'The reason').optional() })
  .strict();

export const supportListQuerySchema = z
  .object({
    view: z.enum(['active', 'closed', 'all']).default('active'),
    booking: bookingReferenceSchema.optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict();
export type SupportListQuery = z.input<typeof supportListQuerySchema>;

export const supportMessagesQuerySchema = z
  .object({
    /** Messages older than this sequence number (incremental loading). */
    before: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();

// ─── Booking context ─────────────────────────────────────────────────────

/**
 * What support may see of a linked booking, read from Wayora's own records
 * (never from the request). No travellers, contact details or payment ids.
 */
export const supportBookingContextSchema = z.object({
  reference: bookingReferenceSchema,
  category: travelCategorySlugSchema,
  title: z.string(),
  demo: z.boolean(),
  status: bookingStatusSchema,
  paymentState: bookingPaymentStateSchema,
  reservationState: reservationStateSchema.nullable(),
  refundState: refundStateSchema,
  startsOn: z.string().nullable(),
});
export type SupportBookingContext = z.infer<typeof supportBookingContextSchema>;

// ─── Customer view ───────────────────────────────────────────────────────

export const supportAuthorSchema = z.enum(['customer', 'agent', 'system']);

export const supportMessageSchema = z.object({
  id: z.uuid(),
  seq: z.number().int(),
  author: supportAuthorSchema,
  /** "You", the agent's first name, or "Wayora". Never an email. */
  authorName: z.string(),
  body: z.string(),
  createdAt: offsetDateTimeSchema,
  /** For the customer's own messages: whether support has seen it. */
  seenBySupport: z.boolean().nullable(),
  /** For support replies: whether the customer has read it. */
  readByCustomer: z.boolean().nullable(),
});
export type SupportMessage = z.infer<typeof supportMessageSchema>;

export const supportTicketSummarySchema = z.object({
  reference: supportReferenceSchema,
  subject: z.string(),
  category: supportCategorySchema,
  priority: supportPrioritySchema,
  status: supportStatusSchema,
  bookingReference: bookingReferenceSchema.nullable(),
  createdAt: offsetDateTimeSchema,
  updatedAt: offsetDateTimeSchema,
  /** Support replies the customer hasn't read yet. */
  unread: z.number().int().min(0),
});
export type SupportTicketSummary = z.infer<typeof supportTicketSummarySchema>;

export const supportTicketListSchema = z.object({
  items: z.array(supportTicketSummarySchema),
  pagination: paginationSchema,
});
export type SupportTicketList = z.infer<typeof supportTicketListSchema>;

export const supportTicketSchema = supportTicketSummarySchema.extend({
  /** The ticket's current revision (live updates compare against it). */
  revision: z.number().int(),
  booking: supportBookingContextSchema.nullable(),
  canReply: z.boolean(),
  canClose: z.boolean(),
  resolvedAt: offsetDateTimeSchema.nullable(),
  closedAt: offsetDateTimeSchema.nullable(),
  /** Customer-visible history (status changes), oldest first. */
  history: z.array(
    z.object({
      at: offsetDateTimeSchema,
      status: supportStatusSchema,
      by: z.enum(['you', 'support', 'wayora']),
    }),
  ),
});
export type SupportTicket = z.infer<typeof supportTicketSchema>;

export const supportMessagePageSchema = z.object({
  items: z.array(supportMessageSchema),
  /** Pass as `before` to load older messages; null when there are none. */
  nextBefore: z.number().int().nullable(),
});
export type SupportMessagePage = z.infer<typeof supportMessagePageSchema>;

// ─── Staff view ──────────────────────────────────────────────────────────

export const supportStaffSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  role: z.enum(['support', 'admin']),
});
export type SupportStaff = z.infer<typeof supportStaffSchema>;

export const adminSupportListQuerySchema = z
  .object({
    view: z.enum(['mine', 'unassigned', 'escalated', 'all']).default('all'),
    status: z.union([supportStatusSchema, z.literal('active')]).optional(),
    priority: supportPrioritySchema.optional(),
    category: supportCategorySchema.optional(),
    overdue: z.enum(['true']).optional(),
    /** A ticket reference, a booking reference, or (with admin.users.read) a customer email. */
    q: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((v) => ![...v].some((c) => c.charCodeAt(0) < 0x20), 'Remove control characters.')
      .optional(),
    sort: z.enum(['updated', 'created', 'due']).default('updated'),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type AdminSupportListQuery = z.input<typeof adminSupportListQuerySchema>;

const targetSchema = z.object({
  dueAt: offsetDateTimeSchema,
  /** When it was met (null: not yet). */
  metAt: offsetDateTimeSchema.nullable(),
  state: z.enum(['pending', 'met', 'missed', 'overdue']),
});

export const adminSupportTicketSummarySchema = supportTicketSummarySchema
  .omit({ unread: true })
  .extend({
    customerName: z.string(),
    assignee: supportStaffSchema.nullable(),
    escalated: z.boolean(),
    firstResponse: targetSchema,
    resolution: targetSchema,
    /** The last public message came from the customer (needs a reply). */
    awaitingReply: z.boolean(),
  });
export type AdminSupportTicketSummary = z.infer<typeof adminSupportTicketSummarySchema>;

export const adminSupportTicketListSchema = z.object({
  items: z.array(adminSupportTicketSummarySchema),
  pagination: paginationSchema,
});
export type AdminSupportTicketList = z.infer<typeof adminSupportTicketListSchema>;

export const supportEventTypeSchema = z.enum([
  'created',
  'status_changed',
  'priority_changed',
  'category_changed',
  'assigned',
  'unassigned',
  'escalated',
  'de_escalated',
  'customer_message',
  'agent_reply',
  'internal_note',
  'system_message',
]);
export type SupportEventType = z.infer<typeof supportEventTypeSchema>;

export const adminSupportEventSchema = z.object({
  seq: z.number().int(),
  type: supportEventTypeSchema,
  actor: z.object({ kind: z.enum(['customer', 'staff', 'system']), name: z.string() }),
  from: z.string().nullable(),
  to: z.string().nullable(),
  reason: z.string().nullable(),
  internal: z.boolean(),
  at: offsetDateTimeSchema,
});
export type AdminSupportEvent = z.infer<typeof adminSupportEventSchema>;

export const adminSupportMessageSchema = supportMessageSchema.omit({ seenBySupport: true }).extend({
  /** Internal notes: staff only, never in customer APIs. */
  internal: z.boolean(),
  /** Staff author (for agent replies and notes). */
  staff: supportStaffSchema.nullable(),
  /** The reply started from an AI draft that the agent reviewed. */
  aiAssisted: z.boolean(),
});
export type AdminSupportMessage = z.infer<typeof adminSupportMessageSchema>;

export const adminSupportMessagePageSchema = z.object({
  items: z.array(adminSupportMessageSchema),
  nextBefore: z.number().int().nullable(),
});
export type AdminSupportMessagePage = z.infer<typeof adminSupportMessagePageSchema>;

export const adminSupportTicketSchema = adminSupportTicketSummarySchema.extend({
  revision: z.number().int(),
  customer: z.object({ id: z.uuid(), name: z.string(), email: z.string().nullable() }),
  /** The booking as it was when the ticket was opened (the original context). */
  bookingAtOpen: supportBookingContextSchema.nullable(),
  /** The booking as it is now (owner-scoped, read from Wayora's records). */
  bookingNow: supportBookingContextSchema.nullable(),
  resolvedAt: offsetDateTimeSchema.nullable(),
  closedAt: offsetDateTimeSchema.nullable(),
  reopenCount: z.number().int(),
  history: z.array(adminSupportEventSchema),
  /** What the viewer may do now (the API checks again on every request). */
  allowed: z.object({
    reply: z.boolean(),
    note: z.boolean(),
    status: z.array(supportStatusSchema),
    assignSelf: z.boolean(),
    assignOthers: z.boolean(),
    unassign: z.boolean(),
    escalate: z.boolean(),
    deEscalate: z.boolean(),
    changePriority: z.boolean(),
    ai: z.boolean(),
  }),
});
export type AdminSupportTicket = z.infer<typeof adminSupportTicketSchema>;

export const adminSupportReplySchema = z
  .object({
    body: text(1, SUPPORT_MESSAGE_MAX, 'The reply'),
    clientKey,
    /** `internal: true` adds a private note instead of a reply. */
    internal: z.boolean().default(false),
    /** Ask the customer for more information: status → waiting_for_customer. */
    requestInfo: z.boolean().default(false),
    /** The agent started from an AI draft (recorded; the agent still wrote and sent it). */
    aiAssisted: z.boolean().default(false),
  })
  .strict()
  .refine((v) => !(v.internal && (v.requestInfo || v.aiAssisted)), {
    message: 'Internal notes can’t ask the customer anything.',
    path: ['internal'],
  });
export type AdminSupportReply = z.input<typeof adminSupportReplySchema>;

const reason = oneLine(5, 300, 'The reason');

export const adminSupportStatusSchema = z
  .object({ status: supportStatusSchema, reason: reason.optional(), revision: z.number().int() })
  .strict();
export type AdminSupportStatusChange = z.input<typeof adminSupportStatusSchema>;

export const adminSupportAssignSchema = z
  .object({ assigneeId: z.uuid().nullable(), revision: z.number().int() })
  .strict();
export type AdminSupportAssign = z.input<typeof adminSupportAssignSchema>;

export const adminSupportEscalateSchema = z
  .object({ escalate: z.boolean(), reason, revision: z.number().int() })
  .strict();
export type AdminSupportEscalate = z.input<typeof adminSupportEscalateSchema>;

export const adminSupportPrioritySchema = z
  .object({ priority: supportPrioritySchema, reason, revision: z.number().int() })
  .strict();
export type AdminSupportPriorityChange = z.input<typeof adminSupportPrioritySchema>;

// ─── Metrics ─────────────────────────────────────────────────────────────

export const supportMetricsQuerySchema = z
  .object({ range: z.enum(['24h', '7d', '30d']).default('7d') })
  .strict();

const duration = z.object({
  /** Tickets measured. */
  count: z.number().int(),
  /** Median minutes; null when nothing was measured. */
  medianMinutes: z.number().nullable(),
  /** Share of those that met their target (0–1); null when nothing was measured. */
  withinTarget: z.number().nullable(),
});

export const supportMetricsSchema = z.object({
  range: z.enum(['24h', '7d', '30d']),
  generatedAt: offsetDateTimeSchema,
  /** Right now. */
  open: z.number().int(),
  inProgress: z.number().int(),
  pending: z.number().int(),
  unassigned: z.number().int(),
  escalated: z.number().int(),
  overdue: z.number().int(),
  /** In the range. */
  created: z.number().int(),
  resolved: z.number().int(),
  firstResponse: duration,
  resolution: duration,
  byCategory: z.array(z.object({ category: supportCategorySchema, active: z.number().int() })),
  byPriority: z.array(z.object({ priority: supportPrioritySchema, active: z.number().int() })),
  workload: z.array(
    z.object({ staff: supportStaffSchema, active: z.number().int(), overdue: z.number().int() }),
  ),
});
export type SupportMetrics = z.infer<typeof supportMetricsSchema>;

// ─── AI assistance ───────────────────────────────────────────────────────

/**
 * A suggestion for staff only (docs/support.md#ai-assistance). Generated from
 * the customer-visible conversation and safe booking context, never from
 * internal notes. A draft is never sent by itself: the agent edits and sends
 * it as their own reply.
 */
export const supportAiSuggestionSchema = z.object({
  kind: z.enum(['draft', 'summary']),
  text: z.string(),
  /** "Wayora demo assistant (rule-based, not AI)" or the AI provider's label. */
  source: z.string(),
  /** Rule-based demo output, not a language model. */
  simulated: z.boolean(),
  /** Things the agent must check before using it (e.g. it mentions a refund). */
  warnings: z.array(z.string()),
  /** Help articles it drew on. */
  articles: z.array(z.object({ slug: z.string(), title: z.string() })),
});
export type SupportAiSuggestion = z.infer<typeof supportAiSuggestionSchema>;

export const supportAiRequestSchema = z.object({ kind: z.enum(['draft', 'summary']) }).strict();
