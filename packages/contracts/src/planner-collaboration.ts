import { z } from 'zod';
import { emailSchema } from './auth.js';
import { isoDateSchema, offsetDateTimeSchema } from './search/common.js';
import { plannedTripIdSchema, tripAccessSchema } from './planner.js';

/*
 * Plan collaboration (Phase 19, docs/planner.md#collaboration).
 *
 * - A plan has exactly one owner (its creator) and any number of members,
 *   each an `editor` (can change the plan) or a `viewer` (can only look).
 * - People join only by accepting an invitation addressed to their own
 *   account, while signed in. There are no shareable access links: a link to
 *   an invitation is useless to anyone else.
 * - Members see each other's display names, never email addresses. The owner
 *   sees invitees' addresses masked (a•••@example.com).
 */

/** Roles a member can hold. The owner is not a member and can't be given a role. */
export const memberRoleSchema = z.enum(['editor', 'viewer'], {
  error: 'Choose editor or viewer.',
});
export type MemberRole = z.infer<typeof memberRoleSchema>;

export const INVITATION_STATUSES = [
  'pending',
  'accepted',
  'declined',
  'revoked',
  'expired',
] as const;
export const invitationStatusSchema = z.enum(INVITATION_STATUSES);
export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

export const COLLABORATION_LIMITS = {
  /** Members plus open invitations per plan (the owner not counted). */
  maxMembers: 20,
  /** How long an invitation stays open. */
  invitationDays: 14,
} as const;

export const tripMemberIdSchema = z.uuid({ error: 'Not a valid member id.' });
export const tripInvitationIdSchema = z.uuid({ error: 'Not a valid invitation id.' });

export const tripMemberParamsSchema = z.object({
  tripId: plannedTripIdSchema,
  memberId: tripMemberIdSchema,
});
export const tripInvitationParamsSchema = z.object({
  tripId: plannedTripIdSchema,
  invitationId: tripInvitationIdSchema,
});
export const invitationParamsSchema = z.object({ invitationId: tripInvitationIdSchema });

// ─── Input ───────────────────────────────────────────────────────────────

/** Invite an existing Wayora account by its email address. */
export const createTripInvitationSchema = z
  .object({ email: emailSchema, role: memberRoleSchema })
  .strict();
export type CreateTripInvitationInput = z.input<typeof createTripInvitationSchema>;

/** Change a member's role. `owner` is not a valid value: ownership can't be given away. */
export const updateTripMemberSchema = z.object({ role: memberRoleSchema }).strict();
export type UpdateTripMemberInput = z.input<typeof updateTripMemberSchema>;

export const receivedInvitationsQuerySchema = z
  .object({ status: z.enum(['pending', 'all']).default('pending') })
  .strict();

export const plannerActivityQuerySchema = z
  .object({
    /** Entries older than this revision (the previous page's `nextBefore`). */
    before: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export type PlannerActivityQuery = z.input<typeof plannerActivityQuerySchema>;

// ─── Output ──────────────────────────────────────────────────────────────

/** How a person appears to other members: a display name and initials, never an email. */
export const personSchema = z.object({
  name: z.string(),
  initials: z.string(),
  isYou: z.boolean(),
});
export type Person = z.infer<typeof personSchema>;

export const tripMemberSchema = personSchema.extend({
  id: tripMemberIdSchema,
  role: memberRoleSchema,
  joinedAt: offsetDateTimeSchema,
});
export type TripMember = z.infer<typeof tripMemberSchema>;

/** An invitation as the owner sees it. */
export const sentInvitationSchema = z.object({
  id: tripInvitationIdSchema,
  invitee: personSchema.extend({
    /** e.g. a•••@example.com — enough to tell people apart, not the address. */
    emailMasked: z.string(),
  }),
  role: memberRoleSchema,
  status: invitationStatusSchema,
  createdAt: offsetDateTimeSchema,
  expiresAt: offsetDateTimeSchema,
});
export type SentInvitation = z.infer<typeof sentInvitationSchema>;

export const tripMembersSchema = z.object({
  owner: personSchema,
  members: z.array(tripMemberSchema),
  /** Open invitations; only the owner sees them (empty for members). */
  invitations: z.array(sentInvitationSchema),
  access: tripAccessSchema,
  limits: z.object({ maxMembers: z.number().int(), used: z.number().int() }),
});
export type TripMembers = z.infer<typeof tripMembersSchema>;

/** An invitation as its recipient sees it. */
export const receivedInvitationSchema = z.object({
  id: tripInvitationIdSchema,
  trip: z.object({
    id: plannedTripIdSchema,
    title: z.string(),
    destinationName: z.string(),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
  }),
  invitedBy: z.object({ name: z.string() }).nullable(),
  role: memberRoleSchema,
  status: invitationStatusSchema,
  createdAt: offsetDateTimeSchema,
  expiresAt: offsetDateTimeSchema,
});
export type ReceivedInvitation = z.infer<typeof receivedInvitationSchema>;

export const receivedInvitationListSchema = z.object({
  items: z.array(receivedInvitationSchema),
});
export type ReceivedInvitationList = z.infer<typeof receivedInvitationListSchema>;

export const invitationResponseSchema = z.object({
  invitation: receivedInvitationSchema,
  /** Set after accepting: the plan to open. */
  tripId: plannedTripIdSchema.nullable(),
});
export type InvitationResponse = z.infer<typeof invitationResponseSchema>;

export const memberRemovedSchema = z.object({ removed: z.literal(true) });

export const PLANNER_ACTIVITY_TYPES = [
  'trip_updated',
  'item_added',
  'item_updated',
  'item_moved',
  'item_deleted',
  'item_duplicated',
  'day_reordered',
  'member_invited',
  'invitation_accepted',
  'invitation_declined',
  'invitation_revoked',
  'member_role_changed',
  'member_removed',
  'member_left',
] as const;
export const plannerActivityTypeSchema = z.enum(PLANNER_ACTIVITY_TYPES);
export type PlannerActivityType = z.infer<typeof plannerActivityTypeSchema>;

/** One change to a plan, newest first. `summary` is plain text written by Wayora. */
export const plannerActivitySchema = z.object({
  revision: z.number().int().min(1),
  type: plannerActivityTypeSchema,
  /** Who did it; null when that account no longer exists. */
  actor: personSchema.nullable(),
  summary: z.string(),
  /** The day it concerns, when there is one (for a "Show day" link). */
  day: isoDateSchema.nullable(),
  createdAt: offsetDateTimeSchema,
});
export type PlannerActivity = z.infer<typeof plannerActivitySchema>;

export const plannerActivityListSchema = z.object({
  items: z.array(plannerActivitySchema),
  /** Pass as `before` for older entries; null at the start of the history. */
  nextBefore: z.number().int().nullable(),
});
export type PlannerActivityList = z.infer<typeof plannerActivityListSchema>;
