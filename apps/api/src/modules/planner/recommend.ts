import {
  ACTIVITY_CATEGORY_LABELS,
  type ActivitySuggestion,
  type ActivityCategory,
  type PlannerInterest,
  type PlannerPreferences,
  type PlanningGroup,
  type PlanningPace,
  type SuggestionsResponse,
} from '@wayora/contracts';
import type { CatalogActivity, CatalogDestination } from './catalog.js';

/*
 * Rule-based suggestions (docs/planner.md#recommendations). Deterministic:
 * the same trip always gets the same list, in the same order. No AI, no
 * history, no other users' data — only this trip's destination, length,
 * preferences and current itinerary, applied to the curated sample catalog.
 *
 * Rules, in order:
 * 1. Never suggest what is already planned: the same suggestion id, or an
 *    activity with the same title (case-insensitive).
 * 2. Leave out activities that don't suit the chosen group (e.g. nightlife
 *    for a family trip, as tagged in the catalog).
 * 3. Score: interest match +3; budget fit +2 / +1, budget clash −2 / −1;
 *    group fit +1; pace fit +1, pace clash −1; a category not yet in the
 *    itinerary +1. Ties keep catalog order.
 * 4. Every rule that added points becomes a reason shown to the user.
 */

const GROUP_LABEL: Record<PlanningGroup, string> = {
  solo: 'solo',
  couple: 'couples’',
  family: 'family',
  friends: 'group',
};

/** Activities per day each pace suggests (default: balanced). */
export const PER_DAY: Record<PlanningPace, number> = { relaxed: 2, balanced: 3, packed: 4 };

export interface PlannedSummary {
  suggestionIds: ReadonlySet<string>;
  titles: ReadonlySet<string>;
  categories: ReadonlySet<ActivityCategory>;
  count: number;
}

function score(
  activity: CatalogActivity,
  prefs: PlannerPreferences,
  planned: PlannedSummary,
): { points: number; reasons: string[] } {
  let points = 0;
  const reasons: string[] = [];
  const label = ACTIVITY_CATEGORY_LABELS[activity.category];

  if ((prefs.interests as readonly ActivityCategory[]).includes(activity.category)) {
    points += 3;
    reasons.push(`Matches your interest in ${label.toLowerCase()}`);
  }

  if (prefs.budget === 'shoestring') {
    if (activity.costLevel === 'free-or-low') {
      points += 2;
      reasons.push('Usually free or low cost — fits a shoestring budget');
    } else if (activity.costLevel === 'premium') points -= 2;
  } else if (prefs.budget === 'moderate') {
    if (activity.costLevel === 'premium') points -= 1;
  } else if (prefs.budget === 'premium' && activity.costLevel === 'premium') {
    points += 1;
    reasons.push('A premium experience, in line with your budget');
  }

  if (prefs.group && activity.groups.includes(prefs.group)) {
    points += 1;
    reasons.push(`Suits ${GROUP_LABEL[prefs.group]} trips`);
  }

  if (prefs.pace === 'relaxed') {
    if (activity.intensity === 'easy') {
      points += 1;
      reasons.push('Easy-going — suits a relaxed pace');
    } else points -= 1;
  } else if (prefs.pace === 'packed' && activity.intensity === 'active') {
    points += 1;
    reasons.push('An active pick for a packed schedule');
  }

  if (planned.count > 0 && !planned.categories.has(activity.category)) {
    points += 1;
    reasons.push(`Adds variety: no ${label.toLowerCase()} planned yet`);
  }

  return { points, reasons };
}

export function suggest(input: {
  destination: CatalogDestination | null;
  dayCount: number;
  preferences: PlannerPreferences;
  planned: PlannedSummary;
  category?: PlannerInterest | undefined;
}): SuggestionsResponse {
  const { destination, preferences, planned } = input;
  const perDay = PER_DAY[preferences.pace ?? 'balanced'];
  const capacity = { days: input.dayCount, perDay, planned: planned.count };
  if (!destination) {
    return {
      available: false,
      source: 'curated-sample',
      method: 'rules',
      capacity,
      suggestions: [],
    };
  }

  const ranked = destination.activities
    .map((activity, index) => ({ activity, index, ...score(activity, preferences, planned) }))
    .filter(({ activity }) => !planned.suggestionIds.has(activity.id))
    .filter(({ activity }) => !planned.titles.has(activity.title.toLowerCase()))
    .filter(({ activity }) => !preferences.group || activity.groups.includes(preferences.group))
    .filter(({ activity }) => !input.category || activity.category === input.category)
    .sort((a, b) => b.points - a.points || a.index - b.index);

  const suggestions: ActivitySuggestion[] = ranked.map(({ activity, reasons }) => ({
    id: activity.id,
    title: activity.title,
    category: activity.category,
    area: activity.area,
    summary: activity.summary,
    typicalMinutes: activity.typicalMinutes,
    costLevel: activity.costLevel,
    bestTime: activity.bestTime,
    reasons: reasons.length > 0 ? reasons : [`A sample highlight of ${destination.name}`],
  }));
  return { available: true, source: 'curated-sample', method: 'rules', capacity, suggestions };
}
