import { z } from 'zod';
import { bookingReferenceSchema } from './bookings.js';
import { offsetDateTimeSchema, paginationSchema } from './search/common.js';

/*
 * Notifications (Phase 14, docs/notifications.md).
 *
 * In-app notifications are created by the server in the same transaction as
 * the booking or payment change they report, one per event. Their text is
 * written by Wayora (never provider text) and holds no traveller details.
 * Demo bookings and demo payments are always labelled as simulations.
 */

export const NOTIFICATION_TYPES = [
  'booking_created',
  'booking_confirmed',
  'booking_cancelled',
  'booking_expired',
  /** A supplier reservation failed (Phase 23; never for demo bookings). */
  'booking_failed',
  'payment_pending',
  'payment_succeeded',
  'payment_failed',
  'payment_refunded',
  'travel_reminder',
  /** A travel disruption reported, changed or resolved (Phase 17, docs/trips.md#notifications). */
  'trip_disruption',
  // Trip planner collaboration (Phase 19, docs/planner.md#notifications).
  /** You were invited to a plan. */
  'plan_invitation',
  /** Someone accepted your invitation. */
  'plan_invitation_accepted',
  /** Someone declined your invitation. */
  'plan_invitation_declined',
  /** Your role changed, you were removed, or a member left. */
  'plan_member_changed',
  /** A plan's dates or destination changed. */
  'plan_updated',
  /** Loyalty points or travel credit changed, or points are about to expire (Phase 25, docs/rewards.md#notifications). */
  'rewards',
  /** Your support ticket: received, replied to, status changed, resolved or closed (Phase 27, docs/support.md#notifications). */
  'support_ticket',
  /** Support staff: a ticket assigned to you, new in the queue, a customer reply, or an escalation (Phase 27). */
  'support_queue',
  /** Your review was published, not published, or removed (Phase 28, docs/reviews.md#notifications). */
  'review',
] as const;
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

/** For icons and preferences: what the notification is about. */
export const notificationCategorySchema = z.enum([
  'booking',
  'payment',
  'reminder',
  'trip',
  'plan',
  'rewards',
  'support',
  'reviews',
]);
export type NotificationCategory = z.infer<typeof notificationCategorySchema>;

export function notificationCategory(type: NotificationType): NotificationCategory {
  if (type === 'travel_reminder') return 'reminder';
  if (type === 'trip_disruption') return 'trip';
  if (type.startsWith('plan_')) return 'plan';
  if (type === 'rewards') return 'rewards';
  if (type.startsWith('support_')) return 'support';
  if (type === 'review') return 'reviews';
  return type.startsWith('payment_') ? 'payment' : 'booking';
}

export const notificationIdSchema = z.uuid({ error: 'Not a valid notification id.' });
export const notificationParamsSchema = z.object({ notificationId: notificationIdSchema });

/**
 * Where a notification leads: the recipient's own booking or payment, a plan
 * they belong to, or an invitation addressed to them. The server builds it
 * from the notification's own record (and drops it when the recipient no
 * longer has access); the pages check access again.
 */
export const notificationLinkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('booking'), bookingReference: bookingReferenceSchema }),
  z.object({
    kind: z.literal('payment'),
    bookingReference: bookingReferenceSchema,
    paymentId: z.uuid(),
  }),
  /** A plan the recipient can open (membership is checked again on the page). */
  z.object({ kind: z.literal('plan'), tripId: z.uuid() }),
  /** An invitation addressed to the recipient. */
  z.object({ kind: z.literal('plan-invitation'), invitationId: z.uuid() }),
  /** The recipient's own support ticket (Phase 27). */
  z.object({ kind: z.literal('support-ticket'), reference: z.string() }),
  /** A ticket in the admin support workspace, for staff who can still open it (Phase 27). */
  z.object({ kind: z.literal('admin-support-ticket'), reference: z.string() }),
  /** The recipient's own reviews (Phase 28). */
  z.object({ kind: z.literal('my-reviews') }),
]);
export type NotificationLink = z.infer<typeof notificationLinkSchema>;

export const notificationSchema = z.object({
  id: notificationIdSchema,
  type: notificationTypeSchema,
  category: notificationCategorySchema,
  /** Plain text: render as text, never as HTML. */
  title: z.string(),
  message: z.string(),
  /** About a demo booking or demo payment (a simulation). */
  demo: z.boolean(),
  read: z.boolean(),
  readAt: offsetDateTimeSchema.nullable(),
  createdAt: offsetDateTimeSchema,
  link: notificationLinkSchema.nullable(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const notificationListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
    unread: z.enum(['true', 'false']).optional(),
  })
  .strict();
export type NotificationListQuery = z.input<typeof notificationListQuerySchema>;

export const notificationListResponseSchema = z.object({
  items: z.array(notificationSchema),
  pagination: paginationSchema,
  unreadCount: z.number().int().min(0),
});
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;

export const unreadCountResponseSchema = z.object({ unread: z.number().int().min(0) });
export type UnreadCountResponse = z.infer<typeof unreadCountResponseSchema>;

export const markAllReadResponseSchema = z.object({
  updated: z.number().int().min(0),
  unread: z.number().int().min(0),
});
export type MarkAllReadResponse = z.infer<typeof markAllReadResponseSchema>;

/**
 * Optional-channel preferences. In-app notifications are always kept; these
 * only decide whether an email is queued. `email.active` says whether email
 * delivery is actually configured on this server (today: never).
 */
export const notificationPreferencesSchema = z.object({
  emailBookings: z.boolean(),
  emailPayments: z.boolean(),
  emailReminders: z.boolean(),
  email: z.object({
    active: z.boolean(),
    /** Plain-words status, e.g. that no email provider is configured. */
    status: z.string(),
  }),
  /** Browser push (Phase 30): which topics reach devices where push is turned on. */
  pushBookings: z.boolean(),
  pushPayments: z.boolean(),
  pushReminders: z.boolean(),
  pushSupport: z.boolean(),
  pushRewards: z.boolean(),
  push: z.object({
    /** Whether this server can send push notifications (Web Push keys configured). */
    active: z.boolean(),
    status: z.string(),
    /** The VAPID public key browsers subscribe with; null when push isn't set up. */
    publicKey: z.string().nullable(),
  }),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const updateNotificationPreferencesSchema = z
  .object({
    emailBookings: z.boolean().optional(),
    emailPayments: z.boolean().optional(),
    emailReminders: z.boolean().optional(),
    pushBookings: z.boolean().optional(),
    pushPayments: z.boolean().optional(),
    pushReminders: z.boolean().optional(),
    pushSupport: z.boolean().optional(),
    pushRewards: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one preference.' });
export type UpdateNotificationPreferences = z.input<typeof updateNotificationPreferencesSchema>;

export const EMAIL_NOT_CONFIGURED_STATUS =
  'Email isn’t set up on this server yet, so no emails are sent. Your choices are saved and will apply once it is.';

// ─── Browser push subscriptions (Phase 30, docs/pwa.md#push) ────────────

export const PUSH_NOT_CONFIGURED_STATUS =
  'Push notifications aren’t set up on this server yet, so none are sent. In-app notifications work as usual.';

const base64url = (max: number) =>
  z
    .string()
    .min(8)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+={0,2}$/, 'Not a valid key.');

/** What `PushSubscription.toJSON()` gives, as sent by the browser. */
export const pushSubscriptionInputSchema = z
  .object({
    endpoint: z
      .string()
      .max(2048)
      .url()
      .refine((u) => u.startsWith('https://'), 'The push endpoint must use https.'),
    expirationTime: z.number().int().nonnegative().nullable().optional(),
    keys: z.object({ p256dh: base64url(200), auth: base64url(64) }).strict(),
  })
  .strict();
export type PushSubscriptionInput = z.input<typeof pushSubscriptionInputSchema>;

export const pushUnsubscribeSchema = z.object({ endpoint: z.string().max(2048).url() }).strict();
export type PushUnsubscribe = z.input<typeof pushUnsubscribeSchema>;

export const pushSubscriptionResultSchema = z.object({
  subscribed: z.boolean(),
});
export type PushSubscriptionResult = z.infer<typeof pushSubscriptionResultSchema>;

/** A VAPID public key: an uncompressed P-256 point, base64url (65 bytes → 87 characters). */
export const VAPID_PUBLIC_KEY_PATTERN = /^B[A-Za-z0-9_-]{86}$/;
