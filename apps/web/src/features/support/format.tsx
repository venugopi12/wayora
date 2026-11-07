import {
  SUPPORT_CATEGORY_LABEL,
  SUPPORT_PRIORITY_LABEL,
  SUPPORT_STATUS_LABEL,
  SUPPORT_STATUS_STAFF_LABEL,
  type SupportPriority,
  type SupportStatus,
} from '@wayora/contracts';
import { Badge, type BadgeTone } from '@wayora/ui';

/* Status and priority indicators (text first, colour second). */

const STATUS_TONE: Record<SupportStatus, BadgeTone> = {
  open: 'warning',
  in_progress: 'brand',
  waiting_for_customer: 'warning',
  waiting_for_provider: 'neutral',
  resolved: 'success',
  closed: 'neutral',
};
const PRIORITY_TONE: Record<SupportPriority, BadgeTone> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'warning',
  urgent: 'danger',
};

export function TicketStatusBadge({
  status,
  staff = false,
}: {
  status: SupportStatus;
  staff?: boolean;
}) {
  return (
    <Badge size="sm" tone={STATUS_TONE[status]}>
      {(staff ? SUPPORT_STATUS_STAFF_LABEL : SUPPORT_STATUS_LABEL)[status]}
    </Badge>
  );
}

export function PriorityBadge({ priority }: { priority: SupportPriority }) {
  return (
    <Badge size="sm" tone={PRIORITY_TONE[priority]}>
      {SUPPORT_PRIORITY_LABEL[priority]} priority
    </Badge>
  );
}

export const categoryLabel = (c: keyof typeof SUPPORT_CATEGORY_LABEL) => SUPPORT_CATEGORY_LABEL[c];

const moment = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});
const dayFmt = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
/** "6 Nov, 2:30 pm" in the viewer's own time zone. */
export const formatMoment = (iso: string) => moment.format(new Date(iso));
export const formatDay = (iso: string) => dayFmt.format(new Date(iso));

/** A new idempotency key per submission attempt (kept across retries of the same one). */
export const newClientKey = () => crypto.randomUUID();
