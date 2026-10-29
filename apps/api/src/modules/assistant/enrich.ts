import {
  ASSISTANT_LIMITS,
  dayForNumber,
  wholeUnitsToMinor,
  type AssistantBlock,
  type AssistantModelBlock,
  type AssistantTripContext,
  type ExpenseCategory,
} from '@wayora/contracts';
import type { CatalogDestination } from '../planner/catalog.js';
import type { ActivityRef } from './context.js';
import { matchCatalogName } from './intent.js';

/*
 * From validated model blocks to what is stored and shown
 * (docs/assistant.md#validation). Deterministic and server-side:
 *
 * - Structured blocks get ids (`b2`, `b3`…; `b1` is the facts block, when
 *   there is one) so a later "apply" names exactly one stored proposal.
 * - Destinations and activities that match Wayora's curated catalog by name
 *   are marked with its id (so applying can reuse the curated suggestion);
 *   nothing else about them is treated as verified.
 * - Budget amounts become minor units; the total is the exact sum of the
 *   categories, computed here — never taken from the model. Duplicate
 *   categories are merged.
 * - Itinerary days are sorted, duplicates dropped, and each activity's
 *   fields kept as validated (no prices or availability exist in the shape).
 * - Suggested moves keep only references that exist in the context sent,
 *   to a different day within the plan; they carry the activity's real id
 *   and version, so applying one later refuses a changed activity.
 */

export interface EnrichContext {
  context: AssistantTripContext | null;
  refs: ReadonlyMap<string, ActivityRef>;
  /** The id of the first structured block (b2 when a facts block comes first). */
  firstId: number;
}

function catalogActivityId(destination: CatalogDestination | null, title: string): string | null {
  if (!destination) return null;
  const t = title.trim().toLowerCase();
  return destination.activities.find((a) => a.title.toLowerCase() === t)?.id ?? null;
}

export function enrichBlocks(
  blocks: readonly AssistantModelBlock[],
  ctx: EnrichContext,
): AssistantBlock[] {
  let next = ctx.firstId;
  const id = () => `b${next++}`;
  const out: AssistantBlock[] = [];
  const planDestination = ctx.context ? matchCatalogName(ctx.context.trip.destination) : null;

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        out.push(block);
        break;
      case 'destinations':
        out.push({
          type: 'destinations',
          id: id(),
          items: block.items.map((item) => ({
            name: item.name,
            country: item.country,
            reason: item.reason,
            bestFor: [...new Set(item.bestFor)],
            catalogId: matchCatalogName(item.name)?.id ?? null,
          })),
        });
        break;
      case 'itinerary': {
        const destination = matchCatalogName(block.destination);
        const seen = new Set<number>();
        const days = [...block.days]
          .sort((a, b) => a.dayNumber - b.dayNumber)
          .filter(
            (d) => d.dayNumber <= block.dayCount && !seen.has(d.dayNumber) && seen.add(d.dayNumber),
          );
        if (days.length === 0) break;
        out.push({
          type: 'itinerary',
          id: id(),
          title: block.title,
          destination: {
            name: destination?.name ?? block.destination,
            catalogId: destination?.id ?? null,
          },
          dayCount: block.dayCount,
          pace: block.pace,
          days: days.map((d) => ({
            dayNumber: d.dayNumber,
            theme: d.theme,
            activities: d.activities.map((a) => ({
              ...a,
              catalogId: catalogActivityId(destination, a.title),
            })),
          })),
          budgetNote: block.budgetNote,
        });
        break;
      }
      case 'activities':
        out.push({
          type: 'activities',
          id: id(),
          items: block.items.map((item) => ({
            ...item,
            catalogId: catalogActivityId(planDestination, item.title),
          })),
        });
        break;
      case 'budget': {
        const merged = new Map<ExpenseCategory, bigint>();
        for (const c of block.categories) {
          merged.set(
            c.category,
            (merged.get(c.category) ?? 0n) + BigInt(wholeUnitsToMinor(c.amount, block.currency)),
          );
        }
        const categories = [...merged.entries()].map(([category, amount]) => ({
          category,
          amountMinor: amount.toString(),
        }));
        const total = [...merged.values()].reduce((s, v) => s + v, 0n);
        out.push({
          type: 'budget',
          id: id(),
          currency: block.currency,
          categories,
          totalMinor: total.toString(),
          tips: block.tips,
        });
        break;
      }
      case 'packing':
        out.push({ type: 'packing', id: id(), groups: block.groups });
        break;
      case 'moves': {
        const trip = ctx.context?.trip;
        if (!trip) break;
        const used = new Set<string>();
        const items = block.items.flatMap((m) => {
          const ref = ctx.refs.get(m.ref);
          const toDay = dayForNumber(trip.startDate, trip.endDate, m.toDay);
          if (!ref || !toDay || toDay === ref.day || used.has(ref.itemId)) return [];
          used.add(ref.itemId);
          return [
            {
              itemId: ref.itemId,
              itemVersion: ref.version,
              title: ref.title,
              fromDay: ref.day,
              toDay,
              reason: m.reason,
            },
          ];
        });
        if (items.length > 0) out.push({ type: 'moves', id: id(), tripId: trip.id, items });
        break;
      }
    }
  }
  return out.slice(0, ASSISTANT_LIMITS.maxBlocks + 1);
}

/** A short plain-text version of a stored reply, for the next prompt's history. */
export function summarizeForHistory(blocks: readonly AssistantBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'text':
        parts.push(b.text);
        break;
      case 'itinerary':
        parts.push(
          `[Proposed itinerary "${b.title}": ${b.days.map((d) => `day ${d.dayNumber}: ${d.activities.map((a) => a.title).join(', ') || 'open'}`).join('; ')}]`,
        );
        break;
      case 'activities':
        parts.push(`[Suggested activities: ${b.items.map((i) => i.title).join(', ')}]`);
        break;
      case 'destinations':
        parts.push(`[Suggested destinations: ${b.items.map((i) => i.name).join(', ')}]`);
        break;
      case 'budget':
        parts.push(
          `[Proposed budget split in ${b.currency}: ${b.categories.map((c) => c.category).join(', ')}]`,
        );
        break;
      case 'packing':
        parts.push(`[Packing list: ${b.groups.map((g) => g.title).join(', ')}]`);
        break;
      case 'moves':
        parts.push(`[Suggested moving ${b.items.length} activities to quieter days]`);
        break;
      case 'facts':
        break;
    }
  }
  const text = parts.join('\n');
  return text.length > 1500 ? `${text.slice(0, 1499)}…` : text;
}
