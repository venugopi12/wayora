import type { TripAccess, TripRole } from '@wayora/contracts';

/* How people and access appear in planner responses (docs/planner.md#collaboration). */

export function accessFor(role: TripRole): TripAccess {
  return { role, canEdit: role !== 'viewer', canManage: role === 'owner' };
}

/** Display name shown to other members (never an email). */
export const personName = (displayName: string | null | undefined) =>
  displayName?.trim() || 'A Wayora traveller';

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length >= 2 ? `${parts[0]![0]}${parts.at(-1)![0]}` : (parts[0]?.slice(0, 2) ?? '?');
  return letters.toUpperCase();
}

/** a•••@example.com */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
}
