import { vi } from 'vitest';
import {
  ROLE_PERMISSIONS,
  adminSupportMessagePageSchema,
  adminSupportTicketListSchema,
  adminSupportTicketSchema,
  supportAiSuggestionSchema,
  supportMessagePageSchema,
  supportMetricsSchema,
  supportTicketListSchema,
  supportTicketSchema,
  type AdminSupportMessage,
  type AdminSupportTicket,
  type SupportMessage,
  type SupportTicket,
  type UserRole,
} from '@wayora/contracts';

/*
 * A stand-in for the support API (Phase 27), installed over another fake's
 * `fetch`. Responses are validated against the shared contract. The server's
 * own rules (ownership, transitions, permissions, note privacy) are tested
 * in apps/api; this checks what the pages send and show.
 */

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (data: unknown, status = 200) =>
  json(status, { data, meta: { requestId: 'req-support' } });
const fail = (status: number, code: string, message: string, details: unknown[] = []) =>
  json(status, {
    error: { code, message, requestId: 'req-support', ...(details.length ? { details } : {}) },
  });

export const REF = 'WYS-7KQ2-M9XD';
const T0 = '2026-11-06T06:00:00.000Z';

export function customerTicket(over: Partial<SupportTicket> = {}): SupportTicket {
  return supportTicketSchema.parse({
    reference: REF,
    subject: 'Payment taken twice',
    category: 'payment',
    priority: 'normal',
    status: 'in_progress',
    bookingReference: null,
    createdAt: T0,
    updatedAt: T0,
    unread: 1,
    revision: 3,
    booking: null,
    canReply: true,
    canClose: true,
    resolvedAt: null,
    closedAt: null,
    history: [
      { at: T0, status: 'open', by: 'you' },
      { at: T0, status: 'in_progress', by: 'support' },
    ],
    ...over,
  });
}

const msg = (seq: number, author: SupportMessage['author'], body: string): SupportMessage => ({
  id: `01890000-0000-7000-8000-0000000000${String(seq).padStart(2, '0')}`,
  seq,
  author,
  authorName:
    author === 'customer' ? 'You' : author === 'system' ? 'Wayora' : 'Ravi · Wayora support',
  body,
  createdAt: T0,
  seenBySupport: author === 'customer' ? true : null,
  readByCustomer: null,
});

export function installFakeSupportApi(options: { tickets?: SupportTicket[] } = {}) {
  const next = globalThis.fetch;
  const tickets = options.tickets ?? [customerTicket()];
  const messages: SupportMessage[] = [
    msg(1, 'customer', 'I was charged twice yesterday.'),
    msg(2, 'system', `Thanks, we’ve received your request. Your ticket reference is ${REF}.`),
    msg(3, 'agent', 'Hello, demo payments never take real money. Let me check.'),
  ];
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace('/api/v1', '');
      if (!path.startsWith('/support')) return next(input, init);
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (method !== 'GET') posts.push({ path, body });
      if (path === '/support/tickets' && method === 'GET') {
        const view = url.searchParams.get('view') ?? 'active';
        const booking = url.searchParams.get('booking');
        const items = tickets
          .filter((t) =>
            view === 'closed'
              ? t.status === 'closed'
              : view === 'all'
                ? true
                : t.status !== 'closed',
          )
          .filter((t) => !booking || t.bookingReference === booking);
        return ok(
          supportTicketListSchema.parse({
            items,
            pagination: {
              page: 1,
              pageSize: 10,
              totalResults: items.length,
              totalPages: items.length ? 1 : 0,
            },
          }),
        );
      }
      if (path === '/support/tickets' && method === 'POST') {
        if (String(body.subject).includes('fail')) {
          return fail(400, 'VALIDATION_FAILED', 'The request is invalid.', [
            { path: 'subject', message: 'Server says no.', code: 'custom' },
          ]);
        }
        const created = customerTicket({
          reference: 'WYS-ABCD-EFGH',
          subject: String(body.subject),
          category: body.category as SupportTicket['category'],
          status: 'open',
          unread: 0,
          bookingReference: (body.bookingReference as string | undefined) ?? null,
          history: [{ at: T0, status: 'open', by: 'you' }],
        });
        tickets.unshift(created);
        return ok(created, 201);
      }
      const m = /^\/support\/tickets\/([^/]+)(\/[a-z]+)?$/.exec(path);
      const ticket = m ? tickets.find((t) => t.reference === decodeURIComponent(m[1]!)) : undefined;
      if (!ticket) return fail(404, 'NOT_FOUND', "We couldn't find that ticket.");
      const tail = m![2] ?? '';
      if (tail === '' && method === 'GET') return ok(ticket);
      if (tail === '/messages' && method === 'GET') {
        return ok(supportMessagePageSchema.parse({ items: messages, nextBefore: null }));
      }
      if (tail === '/messages' && method === 'POST') {
        messages.push(msg(messages.length + 1, 'customer', String(body.body)));
        Object.assign(ticket, { revision: ticket.revision + 1 });
        return ok(ticket);
      }
      if (tail === '/read') {
        Object.assign(ticket, { unread: 0 });
        return ok({ unread: 0 });
      }
      if (tail === '/close') {
        Object.assign(ticket, { status: 'closed', canReply: false, canClose: false, closedAt: T0 });
        return ok(ticket);
      }
      return fail(404, 'NOT_FOUND', 'Not found.');
    }),
  );
  return { posts, tickets, messages };
}

// ─── Staff ───────────────────────────────────────────────────────────────

export function staffTicket(
  role: UserRole,
  over: Partial<AdminSupportTicket> = {},
): AdminSupportTicket {
  const supervise = role === 'admin';
  return adminSupportTicketSchema.parse({
    reference: REF,
    subject: 'Payment taken twice',
    category: 'payment',
    priority: 'high',
    status: 'in_progress',
    bookingReference: 'WYD-7KQ2-M9XD',
    createdAt: T0,
    updatedAt: T0,
    customerName: 'Asha Rao',
    assignee: null,
    escalated: false,
    firstResponse: { dueAt: '2026-11-06T10:00:00.000Z', metAt: T0, state: 'met' },
    resolution: { dueAt: '2026-11-07T06:00:00.000Z', metAt: null, state: 'pending' },
    awaitingReply: true,
    revision: 4,
    customer: {
      id: '01890000-0000-7000-8000-000000000001',
      name: 'Asha Rao',
      email: 'asha@example.com',
    },
    bookingAtOpen: null,
    bookingNow: {
      reference: 'WYD-7KQ2-M9XD',
      category: 'hotels',
      title: 'Red Roof Homestay (demo)',
      demo: true,
      status: 'confirmed',
      paymentState: 'paid',
      reservationState: null,
      refundState: 'not-applicable',
      startsOn: '2026-11-26',
    },
    resolvedAt: null,
    closedAt: null,
    reopenCount: 0,
    history: [
      {
        seq: 1,
        type: 'created',
        actor: { kind: 'customer', name: 'Customer' },
        from: null,
        to: 'OPEN',
        reason: null,
        internal: false,
        at: T0,
      },
    ],
    allowed: {
      reply: true,
      note: true,
      status: ['waiting_for_customer', 'waiting_for_provider', 'resolved', 'closed'],
      assignSelf: true,
      assignOthers: supervise,
      unassign: false,
      escalate: true,
      deEscalate: false,
      changePriority: true,
      ai: true,
    },
    ...over,
  });
}

export function installFakeAdminSupportApi(role: UserRole, over: Partial<AdminSupportTicket> = {}) {
  const next = globalThis.fetch;
  let ticket = staffTicket(role, over);
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const messages: AdminSupportMessage[] = [
    {
      id: '01890000-0000-7000-8000-0000000000a1',
      seq: 1,
      author: 'customer',
      authorName: 'Asha Rao',
      body: 'I was charged twice yesterday.',
      createdAt: T0,
      readByCustomer: null,
      internal: false,
      staff: null,
      aiAssisted: false,
    },
    {
      id: '01890000-0000-7000-8000-0000000000a2',
      seq: 3,
      author: 'agent',
      authorName: 'Ravi Kumar',
      body: 'Checked: one demo payment only.',
      createdAt: T0,
      readByCustomer: null,
      internal: true,
      staff: { id: '01890000-0000-7000-8000-000000000002', name: 'Ravi Kumar', role: 'support' },
      aiAssisted: false,
    },
  ];
  const can = (p: string) => (ROLE_PERMISSIONS[role] as readonly string[]).includes(p);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace('/api/v1', '');
      if (!path.startsWith('/admin/support')) return next(input, init);
      const method = init?.method ?? 'GET';
      if (!can(method === 'GET' ? 'admin.support.read' : 'admin.support.manage')) {
        return fail(403, 'FORBIDDEN', 'You don’t have access to this.');
      }
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (method !== 'GET') posts.push({ path, body });
      if (path === '/admin/support/metrics') {
        return ok(
          supportMetricsSchema.parse({
            range: url.searchParams.get('range') ?? '7d',
            generatedAt: T0,
            open: 2,
            inProgress: 3,
            pending: 1,
            unassigned: 2,
            escalated: 1,
            overdue: 1,
            created: 9,
            resolved: 4,
            firstResponse: { count: 8, medianMinutes: 95, withinTarget: 0.875 },
            resolution: { count: 4, medianMinutes: 1500, withinTarget: 0.75 },
            byCategory: [
              { category: 'payment', active: 4 },
              { category: 'refund', active: 2 },
            ],
            byPriority: [
              { priority: 'normal', active: 5 },
              { priority: 'high', active: 1 },
            ],
            workload: [
              {
                staff: {
                  id: '01890000-0000-7000-8000-000000000002',
                  name: 'Ravi Kumar',
                  role: 'support',
                },
                active: 3,
                overdue: 1,
              },
            ],
          }),
        );
      }
      if (path === '/admin/support/staff') {
        return ok({
          items: [
            { id: '01890000-0000-7000-8000-000000000002', name: 'Ravi Kumar', role: 'support' },
            { id: '01890000-0000-7000-8000-000000000003', name: 'Meera Admin', role: 'admin' },
          ],
        });
      }
      if (path === '/admin/support/tickets') {
        const {
          revision: _r,
          customer: _c,
          bookingAtOpen: _o,
          bookingNow: _n,
          resolvedAt: _x,
          closedAt: _y,
          reopenCount: _z,
          history: _h,
          allowed: _a,
          ...summary
        } = ticket;
        return ok(
          adminSupportTicketListSchema.parse({
            items: [summary],
            pagination: { page: 1, pageSize: 25, totalResults: 1, totalPages: 1 },
          }),
        );
      }
      if (path === `/admin/support/tickets/${REF}`) return ok(ticket);
      if (path === `/admin/support/tickets/${REF}/messages` && method === 'GET') {
        return ok(adminSupportMessagePageSchema.parse({ items: messages, nextBefore: null }));
      }
      if (path === `/admin/support/tickets/${REF}/messages`) {
        messages.push({
          id: `01890000-0000-7000-8000-0000000000b${messages.length}`,
          seq: messages.length + 10,
          author: 'agent',
          authorName: 'You',
          body: String(body.body),
          createdAt: T0,
          readByCustomer: false,
          internal: Boolean(body.internal),
          staff: {
            id: '01890000-0000-7000-8000-000000000002',
            name: 'Ravi Kumar',
            role: 'support',
          },
          aiAssisted: Boolean(body.aiAssisted),
        });
        ticket = { ...ticket, revision: ticket.revision + 1 };
        return ok(ticket);
      }
      if (path === `/admin/support/tickets/${REF}/read`) return ok({ ok: true });
      if (path === `/admin/support/tickets/${REF}/status`) {
        ticket = {
          ...ticket,
          status: body.status as AdminSupportTicket['status'],
          revision: ticket.revision + 1,
        };
        return ok(ticket);
      }
      if (path === `/admin/support/tickets/${REF}/ai`) {
        return ok(
          supportAiSuggestionSchema.parse({
            kind: body.kind,
            text: 'Hello Asha, demo payments never take real money, so there is nothing to refund.',
            source: 'Wayora demo assistant (rule-based, not AI)',
            simulated: true,
            warnings: [
              'Mentions a refund. Refunds follow Wayora’s rules; support can’t promise or issue one.',
            ],
            articles: [{ slug: 'refund-states', title: 'Refund states explained' }],
          }),
        );
      }
      return fail(404, 'NOT_FOUND', 'Not found.');
    }),
  );
  return { posts };
}
