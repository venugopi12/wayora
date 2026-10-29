import {
  ASSISTANT_LIMITS,
  assistantBlockSchema,
  createPlannedTripSchema,
  dayForNumber,
  putBudgetSchema,
  updateItineraryItemSchema,
  type ApplyAssistantProposal,
  type AssistantApplyResult,
  type AssistantBlock,
  type AssistantBlockOf,
  type AssistantConversation,
  type AssistantConversationDetail,
  type AssistantConversationList,
  type AssistantExchange,
  type AssistantIntent,
  type AssistantItineraryCheck,
  type AssistantMessage,
  type AssistantStatus,
  type AssistantTripContext,
  type CheckAssistantItinerary,
  type ItineraryWarning,
} from '@wayora/contracts';
import type { Prisma, PrismaClient } from '@wayora/database';
import { z } from 'zod';
import { AppError, notFound } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import { IdempotencyService, type IdempotencyMessages } from '../bookings/idempotency.js';
import { tripAccess } from '../planner/access.js';
import type { BudgetService } from '../planner/budget.service.js';
import { PLANNER_CATALOG } from '../planner/catalog.js';
import { runIdempotent } from '../planner/idempotent.js';
import type { NewItem, PlannerService } from '../planner/planner.service.js';
import { dateOnly } from '../planner/presenter.js';
import { parseLocalTime, scheduleWarnings } from '../planner/schedule.js';
import { buildTripContext, factsBlock, type BuiltContext } from './context.js';
import { enrichBlocks, summarizeForHistory } from './enrich.js';
import { classifyIntent } from './intent.js';
import { InvalidOutput, parseModelReply } from './parse.js';
import { AssistantProviderError, callProvider, type AssistantProvider } from './provider.js';

/*
 * The travel assistant (docs/assistant.md).
 *
 * Authorization, on every request:
 * - A conversation belongs to one user; anyone else gets 404.
 * - A conversation about a plan needs current view access to that plan
 *   (tripAccess) — checked again on every read and message, so a removed
 *   member loses it at once. They can still delete their own conversation.
 * - Applying a proposal is an ordinary planner/budget write by that user,
 *   with the same role checks (viewers can't), version checks and history.
 *
 * Cost and abuse: per-user per-minute limiter (route), a 24-hour request cap
 * (assistant_requests), one reply at a time per conversation
 * (pending_until), Idempotency-Key on sends (a retry replays, never re-asks
 * the provider), bounded input and output, one overall timeout with at most
 * AI_MAX_ATTEMPTS attempts. Prompts and outputs are never logged or stored —
 * only the validated blocks the user sees.
 */

type Apply = ApplyAssistantProposal;

const DEFAULT_TITLE = 'New conversation';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const CONVERSATION_NOT_FOUND = 'This conversation doesn’t exist, or it isn’t yours.';
const TRIP_GONE =
  'The plan this conversation is about is no longer available to you. You can delete the conversation.';
const UNAVAILABLE =
  'The travel assistant isn’t available right now. Your plans and the rest of Wayora work as usual.';

const MESSAGE_KEYS: IdempotencyMessages = {
  inProgress: 'This message is still being answered. Wait a moment.',
  reused: 'This request key was already used for a different message. Send it again.',
};
const CONVERSATION_KEYS: IdempotencyMessages = {
  inProgress: 'This conversation is already being created.',
  reused: 'This request key was already used for a different request.',
};

export interface AssistantLimits {
  timeoutMs: number;
  maxAttempts: number;
  maxOutputTokens: number;
  requestsPerDay: number;
  requestsPerMinute: number;
}

export interface AssistantServiceOptions {
  prisma: PrismaClient;
  logger: Logger;
  /** Null when AI_PROVIDER=none: the assistant says it's unavailable. */
  provider: AssistantProvider | null;
  planner: PlannerService;
  budget: BudgetService;
  limits: AssistantLimits;
  now?: () => Date;
  /** Pause between provider attempts (tests). */
  sleep?: (ms: number) => Promise<void>;
}

const validation = (path: string, message: string) =>
  new AppError('VALIDATION_FAILED', 'The request is invalid.', {
    details: [{ path, message, code: 'custom' }],
  });

/** Parses with a contract schema, reporting problems like a request body. */
function parseAs<S extends z.ZodType>(schema: S, value: unknown, prefix = 'body'): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new AppError('VALIDATION_FAILED', 'The request is invalid.', {
    details: result.error.issues.map((i) => ({
      path: [prefix, ...i.path.map(String)].join('.'),
      message: i.message,
      code: i.code,
    })),
  });
}

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const warningsOf = (list: readonly ItineraryWarning[]) =>
  list.map((w) => ({ code: w.code, day: w.day, message: w.message }));

const storedBlocks = z.array(assistantBlockSchema);

type ConversationRow = Prisma.AssistantConversationGetPayload<{
  include: {
    trip: {
      select: { id: true; title: true; userId: true; members: { select: { userId: true } } };
    };
  };
}>;

export class AssistantService {
  private readonly prisma: PrismaClient;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly idempotency: IdempotencyService;

  constructor(private readonly options: AssistantServiceOptions) {
    this.prisma = options.prisma;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.idempotency = new IdempotencyService(this.prisma, this.now);
  }

  get provider(): AssistantProvider | null {
    return this.options.provider;
  }

  // ─── Status ───────────────────────────────────────────────────────────

  async status(userId: string): Promise<AssistantStatus> {
    const provider = this.options.provider;
    return {
      available: provider !== null,
      source: provider
        ? { provider: provider.id, label: provider.label, simulated: provider.simulated }
        : null,
      streaming: false,
      limits: {
        maxMessageChars: ASSISTANT_LIMITS.maxMessageChars,
        requestsPerDay: this.options.limits.requestsPerDay,
        requestsPerMinute: this.options.limits.requestsPerMinute,
      },
      usedToday: await this.requestsToday(userId),
    };
  }

  private requestsToday(userId: string): Promise<number> {
    return this.prisma.assistantRequest.count({
      where: { userId, createdAt: { gt: new Date(this.now().getTime() - DAY_MS) } },
    });
  }

  /** Failed provider calls in the last hour (admin platform health). */
  recentFailures(): Promise<number> {
    return this.prisma.assistantRequest.count({
      where: {
        createdAt: { gt: new Date(this.now().getTime() - HOUR_MS) },
        outcome: { not: 'OK' },
      },
    });
  }

  // ─── Conversations ────────────────────────────────────────────────────

  private presentConversation(row: ConversationRow, userId: string): AssistantConversation {
    const available =
      !row.trip || row.trip.userId === userId || row.trip.members.some((m) => m.userId === userId);
    return {
      id: row.id,
      title: row.title,
      trip: row.trip && available ? { id: row.trip.id, title: row.trip.title } : null,
      tripAvailable: available,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private include(userId: string) {
    return {
      trip: {
        select: {
          id: true,
          title: true,
          userId: true,
          members: { where: { userId }, select: { userId: true } },
        },
      },
    } as const;
  }

  async list(
    userId: string,
    query: { page: number; pageSize: number },
  ): Promise<AssistantConversationList> {
    const where = { userId };
    const [rows, total] = await Promise.all([
      this.prisma.assistantConversation.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: this.include(userId),
      }),
      this.prisma.assistantConversation.count({ where }),
    ]);
    return {
      items: rows.map((r) => this.presentConversation(r, userId)),
      page: query.page,
      pageSize: query.pageSize,
      total,
      limit: ASSISTANT_LIMITS.maxConversations,
    };
  }

  async create(
    userId: string,
    input: { tripId?: string | null | undefined },
    key: string,
  ): Promise<{ conversation: AssistantConversation; replayed: boolean }> {
    const result = await runIdempotent(
      this.idempotency,
      this.logger,
      {
        operation: 'assistant-conversation',
        userId,
        key,
        payload: input,
        messages: CONVERSATION_KEYS,
      },
      (complete) =>
        this.prisma.$transaction(async (tx) => {
          if (input.tripId) await tripAccess(tx, userId, input.tripId, 'view');
          await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
          const count = await tx.assistantConversation.count({ where: { userId } });
          if (count >= ASSISTANT_LIMITS.maxConversations) {
            throw new AppError(
              'ASSISTANT_LIMIT_REACHED',
              `You can keep up to ${ASSISTANT_LIMITS.maxConversations} conversations. Delete one first.`,
            );
          }
          const row = await tx.assistantConversation.create({
            data: { userId, tripId: input.tripId ?? null, title: DEFAULT_TITLE },
            select: { id: true },
          });
          await complete(tx, row.id);
          return row.id;
        }),
    );
    const row = await this.ownConversation(userId, result.id);
    return { conversation: this.presentConversation(row, userId), replayed: result.replayed };
  }

  private async ownConversation(userId: string, id: string): Promise<ConversationRow> {
    const row = await this.prisma.assistantConversation.findFirst({
      where: { id, userId },
      include: this.include(userId),
    });
    if (!row) throw notFound(CONVERSATION_NOT_FOUND);
    return row;
  }

  /** The conversation, after checking its plan (if any) is still yours to view. */
  private async readableConversation(userId: string, id: string) {
    const row = await this.ownConversation(userId, id);
    let access = null;
    if (row.tripId) {
      try {
        access = await tripAccess(this.prisma, userId, row.tripId, 'view');
      } catch (error) {
        if (error instanceof AppError && error.code === 'NOT_FOUND') throw notFound(TRIP_GONE);
        throw error;
      }
    }
    return { row, access };
  }

  async get(userId: string, id: string, before?: string): Promise<AssistantConversationDetail> {
    const { row, access } = await this.readableConversation(userId, id);
    let cursor: { createdAt: Date; id: string } | null = null;
    if (before) {
      cursor = await this.prisma.assistantMessage.findFirst({
        where: { id: before, conversationId: id },
        select: { createdAt: true, id: true },
      });
      if (!cursor) throw notFound('That message isn’t in this conversation.');
    }
    const rows = await this.prisma.assistantMessage.findMany({
      where: {
        conversationId: id,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: ASSISTANT_LIMITS.messagesPageSize + 1,
      include: { actions: { orderBy: { createdAt: 'asc' } } },
    });
    const hasMore = rows.length > ASSISTANT_LIMITS.messagesPageSize;
    const page = rows.slice(0, ASSISTANT_LIMITS.messagesPageSize).reverse();
    return {
      conversation: this.presentConversation(row, userId),
      tripAccess: access
        ? {
            role: access.role,
            canEdit: access.role !== 'viewer',
            canManage: access.role === 'owner',
          }
        : null,
      messages: page.map((m) => this.presentMessage(m)),
      hasMore,
    };
  }

  private presentMessage(
    row: Prisma.AssistantMessageGetPayload<{ include: { actions: true } }>,
  ): AssistantMessage {
    let blocks: AssistantBlock[] = [];
    if (row.role === 'ASSISTANT') {
      const parsed = storedBlocks.safeParse(row.blocks);
      blocks = parsed.success
        ? parsed.data
        : [{ type: 'text', text: 'This reply can no longer be shown.' }];
    }
    return {
      id: row.id,
      role: row.role === 'USER' ? 'user' : 'assistant',
      text: row.text,
      blocks,
      intent: (row.intent as AssistantIntent | null) ?? null,
      source:
        row.role === 'ASSISTANT' && row.provider
          ? {
              provider: row.provider,
              label: row.providerLabel ?? row.provider,
              simulated: row.simulated ?? false,
            }
          : null,
      applied: row.actions.map((a) => ({
        blockId: a.blockId,
        action: a.action as AssistantMessage['applied'][number]['action'],
        tripId: a.tripId,
        at: a.createdAt.toISOString(),
      })),
      createdAt: row.createdAt.toISOString(),
    };
  }

  async remove(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.assistantConversation.deleteMany({ where: { id, userId } });
    if (count === 0) throw notFound(CONVERSATION_NOT_FOUND);
  }

  /** Exactly what the assistant can be told about a plan (shown on request). */
  async tripContext(userId: string, tripId: string): Promise<AssistantTripContext> {
    const built = await buildTripContext(this.prisma, userId, tripId, 'review');
    const budget = await buildTripContext(this.prisma, userId, tripId, 'budget');
    return { ...built.context, budget: budget.context.budget };
  }

  // ─── Messages ─────────────────────────────────────────────────────────

  async send(
    userId: string,
    conversationId: string,
    input: { text: string; intent?: AssistantIntent | undefined },
    key: string,
  ): Promise<{ exchange: AssistantExchange; replayed: boolean }> {
    const { row } = await this.readableConversation(userId, conversationId);
    const provider = this.options.provider;
    if (!provider) throw new AppError('ASSISTANT_UNAVAILABLE', UNAVAILABLE);
    const intent = input.intent ?? classifyIntent(input.text);

    const result = await runIdempotent(
      this.idempotency,
      this.logger,
      {
        operation: 'assistant-message',
        userId,
        key,
        payload: { conversationId, text: input.text, intent: input.intent ?? null },
        messages: MESSAGE_KEYS,
      },
      async (complete) => {
        const messages = await this.prisma.assistantMessage.count({ where: { conversationId } });
        if (messages + 2 > ASSISTANT_LIMITS.maxMessages) {
          throw new AppError(
            'ASSISTANT_LIMIT_REACHED',
            'This conversation is full. Start a new one to keep going.',
          );
        }
        if ((await this.requestsToday(userId)) >= this.options.limits.requestsPerDay) {
          throw new AppError(
            'RATE_LIMITED',
            `You’ve reached today’s limit of ${this.options.limits.requestsPerDay} assistant requests. Try again tomorrow.`,
          );
        }
        // One reply at a time per conversation.
        const now = this.now();
        const lock = await this.prisma.assistantConversation.updateMany({
          where: {
            id: conversationId,
            userId,
            OR: [{ pendingUntil: null }, { pendingUntil: { lt: now } }],
          },
          data: { pendingUntil: new Date(now.getTime() + this.options.limits.timeoutMs + 15_000) },
        });
        if (lock.count === 0) {
          throw new AppError(
            'ASSISTANT_BUSY',
            'The assistant is still answering your previous message in this conversation.',
          );
        }
        try {
          const blocks = await this.reply(provider, userId, row, intent, input.text);
          return await this.prisma.$transaction(async (tx) => {
            // Strictly after the last message, so the order never depends on
            // clock resolution.
            const last = await tx.assistantMessage.findFirst({
              where: { conversationId },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              select: { createdAt: true },
            });
            const now = this.now().getTime();
            const at = new Date(Math.max(now, (last?.createdAt.getTime() ?? 0) + 1));
            await tx.assistantMessage.create({
              data: {
                conversationId,
                role: 'USER',
                text: input.text,
                intent,
                createdAt: at,
              },
            });
            const reply = await tx.assistantMessage.create({
              data: {
                conversationId,
                role: 'ASSISTANT',
                blocks: blocks as unknown as Prisma.InputJsonValue,
                intent,
                provider: provider.id,
                providerLabel: provider.label,
                simulated: provider.simulated,
                model: provider.model,
                createdAt: new Date(at.getTime() + 1),
              },
              select: { id: true },
            });
            await tx.assistantConversation.update({
              where: { id: conversationId },
              data: {
                pendingUntil: null,
                ...(row.title === DEFAULT_TITLE ? { title: titleFrom(input.text) } : {}),
              },
            });
            await complete(tx, reply.id);
            return reply.id;
          });
        } finally {
          await this.prisma.assistantConversation
            .updateMany({ where: { id: conversationId }, data: { pendingUntil: null } })
            .catch(() => undefined);
        }
      },
    );
    return { exchange: await this.exchange(conversationId, result.id), replayed: result.replayed };
  }

  /** Builds the context, asks the provider, validates and enriches. Records the outcome. */
  private async reply(
    provider: AssistantProvider,
    userId: string,
    conversation: ConversationRow,
    intent: AssistantIntent,
    text: string,
  ): Promise<AssistantBlock[]> {
    const built: BuiltContext | null = conversation.tripId
      ? await buildTripContext(this.prisma, userId, conversation.tripId, intent)
      : null;
    const recent = await this.prisma.assistantMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: ASSISTANT_LIMITS.historyInPrompt,
    });
    const history = recent.reverse().map((m) =>
      m.role === 'USER'
        ? { role: 'user' as const, text: m.text ?? '' }
        : {
            role: 'assistant' as const,
            text: summarizeForHistory(storedBlocks.safeParse(m.blocks).data ?? []),
          },
    );
    const started = performance.now();
    let outcome: 'OK' | 'INVALID_OUTPUT' | 'TIMEOUT' | 'PROVIDER_ERROR' = 'OK';
    let usage: { inputTokens: number | null; outputTokens: number | null } = {
      inputTokens: null,
      outputTokens: null,
    };
    let attempts = 0;
    let dropped = 0;
    try {
      const result = await callProvider(
        provider,
        {
          intent,
          message: text,
          history,
          context: built?.context ?? null,
          catalog: PLANNER_CATALOG.map((d) => ({ id: d.id, name: d.name, country: d.country })),
          today: dateOnly(this.now()),
        },
        {
          timeoutMs: this.options.limits.timeoutMs,
          maxAttempts: this.options.limits.maxAttempts,
          maxOutputTokens: this.options.limits.maxOutputTokens,
          ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
        },
      );
      usage = result.usage;
      attempts = result.attempts;
      const parsed = parseModelReply(result.output);
      dropped = parsed.dropped;
      const facts =
        built && (intent === 'review' || intent === 'budget') ? factsBlock(built.context) : null;
      const blocks = enrichBlocks(parsed.blocks, {
        context: built?.context ?? null,
        refs: built?.refs ?? new Map(),
        firstId: facts ? 2 : 1,
      });
      if (blocks.length === 0) throw new InvalidOutput('no usable block after enrichment');
      return facts ? [facts, ...blocks] : blocks;
    } catch (error) {
      if (error instanceof InvalidOutput) {
        outcome = 'INVALID_OUTPUT';
        throw new AppError(
          'ASSISTANT_UNAVAILABLE',
          'The assistant’s answer couldn’t be used. Try again, or rephrase your message.',
        );
      }
      if (error instanceof AssistantProviderError) {
        outcome = error.kind === 'timeout' ? 'TIMEOUT' : 'PROVIDER_ERROR';
        if (error.kind === 'auth') {
          this.logger.error(
            { provider: provider.id, status: error.status },
            'Assistant provider refused the configured credentials',
          );
        }
        throw error.kind === 'timeout'
          ? new AppError('ASSISTANT_TIMEOUT', 'The assistant took too long to answer. Try again.')
          : new AppError('ASSISTANT_UNAVAILABLE', UNAVAILABLE);
      }
      outcome = 'PROVIDER_ERROR';
      throw error;
    } finally {
      const latencyMs = Math.round(performance.now() - started);
      // Outcome, timing and token counts only: never the prompt or the output.
      this.logger.info(
        {
          provider: provider.id,
          model: provider.model,
          intent,
          outcome,
          latencyMs,
          attempts,
          dropped,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        },
        'Assistant request',
      );
      await this.prisma.assistantRequest
        .create({
          data: {
            userId,
            conversationId: conversation.id,
            provider: provider.id,
            model: provider.model,
            intent,
            outcome,
            latencyMs,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          },
        })
        .catch((err: unknown) =>
          this.logger.warn(
            { err: { message: (err as Error).message } },
            'Could not record assistant request',
          ),
        );
    }
  }

  private async exchange(conversationId: string, replyId: string): Promise<AssistantExchange> {
    const reply = await this.prisma.assistantMessage.findFirstOrThrow({
      where: { id: replyId, conversationId },
      include: { actions: true },
    });
    const userMessage = await this.prisma.assistantMessage.findFirstOrThrow({
      where: { conversationId, role: 'USER', createdAt: { lt: reply.createdAt } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { actions: true },
    });
    return { userMessage: this.presentMessage(userMessage), reply: this.presentMessage(reply) };
  }

  // ─── Proposals ────────────────────────────────────────────────────────

  /** A stored block of the given type from one of this user's replies. */
  private async proposal<T extends AssistantBlock['type']>(
    userId: string,
    conversationId: string,
    messageId: string,
    blockId: string,
    type: T,
  ): Promise<AssistantBlockOf<T>> {
    await this.ownConversation(userId, conversationId);
    const message = await this.prisma.assistantMessage.findFirst({
      where: { id: messageId, conversationId, role: 'ASSISTANT' },
      select: { blocks: true },
    });
    if (!message) throw notFound('That reply isn’t in this conversation.');
    const blocks = storedBlocks.safeParse(message.blocks);
    const block = blocks.success
      ? blocks.data.find((b) => 'id' in b && b.id === blockId && b.type === type)
      : undefined;
    if (!block) throw validation('body.blockId', 'That suggestion isn’t in this reply.');
    return block as AssistantBlockOf<T>;
  }

  private chosen(
    block: AssistantBlockOf<'itinerary'>,
    selected: readonly { dayNumber: number; index: number }[],
  ) {
    return selected.map((s, i) => {
      const activity = block.days.find((d) => d.dayNumber === s.dayNumber)?.activities[s.index];
      if (!activity) throw validation(`body.selected.${i}`, 'That activity isn’t in the proposal.');
      return { ...s, activity };
    });
  }

  /** Read-only: where chosen activities would go on a plan, and the planner's warnings. */
  async checkItinerary(
    userId: string,
    conversationId: string,
    messageId: string,
    input: CheckAssistantItinerary,
  ): Promise<AssistantItineraryCheck> {
    const block = await this.proposal(
      userId,
      conversationId,
      messageId,
      input.blockId,
      'itinerary',
    );
    const chosen = this.chosen(block, input.selected);
    const trip = await tripAccess(this.prisma, userId, input.tripId, 'view');
    const existing = await this.prisma.itineraryItem.findMany({
      where: { tripId: input.tripId },
      select: {
        id: true,
        day: true,
        position: true,
        title: true,
        startMinute: true,
        durationMinutes: true,
      },
    });
    const items = existing.map((i) => ({ ...i, day: dateOnly(i.day) }));
    const placements = chosen.map((c) => ({
      dayNumber: c.dayNumber,
      index: c.index,
      day: dayForNumber(trip.startDate, trip.endDate, c.dayNumber),
    }));
    const nextPosition = new Map<string, number>();
    const proposed = chosen.flatMap((c, i) => {
      const day = placements[i]?.day;
      if (!day) return [];
      const position = nextPosition.get(day) ?? items.filter((x) => x.day === day).length;
      nextPosition.set(day, position + 1);
      return [
        {
          id: `new:${i}`,
          day,
          position,
          title: c.activity.title,
          startMinute: c.activity.startTime ? parseLocalTime(c.activity.startTime) : null,
          durationMinutes: c.activity.durationMinutes,
        },
      ];
    });
    const warnings = scheduleWarnings([...items, ...proposed], trip).filter((w) =>
      w.itemIds.some((id) => id.startsWith('new:')),
    );
    return {
      tripId: input.tripId,
      canEdit: trip.role !== 'viewer',
      placements,
      warnings: warningsOf(warnings),
      existingActivities: items.length,
    };
  }

  /**
   * Applies one proposal the user confirmed (`confirm: true`), through the
   * normal planner and budget services: the same role checks, validation,
   * version checks, limits and history as doing it by hand. Only these five
   * actions exist; nothing else can be triggered from a reply.
   */
  async apply(
    userId: string,
    conversationId: string,
    messageId: string,
    input: Apply,
    key: string,
  ): Promise<AssistantApplyResult> {
    const { result, replayed } = await this.runAction(
      userId,
      conversationId,
      messageId,
      input,
      key,
    );
    if (replayed) return result;
    await this.prisma.assistantAction.create({
      data: {
        messageId,
        userId,
        tripId: result.tripId,
        action: input.action,
        blockId: input.blockId,
      },
    });
    this.logger.info(
      { action: input.action, conversationId, tripId: result.tripId },
      'Assistant proposal applied',
    );
    return result;
  }

  private async runAction(
    userId: string,
    conversationId: string,
    messageId: string,
    input: Apply,
    key: string,
  ): Promise<{ result: AssistantApplyResult; replayed: boolean }> {
    const { planner, budget } = this.options;
    switch (input.action) {
      case 'add_itinerary': {
        const block = await this.proposal(
          userId,
          conversationId,
          messageId,
          input.blockId,
          'itinerary',
        );
        const chosen = this.chosen(block, input.selected);
        const trip = await tripAccess(this.prisma, userId, input.tripId, 'edit');
        const items = chosen.map((c, i): NewItem => {
          const day = dayForNumber(trip.startDate, trip.endDate, c.dayNumber);
          if (!day) {
            throw validation(
              `body.selected.${i}`,
              `Day ${c.dayNumber} is after the plan ends. Choose activities from the plan’s days.`,
            );
          }
          return toNewItem(c.activity, day);
        });
        const { trip: updated, replayed } = await planner.addItems(
          userId,
          input.tripId,
          items,
          key,
        );
        return {
          replayed,
          result: {
            action: input.action,
            tripId: input.tripId,
            message: `Added ${items.length} ${items.length === 1 ? 'activity' : 'activities'} to “${updated.title}”. Nothing already on the plan changed.`,
            warnings: warningsOf(updated.warnings),
          },
        };
      }
      case 'create_plan': {
        const block = await this.proposal(
          userId,
          conversationId,
          messageId,
          input.blockId,
          'itinerary',
        );
        const chosen = this.chosen(block, input.selected);
        const endDate = addDays(input.startDate, block.dayCount - 1);
        const tripInput = parseAs(createPlannedTripSchema, {
          title: input.title,
          ...(block.destination.catalogId
            ? { destinationId: block.destination.catalogId }
            : { destinationName: block.destination.name }),
          startDate: input.startDate,
          endDate,
          preferences: { pace: block.pace, budget: null, group: null, interests: [] },
        });
        const items = chosen.map((c) =>
          toNewItem(c.activity, addDays(input.startDate, c.dayNumber - 1)),
        );
        const { trip, replayed } = await planner.createWithItems(userId, tripInput, items, key);
        return {
          replayed,
          result: {
            action: input.action,
            tripId: trip.id,
            message: `Created “${trip.title}” with ${items.length} ${items.length === 1 ? 'activity' : 'activities'}. It’s a plan, not a booking.`,
            warnings: warningsOf(trip.warnings),
          },
        };
      }
      case 'add_activity': {
        const block = await this.proposal(
          userId,
          conversationId,
          messageId,
          input.blockId,
          'activities',
        );
        const item = block.items[input.index];
        if (!item) throw validation('body.index', 'That activity isn’t in the suggestion.');
        const { trip, replayed } = await planner.addItems(
          userId,
          input.tripId,
          [
            {
              day: input.day,
              title: item.title,
              category: item.category,
              durationMinutes: item.durationMinutes,
              location: item.area,
              suggestionId: item.catalogId,
            },
          ],
          key,
        );
        return {
          replayed,
          result: {
            action: input.action,
            tripId: input.tripId,
            message: `Added “${item.title}” to “${trip.title}”.`,
            warnings: warningsOf(trip.warnings),
          },
        };
      }
      case 'apply_budget': {
        const block = await this.proposal(
          userId,
          conversationId,
          messageId,
          input.blockId,
          'budget',
        );
        const body = parseAs(putBudgetSchema, {
          ...(input.version !== undefined ? { version: input.version } : {}),
          currency: block.currency,
          totalMinor: block.totalMinor,
          categories: block.categories,
        });
        await budget.putBudget(userId, input.tripId, body);
        return {
          replayed: false,
          result: {
            action: input.action,
            tripId: input.tripId,
            message: 'Budget saved from the suggestion. Your recorded expenses are unchanged.',
            warnings: [],
          },
        };
      }
      case 'move_activity': {
        const block = await this.proposal(
          userId,
          conversationId,
          messageId,
          input.blockId,
          'moves',
        );
        const move = block.items[input.index];
        if (!move) throw validation('body.index', 'That move isn’t in the suggestion.');
        const update = parseAs(updateItineraryItemSchema, {
          version: move.itemVersion,
          day: move.toDay,
        });
        // A changed (or deleted) activity is refused by the planner's version check.
        const trip = await planner.updateItem(userId, block.tripId, move.itemId, update);
        return {
          replayed: false,
          result: {
            action: input.action,
            tripId: block.tripId,
            message: `Moved “${move.title}” to another day.`,
            warnings: warningsOf(trip.warnings),
          },
        };
      }
    }
  }
}

function toNewItem(
  activity: AssistantBlockOf<'itinerary'>['days'][number]['activities'][number],
  day: string,
): NewItem {
  return {
    day,
    title: activity.title,
    category: activity.category,
    startTime: activity.startTime,
    durationMinutes: activity.durationMinutes,
    location: activity.area,
    notes: activity.note,
    suggestionId: activity.catalogId,
  };
}

/** A conversation's title from its first message: one line, at most 60 characters. */
function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line || DEFAULT_TITLE;
}
