export { formatDateRange, formatDay, localToday } from '../planner/format';

/** Every date from start to end, inclusive (YYYY-MM-DD, no time zones involved). */
export function datesBetweenInclusive(start: string, end: string): string[] {
  const out: string[] = [];
  for (
    let t = Date.parse(`${start}T00:00:00Z`);
    t <= Date.parse(`${end}T00:00:00Z`);
    t += 86_400_000
  ) {
    out.push(new Date(t).toISOString().slice(0, 10));
    if (out.length > 60) break;
  }
  return out;
}
