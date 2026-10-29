import { describe, expect, it } from 'vitest';
import {
  createTripInvitationSchema,
  reorderItineraryDaySchema,
  updateItineraryItemSchema,
  updateTripMemberSchema,
} from '@wayora/contracts';
import { planMessages } from '../src/modules/planner/messages.js';
import { accessFor, initials, maskEmail, personName } from '../src/modules/planner/people.js';
import { LocalSignalHub } from '../src/services/signal-hub.js';
import { StreamCounter } from '../src/services/signal-stream.js';

/* Pure collaboration helpers (docs/planner.md#collaboration). */

describe('people and access', () => {
  it('shows names and initials, never addresses; masks invitee emails', () => {
    expect(personName('  Asha Rao ')).toBe('Asha Rao');
    expect(personName(null)).toBe('A Wayora traveller');
    expect(initials('Asha Rao')).toBe('AR');
    expect(initials('Asha Devi Rao')).toBe('AR');
    expect(initials('Meera')).toBe('ME');
    expect(maskEmail('ravi.kumar@example.com')).toBe('r•••@example.com');
  });

  it('derives what each role may do', () => {
    expect(accessFor('owner')).toEqual({ role: 'owner', canEdit: true, canManage: true });
    expect(accessFor('editor')).toEqual({ role: 'editor', canEdit: true, canManage: false });
    expect(accessFor('viewer')).toEqual({ role: 'viewer', canEdit: false, canManage: false });
  });

  it('writes notifications without email addresses', () => {
    const all = [
      planMessages.invitation('Asha Rao', 'Goa', 'editor'),
      planMessages.invitationAccepted('Ravi', 'Goa'),
      planMessages.invitationDeclined(null, 'Goa'),
      planMessages.roleChanged('Goa', 'viewer'),
      planMessages.removed('Goa'),
      planMessages.memberLeft('Meera', 'Goa'),
      planMessages.planUpdated('Ravi', 'Goa', 'Goa', '2026-11-12', '2026-11-14'),
    ];
    for (const m of all) {
      expect(m.title.length).toBeLessThanOrEqual(120);
      expect(m.message).not.toContain('@');
    }
    expect(planMessages.invitationDeclined(null, 'Goa').message).toBe(
      'A Wayora traveller declined the invitation to “Goa”.',
    );
  });
});

describe('collaboration contracts', () => {
  it('never accepts ownership as a role, or extra fields', () => {
    expect(updateTripMemberSchema.safeParse({ role: 'owner' }).success).toBe(false);
    expect(updateTripMemberSchema.safeParse({ role: 'viewer', userId: 'x' }).success).toBe(false);
    expect(createTripInvitationSchema.safeParse({ email: 'A@B.CO', role: 'editor' }).data).toEqual({
      email: 'a@b.co',
      role: 'editor',
    });
    expect(createTripInvitationSchema.safeParse({ email: 'a@b.co', role: 'owner' }).success).toBe(
      false,
    );
  });

  it('requires the version an edit is based on, and the order a reorder is based on', () => {
    expect(updateItineraryItemSchema.safeParse({ title: 'x' }).success).toBe(false);
    expect(updateItineraryItemSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(updateItineraryItemSchema.safeParse({ version: 3, title: 'x' }).success).toBe(true);
    const id = '01890000-0000-7000-a000-000000000001';
    expect(reorderItineraryDaySchema.safeParse({ itemIds: [id] }).success).toBe(false);
    expect(
      reorderItineraryDaySchema.safeParse({ itemIds: [id], previousOrder: [id] }).success,
    ).toBe(true);
  });
});

describe('live-update plumbing', () => {
  it('caps open streams per user', () => {
    const counter = new StreamCounter(2);
    expect([counter.take('u'), counter.take('u'), counter.take('u')]).toEqual([true, true, false]);
    expect(counter.take('v')).toBe(true);
    counter.release('u');
    expect(counter.take('u')).toBe(true);
  });

  it('fans an announcement out to the streams following that plan only', async () => {
    const hub = new LocalSignalHub();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const stopA = hub.subscribe('plan-a', (s) => a.push(s));
    hub.subscribe('plan-b', (s) => b.push(s));
    hub.deliver('plan-a', '7');
    stopA();
    hub.deliver('plan-a', '8');
    expect(a).toEqual([{ seq: '7' }]);
    expect(b).toEqual([]);
    await hub.close();
    expect(b).toEqual([{ closing: true }]);
  });
});
