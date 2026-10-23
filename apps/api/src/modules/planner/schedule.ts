import {
  LONG_DAY_MINUTES,
  type ItineraryWarning,
  type ItineraryWarningCode,
} from '@wayora/contracts';

/*
 * Schedule checks (docs/planner.md#schedule-warnings). Pure functions over
 * the user's own data: start times and durations. They never use distances
 * or travel times (no routing source exists), never block saving, and never
 * move or remove anything — they only explain.
 *
 * Times are destination-local wall-clock minutes after midnight; days are
 * `YYYY-MM-DD` strings. No Date objects, so no time-zone conversion can
 * shift anything.
 */

export interface ScheduleItem {
  id: string;
  day: string;
  position: number;
  title: string;
  startMinute: number | null;
  durationMinutes: number | null;
}

const MINUTES_PER_DAY = 24 * 60;

/** `HH:MM` for minutes after midnight (wraps past midnight). */
export function formatMinute(minute: number): string {
  const m = ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Minutes after midnight for `HH:MM`. */
export function parseLocalTime(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const quote = (title: string) => `“${title}”`;

const span = (item: ScheduleItem) =>
  item.durationMinutes !== null && item.startMinute !== null
    ? `${formatMinute(item.startMinute)}–${formatMinute(item.startMinute + item.durationMinutes)}`
    : item.startMinute !== null
      ? `from ${formatMinute(item.startMinute)}`
      : '';

/** Whether two timed activities overlap. Without durations, only an identical start counts. */
function overlaps(a: ScheduleItem, b: ScheduleItem): boolean {
  if (a.startMinute === null || b.startMinute === null) return false;
  if (a.startMinute === b.startMinute) return true;
  const [first, second] = a.startMinute < b.startMinute ? [a, b] : [b, a];
  if (first.durationMinutes === null || first.startMinute === null) return false;
  return (second.startMinute ?? 0) < first.startMinute + first.durationMinutes;
}

/**
 * Warnings for a whole itinerary, in day order. `items` may include
 * activities outside the trip dates (after the dates were changed).
 */
export function scheduleWarnings(
  items: readonly ScheduleItem[],
  trip: { startDate: string; endDate: string },
): ItineraryWarning[] {
  const warnings: ItineraryWarning[] = [];
  const add = (code: ItineraryWarningCode, day: string, itemIds: string[], message: string) =>
    warnings.push({ code, day, itemIds, message });

  const byDay = new Map<string, ScheduleItem[]>();
  for (const item of items) {
    const list = byDay.get(item.day) ?? [];
    list.push(item);
    byDay.set(item.day, list);
  }

  for (const day of [...byDay.keys()].sort()) {
    const list = (byDay.get(day) ?? []).slice().sort((a, b) => a.position - b.position);

    if (day < trip.startDate || day > trip.endDate) {
      add(
        'outside_trip_dates',
        day,
        list.map((i) => i.id),
        list.length === 1
          ? `${quote(list[0]?.title ?? '')} is on a day outside the trip dates. Move it to a trip day or delete it.`
          : `${list.length} activities are on a day outside the trip dates. Move them to a trip day or delete them.`,
      );
      continue; // the other checks are about trip days
    }

    const timed = list.filter((i) => i.startMinute !== null);
    const untimed = list.filter((i) => i.startMinute === null);

    for (let x = 0; x < timed.length; x += 1) {
      for (let y = x + 1; y < timed.length; y += 1) {
        const a = timed[x];
        const b = timed[y];
        if (a && b && overlaps(a, b)) {
          add(
            'overlap',
            day,
            [a.id, b.id],
            a.startMinute === b.startMinute
              ? `${quote(a.title)} and ${quote(b.title)} start at the same time (${formatMinute(a.startMinute ?? 0)}).`
              : `${quote(a.title)} (${span(a)}) overlaps ${quote(b.title)} (${span(b)}).`,
          );
        }
      }
    }

    if (timed.length > 0 && untimed.length > 0) {
      add(
        'missing_start_time',
        day,
        untimed.map((i) => i.id),
        untimed.length === 1
          ? `${quote(untimed[0]?.title ?? '')} has no start time, so its place in the day can’t be checked.`
          : `${untimed.length} activities have no start time, so their place in the day can’t be checked.`,
      );
    }

    // Timed activities listed out of time order (the list order is the user's).
    const outOfOrder: string[] = [];
    let latest = -1;
    for (const item of timed) {
      const start = item.startMinute ?? 0;
      if (start < latest) outOfOrder.push(item.id);
      latest = Math.max(latest, start);
    }
    if (outOfOrder.length > 0) {
      add(
        'out_of_order',
        day,
        outOfOrder,
        'Some activities are listed out of time order. Sort the day by time, or adjust the times.',
      );
    }

    for (const item of timed) {
      if (
        item.durationMinutes !== null &&
        (item.startMinute ?? 0) + item.durationMinutes > MINUTES_PER_DAY
      ) {
        add('ends_next_day', day, [item.id], `${quote(item.title)} runs past midnight.`);
      }
    }

    const planned = list.reduce((sum, i) => sum + (i.durationMinutes ?? 0), 0);
    if (planned > LONG_DAY_MINUTES) {
      add(
        'long_day',
        day,
        list.filter((i) => i.durationMinutes !== null).map((i) => i.id),
        `Activities on this day add up to ${formatDuration(planned)}, before any travel between them.`,
      );
    }
  }
  return warnings;
}
