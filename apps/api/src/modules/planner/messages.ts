import type { MemberRole } from '@wayora/contracts';
import { personName } from './people.js';

/*
 * Plain-text wording for planner notifications (docs/planner.md#notifications).
 * Written by Wayora; plan titles are the members' own text (rendered as text).
 * No email addresses.
 */

const ROLE: Record<MemberRole, string> = { editor: 'an editor', viewer: 'a viewer' };
const quote = (title: string) => `“${title}”`;

export const planMessages = {
  invitation: (inviter: string | null, title: string, role: MemberRole) => ({
    type: 'PLAN_INVITATION' as const,
    title: 'You’re invited to plan a trip',
    message: `${personName(inviter)} invited you to join the plan ${quote(title)} as ${ROLE[role]}. Open Trip planner to accept or decline.`,
  }),
  invitationAccepted: (invitee: string | null, title: string) => ({
    type: 'PLAN_INVITATION_ACCEPTED' as const,
    title: 'Invitation accepted',
    message: `${personName(invitee)} joined your plan ${quote(title)}.`,
  }),
  invitationDeclined: (invitee: string | null, title: string) => ({
    type: 'PLAN_INVITATION_DECLINED' as const,
    title: 'Invitation declined',
    message: `${personName(invitee)} declined the invitation to ${quote(title)}.`,
  }),
  roleChanged: (title: string, role: MemberRole) => ({
    type: 'PLAN_MEMBER_CHANGED' as const,
    title: 'Your access to a plan changed',
    message:
      role === 'editor'
        ? `You can now edit the plan ${quote(title)}.`
        : `You can now view, but not edit, the plan ${quote(title)}.`,
  }),
  removed: (title: string) => ({
    type: 'PLAN_MEMBER_CHANGED' as const,
    title: 'You were removed from a plan',
    message: `The owner removed you from the plan ${quote(title)}. You can no longer see it.`,
  }),
  memberLeft: (member: string | null, title: string) => ({
    type: 'PLAN_MEMBER_CHANGED' as const,
    title: 'A member left your plan',
    message: `${personName(member)} left the plan ${quote(title)}.`,
  }),
  planUpdated: (
    actor: string | null,
    title: string,
    destination: string,
    startDate: string,
    endDate: string,
  ) => ({
    type: 'PLAN_UPDATED' as const,
    title: 'Plan dates or destination changed',
    message: `${personName(actor)} changed ${quote(title)}: now ${destination}, ${startDate === endDate ? startDate : `${startDate} to ${endDate}`}.`,
  }),
};
