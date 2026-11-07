import {
  ACTIVE_SUPPORT_STATUSES,
  SUPPORT_TARGET_HOURS,
  SUPPORT_TRANSITIONS,
  hasPermission,
  type SupportPriority,
  type SupportStatus,
  type UserRole,
} from '@wayora/contracts';

/*
 * Pure support rules (docs/support.md#permissions, #targets): who may do
 * what to a ticket, response-target deadlines and the metric arithmetic.
 * The service applies these on every request; nothing here trusts a client.
 */

export interface Viewer {
  id: string;
  role: UserRole;
}

export interface TicketState {
  status: SupportStatus;
  escalated: boolean;
  assigneeId: string | null;
}

export interface Allowed {
  reply: boolean;
  note: boolean;
  status: SupportStatus[];
  assignSelf: boolean;
  assignOthers: boolean;
  unassign: boolean;
  escalate: boolean;
  deEscalate: boolean;
  changePriority: boolean;
  ai: boolean;
}

const can = (v: Viewer, p: Parameters<typeof hasPermission>[1]) => hasPermission(v.role, p);

/**
 * - `admin.support.manage` (support, admin): reply, notes, status, take or
 *   release their own assignment, escalate, change priority.
 * - `admin.support.supervise` (admin): assign anyone, release anyone, and
 *   work escalated tickets (reply, status, priority, de-escalate).
 * - Escalated tickets: support staff keep reading and adding notes, but
 *   replies and changes are for administrators.
 * - Closed tickets: read-only for everyone.
 */
export function allowedFor(viewer: Viewer, t: TicketState): Allowed {
  const manage = can(viewer, 'admin.support.manage');
  const supervise = can(viewer, 'admin.support.supervise');
  const closed = t.status === 'closed';
  const works = manage && !closed && (!t.escalated || supervise);
  return {
    reply: works,
    note: manage && !closed,
    status: works ? [...SUPPORT_TRANSITIONS[t.status]] : [],
    assignSelf: works && t.assigneeId !== viewer.id,
    assignOthers: supervise && !closed,
    unassign:
      !closed && t.assigneeId !== null && (supervise || (manage && t.assigneeId === viewer.id)),
    escalate: manage && !closed && !t.escalated,
    deEscalate: supervise && !closed && t.escalated,
    changePriority: works,
    ai: manage && !closed,
  };
}

/** Whether `assignee` (role) may hold this ticket. */
export const assignableRole = (role: UserRole, escalated: boolean) =>
  escalated ? role === 'admin' : role === 'support' || role === 'admin';

// ─── Targets ─────────────────────────────────────────────────────────────

const HOUR = 3600_000;

/** Calendar-hour deadlines from when the ticket opened (24/7, no pauses). */
export function targetsFor(priority: SupportPriority, openedAt: Date) {
  const t = SUPPORT_TARGET_HOURS[priority];
  return {
    firstResponseDueAt: new Date(openedAt.getTime() + t.firstResponse * HOUR),
    resolutionDueAt: new Date(openedAt.getTime() + t.resolution * HOUR),
  };
}

export type TargetState = 'pending' | 'met' | 'missed' | 'overdue';

/**
 * - met / missed: it happened, before / after the deadline;
 * - pending / overdue: not yet, deadline ahead / passed. A ticket closed
 *   without it happening (e.g. the customer closed it) is `missed` only if the
 *   deadline had passed by then, else it no longer applies and counts as `met`
 *   for neither: it is reported `pending` and excluded from performance.
 */
export function targetState(
  dueAt: Date,
  metAt: Date | null,
  now: Date,
  closedAt: Date | null = null,
): TargetState {
  if (metAt) return metAt.getTime() <= dueAt.getTime() ? 'met' : 'missed';
  const end = closedAt ?? now;
  if (end.getTime() > dueAt.getTime()) return closedAt ? 'missed' : 'overdue';
  return 'pending';
}

export const isActive = (status: SupportStatus) => ACTIVE_SUPPORT_STATUSES.includes(status);

/** Median of minute durations (rounded to 0.1), or null. */
export function medianMinutes(durationsMs: number[]): number | null {
  if (durationsMs.length === 0) return null;
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const ms = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.round(ms / 6000) / 10;
}

/** Share (0–1, 3 decimals) of `values` that are true, or null. */
export function share(values: boolean[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.filter(Boolean).length / values.length) * 1000) / 1000;
}

// ─── AI output checks ────────────────────────────────────────────────────

/**
 * Wording an agent must check before using an AI suggestion: the assistant
 * may not promise refunds, compensation, cancellations or changes, and must
 * never ask for secrets. These are warnings shown with the draft; the agent
 * decides (and the draft is never sent by itself).
 */
const CHECKS: [RegExp, string][] = [
  [
    /\brefund/i,
    'Mentions a refund. Refunds follow Wayora’s rules; support can’t promise or issue one.',
  ],
  [
    /\bcompensat|\bgoodwill|\bvoucher|\bfree\b/i,
    'Mentions compensation. Only an administrator can issue travel credit, and the draft can’t promise it.',
  ],
  [
    /\bcancel(l?ed|l?ing)?\b/i,
    'Mentions cancelling. Support doesn’t cancel bookings; the customer cancels from My trips.',
  ],
  [
    /\b(guarantee|promise|will be (processed|credited|refunded))/i,
    'Makes a promise. Check it’s something Wayora actually does.',
  ],
  [
    /\b(password|card number|cvv|otp|pin)\b/i,
    'Mentions passwords or card details. Never ask a customer for these.',
  ],
];
export function suggestionWarnings(text: string): string[] {
  return CHECKS.filter(([re]) => re.test(text)).map(([, w]) => w);
}
