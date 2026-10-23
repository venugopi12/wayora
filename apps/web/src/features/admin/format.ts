import type { BadgeTone } from '@wayora/ui';
import type { AdminCheckStatus } from '@wayora/contracts';

const number = new Intl.NumberFormat('en-IN');
export const formatCount = (n: number) => number.format(n);

/** All admin times are shown in UTC, labelled, so staff in different places agree. */
const utc = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});
export const formatUtc = (iso: string) => `${utc.format(new Date(iso))} UTC`;

const day = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
export const formatDayUtc = (iso: string) => day.format(new Date(iso));

const hour = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});
export const formatBucket = (iso: string, bucket: 'hour' | 'day') =>
  bucket === 'hour' ? `${hour.format(new Date(iso))} UTC` : formatDayUtc(iso);

export const formatPercent = (rate: number) =>
  new Intl.NumberFormat('en-IN', { style: 'percent', maximumFractionDigits: 1 }).format(rate);

/** "booking_created" → "Booking created". */
export const humanize = (value: string) => {
  const text = value.replace(/[_.-]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const STATUS_TONE: Record<string, BadgeTone> = {
  confirmed: 'success',
  succeeded: 'success',
  sent: 'success',
  processed: 'success',
  active: 'success',
  pending: 'warning',
  created: 'warning',
  refund_pending: 'warning',
  received: 'warning',
  processing: 'warning',
  failed: 'danger',
  suspended: 'danger',
  deleted: 'neutral',
  cancelled: 'neutral',
  expired: 'neutral',
  refunded: 'neutral',
  not_configured: 'neutral',
  ignored: 'neutral',
};
export const statusTone = (status: string): BadgeTone => STATUS_TONE[status] ?? 'neutral';

export const CHECK: Record<AdminCheckStatus, { label: string; tone: BadgeTone }> = {
  up: { label: 'Healthy', tone: 'success' },
  degraded: { label: 'Degraded', tone: 'warning' },
  down: { label: 'Down', tone: 'danger' },
  unknown: { label: 'Unknown', tone: 'neutral' },
  'not-configured': { label: 'Not configured', tone: 'neutral' },
};

export const RANGE_LABEL = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
} as const;
