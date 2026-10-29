import { z } from 'zod';
import { isoDateSchema, offsetDateTimeSchema } from './search/common.js';
import {
  ACTIVITY_CATEGORIES,
  PLANNER_LIMITS,
  activityCategorySchema,
  hasUnsafeTextCharacters,
  localTimeSchema,
  plannedTripIdSchema,
  planningPaceSchema,
  tripAccessSchema,
} from './planner.js';
import {
  BUDGET_CURRENCY_DIGITS,
  budgetCurrencySchema,
  expenseCategorySchema,
  type BudgetCurrency,
} from './planner-budget.js';

/*
 * Travel assistant (Phase 21, docs/assistant.md).
 *
 * The assistant answers in BLOCKS, never free-form markup:
 *
 * - The provider (a language model, or the rule-based demo) must return
 *   `{ "blocks": [...] }` matching `assistantModelReplySchema`. Every block is
 *   validated on the server; invalid blocks are dropped, and a reply with no
 *   valid block is refused. Text is plain text, rendered as text (no HTML,
 *   no Markdown, no links, no code).
 * - The server then enriches the valid blocks (`assistantBlockSchema`):
 *   block ids, matches against Wayora's curated catalog, budget totals it
 *   computes itself in integer minor units, and real activity ids/versions
 *   for suggested moves. `facts` blocks are computed by Wayora from the plan
 *   — never by the model — and are the only "verified" content.
 * - Nothing the assistant proposes changes anything by itself. Applying a
 *   proposal is a separate request the user makes (`confirm: true`), checked
 *   against the user's role on the plan like any other edit.
 *
 * Nothing here carries prices, availability, opening hours, travel times or
 * provider statuses: model output is never trusted for those.
 */

export const ASSISTANT_LIMITS = {
  /** Longest user message. */
  maxMessageChars: 2000,
  /** Conversations per account. */
  maxConversations: 50,
  /** Messages (both sides) per conversation. */
  maxMessages: 200,
  /** Earlier messages sent to the provider with a new one. */
  historyInPrompt: 12,
  /** Messages returned per page. */
  messagesPageSize: 50,
  maxBlocks: 6,
  maxTextChars: 4000,
  maxActivitiesPerDay: 8,
  maxListItems: 8,
  maxPackingGroups: 6,
  maxPackingItems: 15,
} as const;

// ─── Text ────────────────────────────────────────────────────────────────

/**
 * Plain text from the model or the user: control characters and
 * bidirectional overrides are removed (not refused — the model can't fix
 * its own output), line breaks kept, length bounded.
 */
export function cleanAssistantText(value: string, max: number, lineBreaks = true): string {
  let out = '';
  for (const char of value.replace(/\r\n?/g, '\n')) {
    if (hasUnsafeTextCharacters(char, lineBreaks)) continue;
    out += char;
  }
  out = lineBreaks ? out.replace(/\n{3,}/g, '\n\n').trim() : out.replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

const modelLine = (max: number) =>
  z
    .string()
    .transform((v) => cleanAssistantText(v, max, false))
    .pipe(z.string().min(1));
const modelOptionalLine = (max: number) =>
  z
    .string()
    .nullish()
    .transform((v) => (v ? cleanAssistantText(v, max, false) || null : null));
const modelText = (max: number) =>
  z
    .string()
    .transform((v) => cleanAssistantText(v, max, true))
    .pipe(z.string().min(1));

// ─── Intents ─────────────────────────────────────────────────────────────

export const ASSISTANT_INTENTS = [
  'general',
  'destinations',
  'itinerary',
  'activities',
  'budget',
  'packing',
  'review',
] as const;
export const assistantIntentSchema = z.enum(ASSISTANT_INTENTS);
export type AssistantIntent = z.infer<typeof assistantIntentSchema>;

// ─── What the provider must return ──────────────────────────────────────

/** Whole currency units (e.g. 4500 for ₹4,500): integers only. */
const wholeUnits = z
  .number()
  .int()
  .min(1)
  .max(10_000_000_000)
  .refine((n) => Number.isSafeInteger(n));

const modelCategory = z.enum(ACTIVITY_CATEGORIES);
const modelDuration = z
  .number()
  .int()
  .min(5)
  .max(PLANNER_LIMITS.maxDurationMinutes)
  .nullish()
  .transform((v) => v ?? null);

export const modelActivitySchema = z.object({
  title: modelLine(120),
  category: modelCategory,
  startTime: localTimeSchema.nullish().transform((v) => v ?? null),
  durationMinutes: modelDuration,
  area: modelOptionalLine(160),
  note: modelOptionalLine(300),
});

export const assistantModelBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: modelText(ASSISTANT_LIMITS.maxTextChars) }),
  z.object({
    type: z.literal('destinations'),
    items: z
      .array(
        z.object({
          name: modelLine(80),
          country: modelOptionalLine(80),
          reason: modelLine(300),
          bestFor: z.array(modelCategory).max(4).default([]),
        }),
      )
      .min(1)
      .max(ASSISTANT_LIMITS.maxListItems),
  }),
  z.object({
    type: z.literal('itinerary'),
    title: modelLine(120),
    destination: modelLine(120),
    dayCount: z.number().int().min(1).max(PLANNER_LIMITS.maxTripDays),
    pace: planningPaceSchema.nullish().transform((v) => v ?? null),
    days: z
      .array(
        z.object({
          dayNumber: z.number().int().min(1).max(PLANNER_LIMITS.maxTripDays),
          theme: modelOptionalLine(80),
          activities: z.array(modelActivitySchema).max(ASSISTANT_LIMITS.maxActivitiesPerDay),
        }),
      )
      .min(1)
      .max(PLANNER_LIMITS.maxTripDays),
    budgetNote: modelOptionalLine(300),
  }),
  z.object({
    type: z.literal('activities'),
    items: z
      .array(
        z.object({
          title: modelLine(120),
          category: modelCategory,
          reason: modelLine(300),
          durationMinutes: modelDuration,
          area: modelOptionalLine(160),
        }),
      )
      .min(1)
      .max(ASSISTANT_LIMITS.maxListItems),
  }),
  z.object({
    type: z.literal('budget'),
    currency: budgetCurrencySchema,
    categories: z
      .array(z.object({ category: expenseCategorySchema, amount: wholeUnits }))
      .min(1)
      .max(9),
    tips: z.array(modelLine(300)).max(6).default([]),
  }),
  z.object({
    type: z.literal('packing'),
    groups: z
      .array(
        z.object({
          title: modelLine(60),
          items: z.array(modelLine(80)).min(1).max(ASSISTANT_LIMITS.maxPackingItems),
        }),
      )
      .min(1)
      .max(ASSISTANT_LIMITS.maxPackingGroups),
  }),
  z.object({
    type: z.literal('moves'),
    items: z
      .array(
        z.object({
          /** The activity's reference in the context sent (`a1`, `a2`…), never a database id. */
          ref: z.string().regex(/^a\d{1,3}$/),
          toDay: z.number().int().min(1).max(PLANNER_LIMITS.maxTripDays),
          reason: modelLine(300),
        }),
      )
      .min(1)
      .max(ASSISTANT_LIMITS.maxListItems),
  }),
]);
export type AssistantModelBlock = z.infer<typeof assistantModelBlockSchema>;
export const ASSISTANT_MODEL_BLOCK_TYPES = [
  'text',
  'destinations',
  'itinerary',
  'activities',
  'budget',
  'packing',
  'moves',
] as const;

// ─── Stored and returned blocks (server-enriched) ───────────────────────

const blockId = z.string().regex(/^b\d{1,2}$/);
const minor = z.string().regex(/^-?(0|[1-9]\d*)$/);
/** A curated sample activity or destination id this item matched, if any. */
const catalogRef = z.string().max(120).nullable();

export const proposedActivitySchema = z.object({
  title: z.string(),
  category: activityCategorySchema,
  startTime: localTimeSchema.nullable(),
  durationMinutes: z.number().int().nullable(),
  area: z.string().nullable(),
  note: z.string().nullable(),
  catalogId: catalogRef,
});
export type ProposedActivity = z.infer<typeof proposedActivitySchema>;

const planFactsSchema = z.object({
  type: z.literal('facts'),
  id: blockId,
  /** Always `plan`: computed by Wayora from the saved plan, not by the assistant. */
  source: z.literal('plan'),
  trip: z.object({
    id: plannedTripIdSchema,
    title: z.string(),
    destination: z.string(),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    dayCount: z.number().int(),
    /** Owner plus members. */
    groupSize: z.number().int(),
    pace: planningPaceSchema.nullable(),
  }),
  days: z.array(
    z.object({ date: isoDateSchema, dayNumber: z.number().int(), activities: z.number().int() }),
  ),
  warnings: z.array(z.object({ code: z.string(), day: isoDateSchema, message: z.string() })),
  budget: z
    .object({
      currency: budgetCurrencySchema.nullable(),
      totalMinor: minor.nullable(),
      remainingMinor: minor.nullable(),
      overBudget: z.boolean(),
      /** Per currency; never converted. */
      totals: z.array(
        z.object({ currency: budgetCurrencySchema, recordedMinor: minor, plannedMinor: minor }),
      ),
      /** Biggest categories by recorded + planned, per currency. */
      topCategories: z.array(
        z.object({
          currency: budgetCurrencySchema,
          category: expenseCategorySchema,
          recordedMinor: minor,
          plannedMinor: minor,
        }),
      ),
    })
    .nullable(),
});

export const assistantBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  planFactsSchema,
  z.object({
    type: z.literal('destinations'),
    id: blockId,
    items: z.array(
      z.object({
        name: z.string(),
        country: z.string().nullable(),
        reason: z.string(),
        bestFor: z.array(activityCategorySchema),
        catalogId: catalogRef,
      }),
    ),
  }),
  z.object({
    type: z.literal('itinerary'),
    id: blockId,
    title: z.string(),
    destination: z.object({ name: z.string(), catalogId: catalogRef }),
    dayCount: z.number().int(),
    pace: planningPaceSchema.nullable(),
    days: z.array(
      z.object({
        dayNumber: z.number().int(),
        theme: z.string().nullable(),
        activities: z.array(proposedActivitySchema),
      }),
    ),
    budgetNote: z.string().nullable(),
  }),
  z.object({
    type: z.literal('activities'),
    id: blockId,
    items: z.array(
      z.object({
        title: z.string(),
        category: activityCategorySchema,
        reason: z.string(),
        durationMinutes: z.number().int().nullable(),
        area: z.string().nullable(),
        catalogId: catalogRef,
      }),
    ),
  }),
  z.object({
    type: z.literal('budget'),
    id: blockId,
    currency: budgetCurrencySchema,
    categories: z.array(z.object({ category: expenseCategorySchema, amountMinor: minor })),
    /** Computed by Wayora as the exact sum of the categories. */
    totalMinor: minor,
    tips: z.array(z.string()),
  }),
  z.object({
    type: z.literal('packing'),
    id: blockId,
    groups: z.array(z.object({ title: z.string(), items: z.array(z.string()) })),
  }),
  z.object({
    type: z.literal('moves'),
    id: blockId,
    tripId: plannedTripIdSchema,
    items: z.array(
      z.object({
        itemId: z.uuid(),
        /** The activity's version when suggested: a changed activity isn't moved. */
        itemVersion: z.number().int(),
        title: z.string(),
        fromDay: isoDateSchema,
        toDay: isoDateSchema,
        reason: z.string(),
      }),
    ),
  }),
]);
export type AssistantBlock = z.infer<typeof assistantBlockSchema>;
export type AssistantBlockOf<T extends AssistantBlock['type']> = Extract<
  AssistantBlock,
  { type: T }
>;

// ─── Conversations and messages ─────────────────────────────────────────

export const assistantConversationIdSchema = z.uuid({ error: 'Not a valid conversation id.' });
export const assistantMessageIdSchema = z.uuid({ error: 'Not a valid message id.' });
export const assistantConversationParamsSchema = z.object({
  conversationId: assistantConversationIdSchema,
});
export const assistantMessageParamsSchema = z.object({
  conversationId: assistantConversationIdSchema,
  messageId: assistantMessageIdSchema,
});

/** Who produced a reply. `simulated`: the rule-based demo, not a language model. */
export const assistantSourceSchema = z.object({
  provider: z.string(),
  label: z.string(),
  simulated: z.boolean(),
});
export type AssistantSource = z.infer<typeof assistantSourceSchema>;

export const ASSISTANT_ACTIONS = [
  'add_itinerary',
  'create_plan',
  'add_activity',
  'apply_budget',
  'move_activity',
] as const;
export const assistantActionSchema = z.enum(ASSISTANT_ACTIONS);
export type AssistantAction = z.infer<typeof assistantActionSchema>;

export const assistantMessageSchema = z.object({
  id: assistantMessageIdSchema,
  role: z.enum(['user', 'assistant']),
  /** The user's words (user messages). */
  text: z.string().nullable(),
  /** The validated reply (assistant messages). */
  blocks: z.array(assistantBlockSchema),
  intent: assistantIntentSchema.nullable(),
  source: assistantSourceSchema.nullable(),
  /** What the user applied from this reply. */
  applied: z.array(
    z.object({
      blockId,
      action: assistantActionSchema,
      tripId: plannedTripIdSchema.nullable(),
      at: offsetDateTimeSchema,
    }),
  ),
  createdAt: offsetDateTimeSchema,
});
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;

export const assistantConversationSchema = z.object({
  id: assistantConversationIdSchema,
  title: z.string(),
  /** The plan it's about, while you can still open it. */
  trip: z.object({ id: plannedTripIdSchema, title: z.string() }).nullable(),
  /** False when the linked plan was shared with you and you're no longer a member. */
  tripAvailable: z.boolean(),
  createdAt: offsetDateTimeSchema,
  updatedAt: offsetDateTimeSchema,
});
export type AssistantConversation = z.infer<typeof assistantConversationSchema>;

export const assistantConversationListSchema = z.object({
  items: z.array(assistantConversationSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  limit: z.number().int(),
});
export type AssistantConversationList = z.infer<typeof assistantConversationListSchema>;

export const assistantConversationDetailSchema = z.object({
  conversation: assistantConversationSchema,
  /** Your role on the linked plan (decides which proposals you can apply). */
  tripAccess: tripAccessSchema.nullable(),
  /** Oldest first. */
  messages: z.array(assistantMessageSchema),
  /** Older messages exist (`?before=<oldest id>`). */
  hasMore: z.boolean(),
});
export type AssistantConversationDetail = z.infer<typeof assistantConversationDetailSchema>;

export const createAssistantConversationSchema = z
  .object({ tripId: plannedTripIdSchema.nullable().optional() })
  .strict();
export type CreateAssistantConversationInput = z.input<typeof createAssistantConversationSchema>;

export const sendAssistantMessageSchema = z
  .object({
    text: z
      .string({ error: 'Type a message.' })
      .transform((v) => v.replace(/\r\n?/g, '\n').trim())
      .pipe(
        z
          .string()
          .min(1, 'Type a message.')
          .max(
            ASSISTANT_LIMITS.maxMessageChars,
            `Use ${ASSISTANT_LIMITS.maxMessageChars} characters or fewer.`,
          )
          .refine((v) => !hasUnsafeTextCharacters(v, true), 'Remove unsupported characters.'),
      ),
    /** A hint from a suggested prompt; otherwise worked out from the text. */
    intent: assistantIntentSchema.optional(),
  })
  .strict();
export type SendAssistantMessageInput = z.input<typeof sendAssistantMessageSchema>;

export const assistantExchangeSchema = z.object({
  userMessage: assistantMessageSchema,
  reply: assistantMessageSchema,
});
export type AssistantExchange = z.infer<typeof assistantExchangeSchema>;

export const assistantConversationListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100).default(1),
    pageSize: z.coerce.number().int().min(1).max(ASSISTANT_LIMITS.maxConversations).default(20),
  })
  .strict();
export const assistantMessagesQuerySchema = z
  .object({ before: assistantMessageIdSchema.optional() })
  .strict();

// ─── Applying proposals (explicit, confirmed user actions) ──────────────

const selectedActivities = z
  .array(
    z.object({
      dayNumber: z.number().int().min(1).max(PLANNER_LIMITS.maxTripDays),
      index: z
        .number()
        .int()
        .min(0)
        .max(ASSISTANT_LIMITS.maxActivitiesPerDay - 1),
    }),
  )
  .min(1, 'Choose at least one activity.')
  .max(PLANNER_LIMITS.maxItemsPerTrip)
  .refine(
    (list) => new Set(list.map((s) => `${s.dayNumber}:${s.index}`)).size === list.length,
    'Each activity may be chosen once.',
  );

/** Every change requires `confirm: true`: the user saw and accepted it. */
const confirmed = z.literal(true, { error: 'Confirm the change first.' });

export const applyAssistantProposalSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('add_itinerary'),
      blockId,
      tripId: plannedTripIdSchema,
      selected: selectedActivities,
      confirm: confirmed,
    })
    .strict(),
  z
    .object({
      action: z.literal('create_plan'),
      blockId,
      title: z
        .string()
        .transform((v) => v.trim().replace(/\s+/g, ' '))
        .pipe(
          z
            .string()
            .min(1, 'Enter a trip name.')
            .max(120, 'Use 120 characters or fewer.')
            .refine((v) => !hasUnsafeTextCharacters(v), 'Remove unsupported characters.'),
        ),
      startDate: isoDateSchema,
      selected: selectedActivities,
      confirm: confirmed,
    })
    .strict(),
  z
    .object({
      action: z.literal('add_activity'),
      blockId,
      index: z
        .number()
        .int()
        .min(0)
        .max(ASSISTANT_LIMITS.maxListItems - 1),
      tripId: plannedTripIdSchema,
      day: isoDateSchema,
      confirm: confirmed,
    })
    .strict(),
  z
    .object({
      action: z.literal('apply_budget'),
      blockId,
      tripId: plannedTripIdSchema,
      /** The budget version shown when confirming; required when the plan already has one. */
      version: z.number().int().min(1).optional(),
      confirm: confirmed,
    })
    .strict(),
  z
    .object({
      action: z.literal('move_activity'),
      blockId,
      index: z
        .number()
        .int()
        .min(0)
        .max(ASSISTANT_LIMITS.maxListItems - 1),
      confirm: confirmed,
    })
    .strict(),
]);
export type ApplyAssistantProposalInput = z.input<typeof applyAssistantProposalSchema>;
export type ApplyAssistantProposal = z.output<typeof applyAssistantProposalSchema>;

export const assistantApplyResultSchema = z.object({
  action: assistantActionSchema,
  tripId: plannedTripIdSchema,
  /** What changed, in words. */
  message: z.string(),
  /** Schedule warnings on the plan afterwards (from the planner's own rules). */
  warnings: z.array(z.object({ code: z.string(), day: isoDateSchema, message: z.string() })),
});
export type AssistantApplyResult = z.infer<typeof assistantApplyResultSchema>;

/** Read-only check of an itinerary proposal against a plan, before applying it. */
export const checkAssistantItinerarySchema = z
  .object({ blockId, tripId: plannedTripIdSchema, selected: selectedActivities })
  .strict();
export type CheckAssistantItineraryInput = z.input<typeof checkAssistantItinerarySchema>;
export type CheckAssistantItinerary = z.output<typeof checkAssistantItinerarySchema>;

export const assistantItineraryCheckSchema = z.object({
  tripId: plannedTripIdSchema,
  canEdit: z.boolean(),
  /** Where each chosen activity would go; `day` is null when the plan is shorter. */
  placements: z.array(
    z.object({
      dayNumber: z.number().int(),
      index: z.number().int(),
      day: isoDateSchema.nullable(),
    }),
  ),
  /** The planner's warnings that involve a proposed activity. */
  warnings: z.array(z.object({ code: z.string(), day: isoDateSchema, message: z.string() })),
  /** Activities already on the plan (they stay; nothing is replaced). */
  existingActivities: z.number().int(),
});
export type AssistantItineraryCheck = z.infer<typeof assistantItineraryCheckSchema>;

// ─── Status and context ──────────────────────────────────────────────────

export const assistantStatusSchema = z.object({
  /** False when no provider is configured (the rest of Wayora works as usual). */
  available: z.boolean(),
  source: assistantSourceSchema.nullable(),
  /** Replies arrive whole; nothing is streamed. */
  streaming: z.literal(false),
  limits: z.object({
    maxMessageChars: z.number().int(),
    requestsPerDay: z.number().int(),
    requestsPerMinute: z.number().int(),
  }),
  /** Requests you've made in the last 24 hours. */
  usedToday: z.number().int(),
});
export type AssistantStatus = z.infer<typeof assistantStatusSchema>;

/** Exactly what the assistant is given about a plan (see docs/assistant.md#context). */
export const assistantTripContextSchema = planFactsSchema.omit({ type: true, id: true }).extend({
  activities: z.array(
    z.object({
      ref: z.string(),
      day: isoDateSchema,
      title: z.string(),
      category: activityCategorySchema,
      startTime: localTimeSchema.nullable(),
      durationMinutes: z.number().int().nullable(),
    }),
  ),
  interests: z.array(activityCategorySchema),
  group: z.string().nullable(),
  budgetLevel: z.string().nullable(),
  /** The owner's linked booking (owner only): category and dates, no reference or price. */
  linkedBooking: z
    .object({ category: z.string(), startsOn: isoDateSchema.nullable(), status: z.string() })
    .nullable(),
  /** What is deliberately left out. */
  excluded: z.array(z.string()),
});
export type AssistantTripContext = z.infer<typeof assistantTripContextSchema>;

// ─── Helpers shared by server and client ────────────────────────────────

/** Whole currency units → minor units (exact, no floating point). */
export function wholeUnitsToMinor(amount: number, currency: BudgetCurrency): string {
  const digits = BUDGET_CURRENCY_DIGITS[currency];
  return (BigInt(amount) * 10n ** BigInt(digits)).toString();
}

/** Plan-day date for a 1-based day number, or null past the end. */
export function dayForNumber(startDate: string, endDate: string, dayNumber: number): string | null {
  const ms = Date.parse(`${startDate}T00:00:00Z`) + (dayNumber - 1) * 86_400_000;
  const day = new Date(ms).toISOString().slice(0, 10);
  return day > endDate ? null : day;
}
