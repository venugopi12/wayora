import type { AssistantIntent } from '@wayora/contracts';
import { PLANNER_CATALOG, type CatalogDestination } from '../planner/catalog.js';

/*
 * Deterministic helpers (docs/assistant.md#intents): what a message is
 * about, and which curated sample destination it names. Used to pick the
 * minimum context to share, by the rule-based demo provider, and to match
 * proposals to Wayora's curated catalog. No AI.
 */

/** Other names people use for the sample destinations. */
const ALIASES: Record<string, string> = {
  japan: 'kyoto',
  indonesia: 'bali',
  uae: 'dubai',
  'united arab emirates': 'dubai',
  bangalore: 'bengaluru',
  bombay: 'mumbai',
  'new delhi': 'delhi',
  rajasthan: 'jaipur',
  himachal: 'manali',
  alleppey: 'kerala',
  kochi: 'kerala',
  munnar: 'kerala',
};

const words = (text: string) => ` ${text.toLowerCase().replace(/[^a-z0-9₹$€£]+/g, ' ')} `;

/** The sample destination a text names (catalog name or a known alias), if any. */
export function findCatalogDestination(text: string): CatalogDestination | null {
  const w = words(text);
  for (const d of PLANNER_CATALOG) {
    if (w.includes(` ${d.name.toLowerCase()} `)) return d;
  }
  for (const [alias, id] of Object.entries(ALIASES)) {
    if (w.includes(` ${alias} `)) return PLANNER_CATALOG.find((d) => d.id === id) ?? null;
  }
  return null;
}

/** Exact (case-insensitive) match of a destination name or alias. */
export function matchCatalogName(name: string): CatalogDestination | null {
  const n = name.trim().toLowerCase();
  const first = n.split(',')[0]?.trim() ?? n;
  return (
    PLANNER_CATALOG.find((d) => d.name.toLowerCase() === first || d.id === first) ??
    (ALIASES[first] ? (PLANNER_CATALOG.find((d) => d.id === ALIASES[first]) ?? null) : null)
  );
}

const has = (text: string, pattern: RegExp) => pattern.test(text.toLowerCase());

/**
 * What the message is about. First match wins:
 * packing → review → cutting costs → splitting an amount → an itinerary for a named place →
 * budget → activities → destination ideas → an itinerary → general.
 */
export function classifyIntent(text: string): AssistantIntent {
  if (has(text, /\b(pack|packing|bring|luggage|suitcase|what (should|to) wear)\b/))
    return 'packing';
  if (
    has(
      text,
      /\b(hectic|rushed|less busy|too (much|many|busy)|rebalance|balance|improve|conflicts?|overlap|clash|tiring|exhausting|my itinerary|this itinerary|our itinerary)\b/,
    )
  ) {
    return 'review';
  }
  if (
    has(text, /\b(reduce|cut|lower|save|saving|trim)\b/) &&
    has(text, /\b(expense|expenses|cost|costs|spend|spending|budget|money)\b/)
  ) {
    return 'budget';
  }
  // "Split ₹20,000 for our trip", "allocate 50k": dividing an amount is a budget request.
  if (
    has(text, /\b(split|allocate|divide|break ?down)\b/) &&
    has(text, /(₹|\brs\b|\binr\b|\$|\busd\b|€|£|\d)/)
  ) {
    return 'budget';
  }
  const named = findCatalogDestination(text) !== null;
  const tripWords = /\b(itinerary|plan|trip|days?|nights?|weekend|schedule|\d+\s*-\s*day)\b/;
  if (named && has(text, tripWords)) return 'itinerary';
  if (
    has(text, /\b(budget|expense|expenses|cost|costs|spend|afford|allocate)\b/) &&
    !has(text, /\b(trip|getaway|go|destination)\b/)
  ) {
    return 'budget';
  }
  if (
    has(
      text,
      /\b(activities|activity|things to do|what to do|what can we do|attractions|family[- ]friendly|kid[- ]friendly)\b/,
    )
  ) {
    return 'activities';
  }
  if (
    has(
      text,
      /\b(where|destination|destinations|getaway|go for|suggest a|recommend a|weekend trip|trip under|places? to visit)\b/,
    )
  ) {
    return 'destinations';
  }
  if (has(text, tripWords)) return 'itinerary';
  if (has(text, /\b(budget|expense|cost|spend|₹|rs|inr|usd)\b/)) return 'budget';
  return 'general';
}
