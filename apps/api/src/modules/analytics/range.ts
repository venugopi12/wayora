import {
  ANALYTICS_MAX_DAYS,
  analyticsQuerySchema,
  type AnalyticsGranularity,
  type AnalyticsPeriod,
  type AnalyticsQuery,
} from '@wayora/contracts';
import { AppError } from '../../utils/errors.js';

/*
 * Reporting periods (docs/analytics.md#timezone).
 *
 * A period is a run of whole calendar days in the reporting timezone. Its
 * instants are [local midnight of `from`, local midnight after `to`), worked
 * out per day, so a day that is 23 or 25 hours long (daylight saving) is still
 * exactly one day. A period that hasn't ended stops at "now". The comparison
 * period is the same number of days immediately before.
 */

const DAY_MS = 86_400_000;

/** Validates an IANA timezone name (throws for unknown ones). */
export function assertTimezone(tz: string): string {
  new Intl.DateTimeFormat('en-US', { timeZone: tz });
  return tz;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsCache.set(tz, f);
  }
  return f;
}

/** The wall-clock fields of an instant in a timezone. */
function wallClock(instant: number, tz: string) {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return { y: p.year!, m: p.month!, d: p.day!, h: p.hour!, min: p.minute!, s: p.second! };
}

/** Offset of the timezone from UTC at an instant, in ms (positive east of UTC). */
function offsetAt(instant: number, tz: string): number {
  const w = wallClock(instant, tz);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The local calendar day (YYYY-MM-DD) of an instant. */
export function localDayOf(instant: Date | number, tz: string): string {
  const w = wallClock(typeof instant === 'number' ? instant : instant.getTime(), tz);
  return `${String(w.y).padStart(4, '0')}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}

/**
 * The instant local midnight starts on `day`. Where midnight doesn't exist
 * (a timezone that skips it), the first instant of that day.
 */
export function startOfLocalDay(day: string, tz: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d);
  // Two passes settle the offset around a transition.
  let guess = naive - offsetAt(naive, tz);
  guess = naive - offsetAt(guess, tz);
  if (localDayOf(guess, tz) !== day) {
    // Midnight skipped (or landed on the previous day): step forward to the day's first minute.
    for (let t = guess; t < guess + 3 * 3600_000; t += 60_000) {
      if (localDayOf(t, tz) === day) return new Date(t);
    }
  }
  return new Date(guess);
}

/** Adds whole calendar days to a YYYY-MM-DD string. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Calendar days from `a` to `b` (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

const isRealDay = (day: string) => {
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day;
};

export interface ResolvedRange {
  timezone: string;
  period: AnalyticsPeriod;
  previous: AnalyticsPeriod;
  granularity: AnalyticsGranularity;
  /** For cache keys: the query as resolved. */
  key: string;
}

function period(from: string, to: string, tz: string, now: Date): AnalyticsPeriod {
  const start = startOfLocalDay(from, tz);
  const dayAfter = startOfLocalDay(addDays(to, 1), tz);
  const partial = dayAfter.getTime() > now.getTime();
  return {
    from,
    to,
    start: start.toISOString(),
    end: (partial ? now : dayAfter).toISOString(),
    days: daysBetween(from, to) + 1,
    partial,
  };
}

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_FAILED', 'The request is invalid.', {
    details: [{ path: `query.${path}`, message, code: 'invalid_value' }],
  });

/** Default bucket size for a period length. */
export function defaultGranularity(days: number): AnalyticsGranularity {
  if (days <= 62) return 'day';
  if (days <= 186) return 'week';
  return 'month';
}

/** Resolves a validated report query into exact periods in the reporting timezone. */
export function resolveRange(query: AnalyticsQuery, tz: string, now: Date): ResolvedRange {
  const q = analyticsQuerySchema.parse(query);
  const today = localDayOf(now, tz);
  let from: string;
  let to: string;
  switch (q.preset) {
    case 'today':
      from = to = today;
      break;
    case 'last_7_days':
      from = addDays(today, -6);
      to = today;
      break;
    case 'last_30_days':
      from = addDays(today, -29);
      to = today;
      break;
    case 'this_month':
      from = `${today.slice(0, 7)}-01`;
      to = today;
      break;
    case 'last_month': {
      const firstThis = `${today.slice(0, 7)}-01`;
      to = addDays(firstThis, -1);
      from = `${to.slice(0, 7)}-01`;
      break;
    }
    case 'custom': {
      from = q.from!;
      to = q.to!;
      if (!isRealDay(from)) throw invalid('from', 'Choose a real date.');
      if (!isRealDay(to)) throw invalid('to', 'Choose a real date.');
      if (to < from) throw invalid('to', 'The end date is before the start date.');
      if (to > today) throw invalid('to', 'The end date is in the future.');
      if (daysBetween(from, to) + 1 > ANALYTICS_MAX_DAYS)
        throw invalid('to', `Choose at most ${ANALYTICS_MAX_DAYS} days.`);
      break;
    }
  }
  const days = daysBetween(from, to) + 1;
  const granularity = q.granularity ?? defaultGranularity(days);
  const buckets = bucketStarts(from, to, granularity).length;
  if (buckets > 400) throw invalid('granularity', 'Choose a larger bucket for this range.');
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  return {
    timezone: tz,
    period: period(from, to, tz, now),
    previous: period(prevFrom, prevTo, tz, now),
    granularity,
    key: `${tz}|${from}|${to}|${granularity}`,
  };
}

/** Monday of the ISO week containing `day`. */
function weekStart(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

/** The local day each bucket starts on, covering [from, to]. Partial first/last buckets are clipped. */
export function bucketStarts(from: string, to: string, g: AnalyticsGranularity): string[] {
  const out: string[] = [];
  let cur = g === 'day' ? from : g === 'week' ? weekStart(from) : `${from.slice(0, 7)}-01`;
  while (cur <= to) {
    out.push(cur < from ? from : cur);
    if (g === 'day') cur = addDays(cur, 1);
    else if (g === 'week') cur = addDays(cur, 7);
    else {
      const [y, m] = cur.split('-').map(Number) as [number, number];
      cur = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    }
  }
  return out;
}

/** Which bucket (index into `starts`) a local day falls in. */
export function bucketIndex(starts: readonly string[], day: string): number {
  let lo = 0;
  let hi = starts.length - 1;
  if (day < starts[0]!) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= day) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "3 Nov", "Week of 3 Nov", "Nov 2026". */
export function bucketLabel(start: string, g: AnalyticsGranularity): string {
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  if (g === 'month') return `${MONTHS[m - 1]} ${y}`;
  const s = `${d} ${MONTHS[m - 1]}`;
  return g === 'week' ? `Week of ${s}` : s;
}
