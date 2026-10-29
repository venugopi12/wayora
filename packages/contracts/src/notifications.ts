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
]);
export type NotificationCategory = z.infer<typeof notificationCategorySchema>;

export function notificationCategory(type: NotificationType): NotificationCategory {
  if (type === 'travel_reminder') return 'reminder';
  if (type === 'trip_disruption') return 'trip';
  if (type.startsWith('plan_')) return 'plan';
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
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const updateNotificationPreferencesSchema = z
  .object({
    emailBookings: z.boolean().optional(),
    emailPayments: z.boolean().optional(),
    emailReminders: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one preference.' });
export type UpdateNotificationPreferences = z.input<typeof updateNotificationPreferencesSchema>;

export const EMAIL_NOT_CONFIGURED_STATUS =
  'Email isn’t set up on this server yet, so no emails are sent. Your choices are saved and will apply once it is.';
