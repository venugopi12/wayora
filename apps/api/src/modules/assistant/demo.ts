import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_CATEGORY_LABELS,
  EXPENSE_CATEGORY_LABELS,
  minorToInput,
  type ActivityCategory,
  type AssistantModelBlock,
  type AssistantTripContext,
  type BudgetCurrency,
  type ExpenseCategory,
  type PlanningGroup,
  type PlanningPace,
} from '@wayora/contracts';
import {
  PLANNER_CATALOG,
  type CatalogActivity,
  type CatalogDestination,
} from '../planner/catalog.js';
import { PER_DAY } from '../planner/recommend.js';
import { findCatalogDestination, matchCatalogName } from './intent.js';
import type { AssistantGeneration, AssistantOutput, AssistantProvider } from './provider.js';

/*
 * The demo assistant (docs/assistant.md#demo-provider): deterministic rules
 * over Wayora's curated sample catalog and the plan context. NOT AI — it is
 * labelled "rule-based, not AI" wherever its answers appear. It makes no
 * network calls, needs no credentials, and the same request always gets the
 * same answer, so development and tests never depend on a live model.
 *
 * It answers in the same JSON shape a model must produce, so its output goes
 * through the same validation (parse.ts) and enrichment as a model's.
 * It only knows the twelve sample destinations; it never states prices,
 * opening hours, availability or travel times, and its budget figures are
 * either the user's own numbers split by fixed shares or the plan's own
 * recorded totals.
 */

const TIME_ORDER = { morning: 0, afternoon: 1, evening: 2, any: 3 } as const;
const HOT = new Set(['goa', 'bali', 'kerala', 'dubai', 'singapore', 'mumbai', 'hyderabad']);
const COLD = new Set(['manali']);

const lower = (s: string) => s.toLowerCase();

function wantedPace(text: string, fallback: PlanningPace | null): PlanningPace {
  const t = lower(text);
  if (/\b(relax|relaxed|relaxing|slow|easy|chill|laid[- ]back|less hectic)\b/.test(t))
    return 'relaxed';
  if (/\b(packed|busy|action[- ]packed|full|see everything)\b/.test(t)) return 'packed';
  return fallback ?? 'balanced';
}

function wantedGroup(text: string, fallback: string | null): PlanningGroup | null {
  const t = lower(text);
  if (/\b(family|families|kids?|children|child)\b/.test(t)) return 'family';
  if (/\b(couple|honeymoon|partner|romantic|anniversary)\b/.test(t)) return 'couple';
  if (/\b(friends|group|gang|bachelor)\b/.test(t)) return 'friends';
  if (/\b(solo|alone|by myself)\b/.test(t)) return 'solo';
  return fallback === 'solo' ||
    fallback === 'couple' ||
    fallback === 'family' ||
    fallback === 'friends'
    ? fallback
    : null;
}

function wantedInterests(text: string, fallback: readonly ActivityCategory[]): ActivityCategory[] {
  const t = lower(text);
  const found = ACTIVITY_CATEGORIES.filter(
    (c) => c !== 'transport' && c !== 'other' && new RegExp(`\\b${c}`).test(t),
  );
  if (/\b(beaches)\b/.test(t) && !found.includes('beach')) found.push('beach');
  if (
    /\b(hiking|trek|trekking|outdoors|mountains?|hills?|wildlife)\b/.test(t) &&
    !found.includes('nature')
  ) {
    found.push('nature');
  }
  if (/\b(history|heritage|temples?|museums?)\b/.test(t) && !found.includes('culture'))
    found.push('culture');
  if (/\b(spa|yoga)\b/.test(t) && !found.includes('wellness')) found.push('wellness');
  return found.length > 0 ? found : [...fallback];
}

/** "4-day", "5 days", "3 nights", "weekend". */
export function wantedDays(text: string): number | null {
  const t = lower(text);
  const m = /\b(\d{1,2})\s*-?\s*(day|days|night|nights)\b/.exec(t);
  if (m) {
    const n = Number(m[1]);
    const days = /night/.test(m[2] ?? '') ? n + 1 : n;
    return Math.min(Math.max(days, 1), 30);
  }
  if (/\b(long weekend)\b/.test(t)) return 3;
  if (/\bweekend\b/.test(t)) return 2;
  if (/\b(a|one) week\b/.test(t)) return 7;
  return null;
}

const CURRENCY_MARKERS: [RegExp, BudgetCurrency][] = [
  [/₹|\brs\.?|\binr\b|rupees?/, 'INR'],
  [/\$|\busd\b|dollars?/, 'USD'],
  [/€|\beur\b|euros?/, 'EUR'],
  [/£|\bgbp\b|pounds?/, 'GBP'],
  [/\baed\b|dirhams?/, 'AED'],
  [/\bsgd\b/, 'SGD'],
];

/**
 * A money amount the user typed, in whole currency units, by string and
 * integer arithmetic (no floating point): "₹15,000", "15k", "1.5 lakh".
 * Needs a currency marker, a k/lakh suffix or words like "under"/"budget".
 */
export function statedAmount(
  text: string,
): { amount: number; currency: BudgetCurrency | null } | null {
  const t = lower(text);
  const re =
    /(₹|rs\.?|inr|\$|usd|€|eur|£|gbp|aed|sgd)?\s*(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d{1,2}))?\s*(k|thousand|lakhs?|l)?\b/g;
  for (const m of t.matchAll(re)) {
    const symbol = m[1];
    const suffix = m[4];
    const before = t.slice(Math.max(0, (m.index ?? 0) - 20), m.index ?? 0);
    const after = t.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 12);
    if (/^\s*-?\s*(day|days|night|nights|people|persons?|adults?|kids?)\b/.test(after)) continue;
    if (
      !symbol &&
      !suffix &&
      !/(under|budget|around|within|max|up ?to|about|of)\s*$/.test(before)
    ) {
      continue;
    }
    const whole = BigInt((m[2] ?? '0').replace(/,/g, ''));
    const fraction = m[3] ?? '';
    const scale = suffix === 'k' || suffix === 'thousand' ? 1000n : suffix ? 100_000n : 1n;
    const denominator = 10n ** BigInt(fraction.length);
    const amount = ((whole * denominator + BigInt(fraction || '0')) * scale) / denominator;
    if (amount < 1n || amount > 10_000_000_000n) continue;
    const currency = symbol
      ? (CURRENCY_MARKERS.find(([marker]) => marker.test(symbol))?.[1] ?? null)
      : (CURRENCY_MARKERS.find(([marker]) => marker.test(t))?.[1] ?? null);
    return { amount: Number(amount), currency };
  }
  return null;
}

/** "INR 4,500.00": the plan's own figures, formatted without floating point. */
function figure(minor: string, currency: BudgetCurrency): string {
  const [whole = '0', fraction] = minorToInput(minor, currency).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency} ${grouped}${fraction ? `.${fraction}` : ''}`;
}

function rankActivities(
  destination: CatalogDestination,
  options: {
    group: PlanningGroup | null;
    pace: PlanningPace;
    interests: readonly ActivityCategory[];
    exclude: ReadonlySet<string>;
  },
): CatalogActivity[] {
  return destination.activities
    .map((activity, index) => {
      let points = 0;
      if (options.interests.includes(activity.category)) points += 3;
      if (options.pace === 'relaxed' && activity.intensity === 'easy') points += 1;
      if (options.pace === 'packed' && activity.intensity === 'active') points += 1;
      return { activity, index, points };
    })
    .filter(({ activity }) => !options.exclude.has(activity.title.toLowerCase()))
    .filter(({ activity }) => !options.group || activity.groups.includes(options.group))
    .sort((a, b) => b.points - a.points || a.index - b.index)
    .map(({ activity }) => activity);
}

function reasonFor(
  activity: CatalogActivity,
  group: PlanningGroup | null,
  pace: PlanningPace,
): string {
  const parts = [activity.summary];
  if (group === 'family') parts.push('Suits family trips.');
  if (pace === 'relaxed' && activity.intensity === 'easy') parts.push('Easy-going.');
  if (activity.costLevel === 'free-or-low') parts.push('Usually free or low cost.');
  return parts.join(' ');
}

function topCategories(destination: CatalogDestination): ActivityCategory[] {
  const counts = new Map<ActivityCategory, number>();
  for (const a of destination.activities) counts.set(a.category, (counts.get(a.category) ?? 0) + 1);
  return [...counts.entries()]
    .sort(
      (a, b) =>
        b[1] - a[1] || ACTIVITY_CATEGORIES.indexOf(a[0]) - ACTIVITY_CATEGORIES.indexOf(b[0]),
    )
    .slice(0, 3)
    .map(([c]) => c);
}

const listWords = (items: readonly string[]) =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

const SAMPLE_NAMES = PLANNER_CATALOG.map((d) => d.name);

export class DemoAssistantProvider implements AssistantProvider {
  readonly id = 'demo';
  readonly label = 'Wayora demo assistant (rule-based, not AI)';
  readonly simulated = true;
  readonly model = null;

  generate(input: AssistantGeneration): Promise<AssistantOutput> {
    const blocks = this.answer(input);
    return Promise.resolve({
      output: JSON.stringify({ blocks }),
      usage: { inputTokens: null, outputTokens: null },
    });
  }

  private destinationFor(input: AssistantGeneration): CatalogDestination | null {
    return (
      findCatalogDestination(input.message) ??
      (input.context ? matchCatalogName(input.context.trip.destination) : null)
    );
  }

  answer(input: AssistantGeneration): AssistantModelBlock[] {
    switch (input.intent) {
      case 'itinerary':
        return this.itinerary(input);
      case 'activities':
        return this.activities(input);
      case 'destinations':
        return this.destinations(input);
      case 'budget':
        return this.budget(input);
      case 'packing':
        return this.packing(input);
      case 'review':
        return this.review(input);
      default:
        return this.general(input);
    }
  }

  private onlySamples(): AssistantModelBlock[] {
    return [
      {
        type: 'text',
        text: `The demo assistant only knows Wayora's sample destinations: ${listWords(SAMPLE_NAMES)}. Which one would you like? For example: “Plan 3 relaxed days in Kerala”.`,
      },
    ];
  }

  private itinerary(input: AssistantGeneration): AssistantModelBlock[] {
    const destination = this.destinationFor(input);
    if (!destination) return this.onlySamples();
    const ctx = input.context;
    const asked = wantedDays(input.message);
    let dayCount = asked ?? ctx?.trip.dayCount ?? 3;
    const notes: string[] = [];
    if (ctx && dayCount > ctx.trip.dayCount) {
      notes.push(`Your plan has ${ctx.trip.dayCount} days, so I kept to those.`);
      dayCount = ctx.trip.dayCount;
    }
    const pace = wantedPace(input.message, ctx?.trip.pace ?? null);
    const group = wantedGroup(input.message, ctx?.group ?? null);
    const pool = rankActivities(destination, {
      group,
      pace,
      interests: wantedInterests(input.message, ctx?.interests ?? []),
      exclude: new Set((ctx?.activities ?? []).map((a) => a.title.toLowerCase())),
    });
    const perDay = PER_DAY[pace];
    const days = Array.from({ length: dayCount }, (_, i) => {
      const picks = pool
        .slice(i * perDay, i * perDay + perDay)
        .sort((a, b) => TIME_ORDER[a.bestTime] - TIME_ORDER[b.bestTime]);
      const areas = [...new Set(picks.map((p) => p.area))];
      return {
        dayNumber: i + 1,
        theme: picks.length > 0 ? listWords(areas) : 'Open day: rest, or add your own plans',
        activities: picks.map((p) => ({
          title: p.title,
          category: p.category,
          startTime: null,
          durationMinutes: p.typicalMinutes,
          area: p.area,
          note: p.summary,
        })),
      };
    });
    const amount = statedAmount(input.message);
    const who = group ? ` for a ${group === 'friends' ? 'group of friends' : group} trip` : '';
    return [
      {
        type: 'text',
        text: [
          `Here's a ${pace} ${dayCount}-day plan for ${destination.name}${who}, from Wayora's curated sample activities (${perDay} a day at most).`,
          'Durations are planning estimates and no times are set: check opening hours and travel times before you go.',
          ...notes,
        ].join(' '),
      },
      {
        type: 'itinerary',
        title: `${dayCount} ${pace} days in ${destination.name}`,
        destination: destination.name,
        dayCount,
        pace,
        days,
        budgetNote: amount
          ? 'You mentioned a budget: ask “Split my budget” for a suggested allocation.'
          : null,
      },
    ];
  }

  private activities(input: AssistantGeneration): AssistantModelBlock[] {
    const destination = this.destinationFor(input);
    if (!destination) return this.onlySamples();
    const ctx = input.context;
    const pace = wantedPace(input.message, ctx?.trip.pace ?? null);
    const group = wantedGroup(input.message, ctx?.group ?? null);
    const picks = rankActivities(destination, {
      group,
      pace,
      interests: wantedInterests(input.message, ctx?.interests ?? []),
      exclude: new Set((ctx?.activities ?? []).map((a) => a.title.toLowerCase())),
    }).slice(0, 6);
    if (picks.length === 0) {
      return [
        {
          type: 'text',
          text: `Your plan already has every sample activity for ${destination.name} that suits this group.`,
        },
      ];
    }
    return [
      {
        type: 'text',
        text: `Some ideas in ${destination.name}${group ? ` that suit ${group === 'friends' ? 'groups of friends' : `${group} trips`}` : ''}, from Wayora's curated samples:`,
      },
      {
        type: 'activities',
        items: picks.map((p) => ({
          title: p.title,
          category: p.category,
          reason: reasonFor(p, group, pace),
          durationMinutes: p.typicalMinutes,
          area: p.area,
        })),
      },
    ];
  }

  private destinations(input: AssistantGeneration): AssistantModelBlock[] {
    const interests = wantedInterests(input.message, input.context?.interests ?? []);
    const amount = statedAmount(input.message);
    const days = wantedDays(input.message);
    const nearby = amount !== null && (amount.currency ?? 'INR') === 'INR';
    const ranked = PLANNER_CATALOG.map((d, index) => {
      let points = 0;
      for (const i of interests) points += d.activities.filter((a) => a.category === i).length;
      if (nearby && d.country === 'India') points += 2;
      return { d, index, points };
    })
      .sort((a, b) => b.points - a.points || a.index - b.index)
      .slice(0, 4);
    const text = [
      interests.length > 0
        ? `Places from Wayora's sample destinations with plenty of ${listWords(interests.map((c) => ACTIVITY_CATEGORY_LABELS[c].toLowerCase()))}:`
        : "A few of Wayora's sample destinations to start from:",
      nearby
        ? `For a budget in rupees${days ? ` over ${days} days` : ''}, destinations within India come first: they usually keep travel costs down. I can't check fares or prices, so compare them before deciding.`
        : '',
    ]
      .filter(Boolean)
      .join(' ');
    return [
      { type: 'text', text },
      {
        type: 'destinations',
        items: ranked.map(({ d }) => {
          const top = topCategories(d);
          return {
            name: d.name,
            country: d.country,
            reason: `Known for ${listWords(top.map((c) => ACTIVITY_CATEGORY_LABELS[c].toLowerCase()))}. Sample activities include ${listWords(d.activities.slice(0, 2).map((a) => a.title))}.${nearby && d.country === 'India' ? ' Within India.' : ''}`,
            bestFor: top,
          };
        }),
      },
    ];
  }

  private budget(input: AssistantGeneration): AssistantModelBlock[] {
    const ctx = input.context;
    const t = lower(input.message);
    const reducing = /\b(reduce|cut|lower|save|saving|trim)\b/.test(t);
    const blocks: AssistantModelBlock[] = [];
    const facts = ctx?.budget;
    if (reducing) {
      const top = facts?.topCategories.slice(0, 2) ?? [];
      const tips = [
        'Share rooms or book a place with a kitchen for the group: stays are usually the largest cost.',
        'Use local transport or shared cabs for short hops instead of separate taxis.',
        'Plan one or two free or low-cost activities a day (walks, beaches, markets).',
        'Agree a daily food budget and record shared meals as you go, so nobody is surprised at the end.',
      ];
      blocks.push({
        type: 'text',
        text:
          top.length > 0
            ? `From your plan's recorded and planned expenses, the biggest costs are ${listWords(top.map((c) => `${EXPENSE_CATEGORY_LABELS[c.category]} (${figure((BigInt(c.recordedMinor) + BigInt(c.plannedMinor)).toString(), c.currency)})`))}. These are your own figures; the ideas below are general suggestions.`
            : 'Your plan has no expenses yet, so here are general ideas. Add expenses on the budget page and ask again for ideas based on them.',
      });
      blocks.push({ type: 'text', text: tips.map((tip) => `• ${tip}`).join('\n') });
      return blocks;
    }
    const stated = statedAmount(input.message);
    const currency: BudgetCurrency =
      stated?.currency ?? facts?.currency ?? facts?.totals[0]?.currency ?? 'INR';
    let amount = stated?.amount ?? null;
    if (amount === null && facts?.totalMinor && facts.currency) {
      amount = Number(BigInt(facts.totalMinor) / 100n);
    }
    if (amount === null || amount < 100) {
      return [
        {
          type: 'text',
          text: 'What total would you like to plan with, and in which currency? For example: “Split ₹20,000 for 3 days in Goa”.',
        },
      ];
    }
    const flying = /\b(fly|flight|flights|plane)\b/.test(t);
    const shares: [ExpenseCategory, bigint][] = flying
      ? [
          ['flights', 3000n],
          ['hotels', 2800n],
          ['food', 1600n],
          ['local_transport', 900n],
          ['activities', 1000n],
          ['other', 700n],
        ]
      : [
          ['hotels', 3500n],
          ['food', 2000n],
          ['local_transport', 1500n],
          ['activities', 1500n],
          ['shopping', 500n],
          ['other', 1000n],
        ];
    const total = BigInt(amount);
    const split = shares.map(([category, bp]) => ({ category, amount: (total * bp) / 10_000n }));
    const rest = total - split.reduce((s, x) => s + x.amount, 0n);
    split[split.length - 1]!.amount += rest; // remainder to "other": exact total
    return [
      {
        type: 'text',
        text: `A starting split of ${currency} ${total.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')} by fixed shares${flying ? ' (with flights)' : ''}. These are planning estimates, not prices: adjust them to your plans.`,
      },
      {
        type: 'budget',
        currency,
        categories: split
          .filter((s) => s.amount > 0n)
          .map((s) => ({ category: s.category, amount: Number(s.amount) })),
        tips: [
          'Keep about a tenth for surprises.',
          'Record expenses as you go: the budget page compares them with this plan.',
        ],
      },
    ];
  }

  private packing(input: AssistantGeneration): AssistantModelBlock[] {
    const destination = this.destinationFor(input);
    const ctx = input.context;
    const abroad = destination ? destination.country !== 'India' : false;
    const categories = new Set<ActivityCategory>([
      ...(ctx?.interests ?? []),
      ...(ctx?.activities.map((a) => a.category) ?? []),
      ...wantedInterests(input.message, []),
    ]);
    const clothing = !destination
      ? [
          'Clothes for the expected weather',
          'A light layer for air-conditioning or evenings',
          'Comfortable walking shoes',
        ]
      : COLD.has(destination.id)
        ? [
            'Warm layers and a jacket',
            'Thermals for cold nights',
            'Gloves and a warm hat',
            'Sturdy shoes with grip',
          ]
        : HOT.has(destination.id)
          ? [
              'Light, breathable clothes',
              'Hat and sunglasses',
              'Sandals and comfortable walking shoes',
              'A light layer for air-conditioning',
            ]
          : [
              'Layers you can add or remove',
              'Comfortable walking shoes',
              'A light rain jacket or umbrella',
            ];
    const forActivities: string[] = [];
    if (categories.has('beach')) forActivities.push('Swimwear and a quick-dry towel');
    if (categories.has('nature') || categories.has('adventure'))
      forActivities.push('Day backpack and refillable water bottle');
    if (categories.has('culture'))
      forActivities.push('Clothing that covers shoulders and knees for religious sites');
    if (categories.has('nightlife') || categories.has('food'))
      forActivities.push('One smart-casual outfit for evenings');
    if (categories.has('wellness')) forActivities.push('Comfortable clothes for spa or yoga');
    const groups = [
      {
        title: 'Documents and money',
        items: [
          abroad
            ? 'Passport (check validity and entry rules before you go)'
            : 'Government photo ID',
          'Offline copies of tickets and confirmations',
          'A payment card and some cash',
        ],
      },
      { title: 'Clothing', items: clothing },
      {
        title: 'Health',
        items: [
          'Any regular medicines',
          'Small first-aid kit',
          ...(destination && (HOT.has(destination.id) || COLD.has(destination.id))
            ? ['Sunscreen']
            : []),
          ...(destination && HOT.has(destination.id) ? ['Insect repellent'] : []),
        ],
      },
      {
        title: 'Gadgets',
        items: ['Phone charger and power bank', ...(abroad ? ['Travel adapter'] : [])],
      },
      ...(forActivities.length > 0 ? [{ title: 'For your activities', items: forActivities }] : []),
    ];
    return [
      {
        type: 'text',
        text: `A starting packing list${destination ? ` for ${destination.name}` : ''}. Check the forecast and any entry rules before you go.`,
      },
      { type: 'packing', groups },
    ];
  }

  private review(input: AssistantGeneration): AssistantModelBlock[] {
    const ctx = input.context;
    if (!ctx) {
      return [
        {
          type: 'text',
          text: 'Open the assistant from one of your plans (Trip planner → your plan → Ask the assistant), so I can see its days.',
        },
      ];
    }
    return demoReview(ctx, wantedPace(input.message, ctx.trip.pace));
  }

  private general(input: AssistantGeneration): AssistantModelBlock[] {
    const destination = this.destinationFor(input);
    if (destination) {
      return [
        {
          type: 'text',
          text: `${destination.name}, ${destination.country}. Wayora's sample activities there include ${listWords(destination.activities.slice(0, 3).map((a) => a.title))}. I can plan a few days there, suggest activities for your group, split a budget or make a packing list. For current conditions, prices or opening hours, check official sources.`,
        },
      ];
    }
    return [
      {
        type: 'text',
        text: `I can suggest destinations, sketch a day-by-day itinerary, pick activities for your group, split a budget, make a packing list, or rebalance a plan you've made. Try “Plan 3 relaxed days in Goa for two” or “What should I pack for Manali?”. The demo assistant knows Wayora's sample destinations: ${listWords(SAMPLE_NAMES)}.`,
      },
    ];
  }
}

/** Moves activities from overloaded days to the lightest days (deterministic). */
export function demoReview(ctx: AssistantTripContext, pace: PlanningPace): AssistantModelBlock[] {
  const perDay = PER_DAY[pace];
  const load = new Map(ctx.days.map((d) => [d.dayNumber, d.activities]));
  const moves: { ref: string; toDay: number; reason: string }[] = [];
  for (const day of ctx.days) {
    // Candidates: untimed activities first (easiest to move), latest first.
    const onDay = ctx.activities.filter((a) => a.day === day.date);
    const candidates = [
      ...onDay.filter((a) => a.startTime === null).reverse(),
      ...onDay.filter((a) => a.startTime !== null).reverse(),
    ];
    let count = load.get(day.dayNumber) ?? 0;
    for (const activity of candidates) {
      if (count <= perDay || moves.length >= 8) break;
      const target = [...load.entries()]
        .filter(([n, c]) => n !== day.dayNumber && c < perDay)
        .sort((a, b) => a[1] - b[1] || a[0] - b[0])[0];
      if (!target) break;
      moves.push({
        ref: activity.ref,
        toDay: target[0],
        reason: `Day ${day.dayNumber} has ${count} activities and Day ${target[0]} has ${target[1]}; a ${pace} pace is about ${perDay} a day.`,
      });
      load.set(target[0], target[1] + 1);
      count -= 1;
      load.set(day.dayNumber, count);
    }
  }
  const overlaps = ctx.warnings.filter((w) => w.code === 'overlap').length;
  const blocks: AssistantModelBlock[] = [];
  if (moves.length === 0) {
    blocks.push({
      type: 'text',
      text:
        overlaps > 0
          ? `The days are evenly loaded for a ${pace} pace, but the planner flags ${overlaps} overlap${overlaps === 1 ? '' : 's'} (listed above). Change those times on the plan page.`
          : `Your plan already looks balanced for a ${pace} pace (about ${perDay} activities a day). Leave gaps for meals and travel between places.`,
    });
    return blocks;
  }
  blocks.push({
    type: 'text',
    text: `To make the plan less hectic at a ${pace} pace (about ${perDay} activities a day), I suggest moving ${moves.length} activit${moves.length === 1 ? 'y' : 'ies'} to quieter days.${overlaps > 0 ? ` The planner also flags ${overlaps} overlap${overlaps === 1 ? '' : 's'} (listed above).` : ''} Nothing changes until you apply a move.`,
  });
  blocks.push({ type: 'moves', items: moves });
  return blocks;
}
