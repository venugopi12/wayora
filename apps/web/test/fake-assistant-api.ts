import { vi } from 'vitest';
import {
  assistantConversationDetailSchema,
  assistantMessageSchema,
  assistantStatusSchema,
  type AssistantBlock,
  type AssistantConversationDetail,
  type AssistantMessage,
  type AssistantStatus,
  type PlannedTrip,
  type TripAccess,
} from '@wayora/contracts';
import { installFakePlannerApi } from './fake-planner-api';

/*
 * A stand-in for the travel-assistant API (docs/assistant.md#api) on top of
 * the planner fake. Replies are scripted per test (`reply`), so nothing here
 * pretends to be a model; the API's real behaviour (validation, roles,
 * context, providers) is covered by apps/api/test/integration/assistant.test.ts.
 */

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (data: unknown, status = 200) => json(status, { data, meta: { requestId: 'req-ai' } });
const fail = (status: number, code: string, message: string) =>
  json(status, { error: { code, message, requestId: 'req-ai' } });

const AT = '2026-10-29T10:00:00.000Z';
let ids = 0;
export const aiId = () => {
  ids += 1;
  return `01890000-0000-7000-9000-${String(ids).padStart(12, '0')}`;
};

export const DEMO_SOURCE = {
  provider: 'demo',
  label: 'Wayora demo assistant (rule-based, not AI)',
  simulated: true,
};
export const AI_SOURCE = {
  provider: 'anthropic',
  label: 'AI assistant (Anthropic)',
  simulated: false,
};

export function status(overrides: Partial<AssistantStatus> = {}): AssistantStatus {
  return assistantStatusSchema.parse({
    available: true,
    source: DEMO_SOURCE,
    streaming: false,
    limits: { maxMessageChars: 2000, requestsPerDay: 50, requestsPerMinute: 6 },
    usedToday: 0,
    ...overrides,
  });
}

export function message(overrides: Partial<AssistantMessage>): AssistantMessage {
  return assistantMessageSchema.parse({
    id: aiId(),
    role: 'assistant',
    text: null,
    blocks: [],
    intent: null,
    source: null,
    applied: [],
    createdAt: AT,
    ...overrides,
  });
}

export function conversation(
  overrides: {
    id?: string;
    title?: string;
    trip?: { id: string; title: string } | null;
    tripAccess?: TripAccess | null;
    messages?: AssistantMessage[];
  } = {},
): AssistantConversationDetail {
  return assistantConversationDetailSchema.parse({
    conversation: {
      id: overrides.id ?? aiId(),
      title: overrides.title ?? 'New conversation',
      trip: overrides.trip ?? null,
      tripAvailable: true,
      createdAt: AT,
      updatedAt: AT,
    },
    tripAccess: overrides.tripAccess ?? null,
    messages: overrides.messages ?? [],
    hasMore: false,
  });
}

export interface AiRequest {
  method: string;
  path: string;
  key: string | null;
  body: Record<string, unknown> | null;
}

export function installFakeAssistantApi({
  trips = [],
  conversations = [],
  status: initialStatus = status(),
  reply = () => [{ type: 'text', text: 'Here you go.' }],
}: {
  trips?: PlannedTrip[];
  conversations?: AssistantConversationDetail[];
  status?: AssistantStatus;
  /** The blocks the "assistant" answers with. */
  reply?: (text: string) => AssistantBlock[];
} = {}) {
  const planner = installFakePlannerApi({ trips });
  const plannerFetch = globalThis.fetch;
  const store = new Map(conversations.map((c) => [c.conversation.id, c]));
  const requests: AiRequest[] = [];
  const failures: { pattern: RegExp; response: () => Response }[] = [];
  const holds: { pattern: RegExp; promise: Promise<void> }[] = [];
  const replies = new Map<string, unknown>();
  let currentStatus = initialStatus;
  let replyFor = reply;

  const handle = (
    method: string,
    path: string,
    body: Record<string, unknown> | null,
    key: string | null,
  ) => {
    if (path === '/assistant/status') return ok(currentStatus);
    if (path === '/assistant/conversations' && method === 'GET') {
      const items = [...store.values()].map((c) => c.conversation);
      return ok({ items, page: 1, pageSize: 50, total: items.length, limit: 50 });
    }
    if (path === '/assistant/conversations' && method === 'POST') {
      if (!key) return fail(400, 'BAD_REQUEST', 'Send an Idempotency-Key header.');
      const tripId = (body?.tripId as string | undefined) ?? null;
      const trip = tripId ? planner.store.get(tripId) : undefined;
      if (tripId && !trip) return fail(404, 'NOT_FOUND', 'No such plan.');
      const created = conversation({
        trip: trip ? { id: trip.id, title: trip.title } : null,
        tripAccess: trip ? trip.access : null,
      });
      store.set(created.conversation.id, created);
      return ok(created.conversation, 201);
    }
    const match =
      /^\/assistant\/conversations\/([^/]+)(\/messages(?:\/([^/]+)\/(check|apply))?)?$/.exec(path);
    if (match) {
      const detail = store.get(match[1]!);
      if (!detail)
        return fail(404, 'NOT_FOUND', 'This conversation doesn’t exist, or it isn’t yours.');
      if (!match[2]) {
        if (method === 'DELETE') {
          store.delete(match[1]!);
          return ok({ deleted: true });
        }
        return ok(detail);
      }
      if (!match[3] && method === 'POST') {
        if (!key) return fail(400, 'BAD_REQUEST', 'Send an Idempotency-Key header.');
        const seen = replies.get(key);
        if (seen) return ok(seen, 201);
        if (!currentStatus.available) {
          return fail(
            503,
            'ASSISTANT_UNAVAILABLE',
            'The travel assistant isn’t available right now.',
          );
        }
        const text = String(body?.text ?? '');
        const userMessage = message({ role: 'user', text, intent: 'general' });
        const assistant = message({
          role: 'assistant',
          blocks: replyFor(text),
          intent: 'general',
          source: currentStatus.source,
        });
        detail.messages.push(userMessage, assistant);
        if (detail.conversation.title === 'New conversation')
          detail.conversation.title = text.slice(0, 60);
        const exchange = { userMessage, reply: assistant };
        replies.set(key, exchange);
        currentStatus = { ...currentStatus, usedToday: currentStatus.usedToday + 1 };
        return ok(exchange, 201);
      }
      if (match[4] === 'check') {
        const tripId = String(body?.tripId);
        const trip = planner.store.get(tripId);
        if (!trip) return fail(404, 'NOT_FOUND', 'No such plan.');
        const selected = body?.selected as { dayNumber: number; index: number }[];
        const days = trip.days.map((d) => d.date);
        return ok({
          tripId,
          canEdit: trip.access.canEdit,
          placements: selected.map((s) => ({ ...s, day: days[s.dayNumber - 1] ?? null })),
          warnings: [],
          existingActivities: trip.itemCount,
        });
      }
      if (match[4] === 'apply') {
        if (body?.confirm !== true)
          return fail(400, 'VALIDATION_FAILED', 'Confirm the change first.');
        const tripId = String(body.tripId ?? (body.action === 'create_plan' ? 'new-plan' : ''));
        const target = detail.messages.find((m) => m.id === match[3]);
        target?.applied.push({
          blockId: String(body.blockId),
          action: body.action as AssistantMessage['applied'][number]['action'],
          tripId: planner.store.has(tripId) ? tripId : null,
          at: AT,
        });
        const realTrip = planner.store.has(tripId) ? tripId : [...planner.store.keys()][0]!;
        return ok({ action: body.action, tripId: realTrip, message: 'Applied it.', warnings: [] });
      }
    }
    const context = /^\/assistant\/trips\/([^/]+)\/context$/.exec(path);
    if (context) {
      const trip = planner.store.get(context[1]!);
      if (!trip) return fail(404, 'NOT_FOUND', 'No such plan.');
      return ok({
        source: 'plan',
        trip: {
          id: trip.id,
          title: trip.title,
          destination: trip.destination.name,
          startDate: trip.startDate,
          endDate: trip.endDate,
          dayCount: trip.dayCount,
          groupSize: trip.memberCount + 1,
          pace: null,
        },
        days: [],
        warnings: [],
        budget: null,
        activities: [],
        interests: [],
        group: null,
        budgetLevel: null,
        linkedBooking: null,
        excluded: ['Names and emails of plan members', 'Notes on the plan and its activities'],
      });
    }
    return fail(404, 'NOT_FOUND', 'Not found.');
  };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (!url.pathname.startsWith('/api/v1/assistant')) return plannerFetch(input, init);
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const key = new Headers(init?.headers).get('Idempotency-Key');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    requests.push({ method, path, key, body });
    const hold = holds.find((h) => h.pattern.test(path));
    if (hold && method !== 'GET') await hold.promise;
    const failure = failures.findIndex((f) => f.pattern.test(path) && method !== 'GET');
    if (failure !== -1) return failures.splice(failure, 1)[0]!.response();
    return handle(method, path, body, key);
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    planner,
    store,
    requests,
    writes: () => requests.filter((r) => r.method !== 'GET'),
    setStatus(next: AssistantStatus) {
      currentStatus = next;
    },
    setReply(next: (text: string) => AssistantBlock[]) {
      replyFor = next;
    },
    /** The next matching write fails. */
    failNext(pattern: RegExp, status: number, code: string, messageText = 'Something went wrong.') {
      failures.push({ pattern, response: () => fail(status, code, messageText) });
    },
    /** Matching writes wait until the returned function is called. */
    hold(pattern: RegExp) {
      let release!: () => void;
      const entry = { pattern, promise: new Promise<void>((r) => (release = r)) };
      holds.push(entry);
      return () => {
        holds.splice(holds.indexOf(entry), 1);
        release();
      };
    },
  };
}
