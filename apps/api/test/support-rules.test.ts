import { describe, expect, it } from 'vitest';
import {
  HELP_ARTICLES,
  HELP_CATEGORIES,
  SUPPORT_STATUSES,
  SUPPORT_TRANSITIONS,
  adminSupportReplySchema,
  canTransition,
  createSupportTicketSchema,
  helpArticle,
  searchHelp,
  suggestHelp,
} from '@wayora/contracts';
import {
  allowedFor,
  assignableRole,
  medianMinutes,
  share,
  suggestionWarnings,
  targetState,
  targetsFor,
} from '../src/modules/support/rules.js';

/*
 * Pure support rules (Phase 27, docs/support.md): permissions, transitions,
 * targets and metric arithmetic, input validation, AI-output checks and the
 * Help Center's deterministic search.
 */

const at = (iso: string) => new Date(iso);

describe('status transitions', () => {
  it('closed is final and nothing moves back to open', () => {
    expect(SUPPORT_TRANSITIONS.closed).toEqual([]);
    for (const from of SUPPORT_STATUSES) expect(canTransition(from, 'open')).toBe(false);
    expect(canTransition('resolved', 'in_progress')).toBe(true);
    expect(canTransition('resolved', 'waiting_for_customer')).toBe(false);
    expect(canTransition('open', 'closed')).toBe(true);
  });
});

describe('permissions', () => {
  const open = { status: 'open', escalated: false, assigneeId: null } as const;
  it('support agents work unescalated tickets and take only their own', () => {
    const a = allowedFor({ id: 'a', role: 'support' }, open);
    expect(a).toMatchObject({
      reply: true,
      note: true,
      assignSelf: true,
      assignOthers: false,
      escalate: true,
      deEscalate: false,
    });
    expect(a.status).toEqual([...SUPPORT_TRANSITIONS.open]);
    expect(allowedFor({ id: 'a', role: 'support' }, { ...open, assigneeId: 'a' }).unassign).toBe(
      true,
    );
    expect(allowedFor({ id: 'a', role: 'support' }, { ...open, assigneeId: 'b' }).unassign).toBe(
      false,
    );
  });
  it('escalated tickets: support keeps notes only; admins do everything', () => {
    const esc = { ...open, escalated: true };
    expect(allowedFor({ id: 'a', role: 'support' }, esc)).toMatchObject({
      reply: false,
      note: true,
      status: [],
      assignSelf: false,
      changePriority: false,
      deEscalate: false,
    });
    expect(allowedFor({ id: 'x', role: 'admin' }, esc)).toMatchObject({
      reply: true,
      assignOthers: true,
      deEscalate: true,
    });
    expect(assignableRole('support', true)).toBe(false);
    expect(assignableRole('admin', true)).toBe(true);
    expect(assignableRole('user', false)).toBe(false);
  });
  it('customers have no staff actions, and closed tickets are read-only', () => {
    const none = allowedFor({ id: 'u', role: 'user' }, open);
    expect(
      Object.values(none).every((v) => v === false || (Array.isArray(v) && v.length === 0)),
    ).toBe(true);
    const closed = allowedFor({ id: 'x', role: 'admin' }, { ...open, status: 'closed' });
    expect(
      Object.values(closed).every((v) => v === false || (Array.isArray(v) && v.length === 0)),
    ).toBe(true);
  });
});

describe('targets and metrics', () => {
  it('deadlines are calendar hours from opening, per priority', () => {
    const t = targetsFor('urgent', at('2026-11-06T22:30:00Z'));
    expect(t.firstResponseDueAt.toISOString()).toBe('2026-11-06T23:30:00.000Z');
    expect(t.resolutionDueAt.toISOString()).toBe('2026-11-07T06:30:00.000Z');
    expect(targetsFor('low', at('2026-11-06T00:00:00Z')).firstResponseDueAt.toISOString()).toBe(
      '2026-11-07T00:00:00.000Z',
    );
  });
  it('separates target state from performance', () => {
    const due = at('2026-11-06T10:00:00Z');
    expect(targetState(due, at('2026-11-06T09:00:00Z'), at('2026-11-06T12:00:00Z'))).toBe('met');
    expect(targetState(due, at('2026-11-06T11:00:00Z'), at('2026-11-06T12:00:00Z'))).toBe('missed');
    expect(targetState(due, null, at('2026-11-06T09:00:00Z'))).toBe('pending');
    expect(targetState(due, null, at('2026-11-06T11:00:00Z'))).toBe('overdue');
    expect(targetState(due, null, at('2026-11-06T12:00:00Z'), at('2026-11-06T11:00:00Z'))).toBe(
      'missed',
    );
  });
  it('medians and shares', () => {
    expect(medianMinutes([])).toBeNull();
    expect(medianMinutes([60_000, 180_000, 120_000])).toBe(2);
    expect(medianMinutes([60_000, 120_000])).toBe(1.5);
    expect(share([])).toBeNull();
    expect(share([true, false, true])).toBe(0.667);
  });
});

describe('input', () => {
  const base = {
    subject: 'Payment taken twice',
    category: 'payment',
    description: 'I was charged twice for the same booking yesterday evening.',
    clientKey: '01890000-0000-7000-8000-000000000001',
  };
  it('normalizes text and refuses control characters, extra fields and staff-only priority', () => {
    const ok = createSupportTicketSchema.parse({
      ...base,
      description: '  Line one\r\nline two is long enough  ',
    });
    expect(ok.description).toBe('Line one\nline two is long enough');
    expect(ok.priority).toBe('normal');
    expect(
      createSupportTicketSchema.safeParse({ ...base, subject: 'Two\nlines here' }).success,
    ).toBe(false);
    expect(
      createSupportTicketSchema.safeParse({ ...base, description: 'bell\u0007 character in here' })
        .success,
    ).toBe(false);
    expect(createSupportTicketSchema.safeParse({ ...base, userId: 'x' }).success).toBe(false);
    expect(createSupportTicketSchema.safeParse({ ...base, priority: 'urgent' }).success).toBe(
      false,
    );
    expect(
      createSupportTicketSchema.safeParse({ ...base, bookingReference: 'WYD-7KQ2-M9XD' }).success,
    ).toBe(true);
  });
  it('internal notes can’t ask the customer anything or claim AI help', () => {
    const key = '01890000-0000-7000-8000-000000000002';
    expect(
      adminSupportReplySchema.safeParse({
        body: 'x',
        clientKey: key,
        internal: true,
        requestInfo: true,
      }).success,
    ).toBe(false);
    expect(
      adminSupportReplySchema.safeParse({
        body: 'x',
        clientKey: key,
        internal: true,
        aiAssisted: true,
      }).success,
    ).toBe(false);
  });
});

describe('AI output checks', () => {
  it('flags refunds, compensation, cancellations, promises and secrets', () => {
    expect(suggestionWarnings('Hello, thanks for writing.')).toEqual([]);
    const w = suggestionWarnings(
      'We guarantee your refund and some compensation; we cancelled your booking. Send your card number.',
    );
    expect(w).toHaveLength(5);
  });
});

describe('Help Center content', () => {
  it('every article has a known category, valid related links and a review date', () => {
    const slugs = new Set(HELP_ARTICLES.map((a) => a.slug));
    expect(slugs.size).toBe(HELP_ARTICLES.length);
    const cats = new Set<string>(HELP_CATEGORIES.map((c) => c.slug));
    for (const a of HELP_ARTICLES) {
      expect(cats.has(a.category), a.slug).toBe(true);
      for (const r of a.related) expect(slugs.has(r), `${a.slug} → ${r}`).toBe(true);
      expect(a.reviewed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const act of a.actions ?? []) expect(act.path.startsWith('/')).toBe(true);
    }
    for (const c of HELP_CATEGORIES)
      expect(
        HELP_ARTICLES.some((a) => a.category === c.slug),
        c.slug,
      ).toBe(true);
  });
  it('searches deterministically by title, keywords and body', () => {
    expect(searchHelp('')).toEqual([]);
    expect(searchHelp('the a of')).toEqual([]);
    expect(searchHelp('refund')[0]!.slug).toBe('refund-states');
    expect(searchHelp('forgot password')[0]!.slug).toBe('forgotten-password');
    expect(searchHelp('coupon expired')[0]!.slug).toBe('coupon-not-working');
    expect(searchHelp('PASSPORT')[0]!.slug).toBe('travel-id-and-visas');
    expect(searchHelp('cancel booking').map((a) => a.slug)).toContain('cancelling-a-booking');
    expect(searchHelp('refund')).toEqual(searchHelp('refund'));
    expect(suggestHelp('Payment failed', 'my payment was declined', 2)[0]!.slug).toBe(
      'payment-failed',
    );
    expect(helpArticle('nope')).toBeNull();
  });
});
