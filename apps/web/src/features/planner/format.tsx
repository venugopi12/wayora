import {
  Bus,
  Camera,
  Flower2,
  Landmark,
  MapPin,
  Moon,
  Mountain,
  ShoppingBag,
  TreePalm,
  Trees,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react';
import {
  ACTIVITY_CATEGORY_LABELS,
  type ActivityCategory,
  type CostLevel,
  type PlanningBudget,
  type PlanningGroup,
  type PlanningPace,
  type TimeOfDay,
} from '@wayora/contracts';

/*
 * Planner display helpers. Trip and itinerary dates are destination-local
 * calendar dates (`YYYY-MM-DD`); they are formatted in UTC so the browser's
 * own time zone can never move them to another day.
 */

const at = (iso: string) => new Date(`${iso}T00:00:00Z`);
const dayFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const longDayFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});
const dayMonth = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const dayMonthYear = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "Thu 12 Nov". */
export const formatDay = (iso: string) => dayFormat.format(at(iso)).replace(',', '');
/** "Thursday 12 November". */
export const formatLongDay = (iso: string) => longDayFormat.format(at(iso)).replace(',', '');

/** "12 – 14 Nov 2026", "30 Nov – 2 Dec 2026", or one date for a one-day trip. */
export function formatDateRange(start: string, end: string): string {
  if (start === end) return dayMonthYear.format(at(start));
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  const sameMonth = sameYear && start.slice(5, 7) === end.slice(5, 7);
  const first = sameMonth
    ? String(Number(start.slice(8, 10)))
    : sameYear
      ? dayMonth.format(at(start))
      : dayMonthYear.format(at(start));
  return `${first} – ${dayMonthYear.format(at(end))}`;
}

export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Today's date in the browser, as YYYY-MM-DD (for date-input minimums only). */
export function localToday(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export const CATEGORY_ICON: Record<ActivityCategory, LucideIcon> = {
  sightseeing: Camera,
  culture: Landmark,
  food: UtensilsCrossed,
  nature: Trees,
  beach: TreePalm,
  adventure: Mountain,
  shopping: ShoppingBag,
  nightlife: Moon,
  wellness: Flower2,
  transport: Bus,
  other: MapPin,
};

export const categoryLabel = (c: ActivityCategory) => ACTIVITY_CATEGORY_LABELS[c];

export const PACE_LABEL: Record<PlanningPace, string> = {
  relaxed: 'Relaxed',
  balanced: 'Balanced',
  packed: 'Packed',
};
export const PACE_HINT: Record<PlanningPace, string> = {
  relaxed: 'About 2 activities a day',
  balanced: 'About 3 activities a day',
  packed: 'About 4 activities a day',
};
export const BUDGET_LABEL: Record<PlanningBudget, string> = {
  shoestring: 'Shoestring',
  moderate: 'Moderate',
  premium: 'Premium',
};
export const GROUP_LABEL: Record<PlanningGroup, string> = {
  solo: 'Solo',
  couple: 'Couple',
  family: 'Family',
  friends: 'Friends',
};

export const COST_LABEL: Record<CostLevel, string> = {
  'free-or-low': 'Usually free or low cost',
  moderate: 'Usually a moderate cost',
  premium: 'Usually a premium cost',
};
export const BEST_TIME_LABEL: Record<TimeOfDay, string> = {
  morning: 'Often enjoyed in the morning',
  afternoon: 'Often enjoyed in the afternoon',
  evening: 'Often enjoyed in the evening',
  any: 'Fits any time of day',
};
