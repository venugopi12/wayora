import { describe, expect, it } from 'vitest';
import {
  adminAuditListQuerySchema,
  adminBookingListQuerySchema,
  adminUserListQuerySchema,
  rangeQuerySchema,
  safeUserSchema,
} from '../src/index.js';

describe('admin query contracts', () => {
  it('reject unknown parameters (no client-chosen roles, sorts or columns)', () => {
    expect(adminUserListQuerySchema.safeParse({ isAdmin: 'true' }).success).toBe(false);
    expect(adminUserListQuerySchema.safeParse({ orderBy: 'passwordHash' }).success).toBe(false);
    expect(rangeQuerySchema.safeParse({ range: '7d', userId: 'x' }).success).toBe(false);
  });

  it('bound pagination and default it', () => {
    expect(adminUserListQuerySchema.parse({})).toEqual({ page: 1, pageSize: 25 });
    expect(adminUserListQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
    expect(adminUserListQuerySchema.safeParse({ page: '0' }).success).toBe(false);
  });

  it('bound date ranges to a year, in order', () => {
    expect(
      adminBookingListQuerySchema.safeParse({ from: '2026-01-01', to: '2026-12-31' }).success,
    ).toBe(true);
    expect(
      adminBookingListQuerySchema.safeParse({ from: '2026-01-01', to: '2027-06-01' }).success,
    ).toBe(false);
    expect(
      adminBookingListQuerySchema.safeParse({ from: '2026-02-01', to: '2026-01-01' }).success,
    ).toBe(false);
  });

  it('normalize references and restrict free text', () => {
    expect(adminBookingListQuerySchema.parse({ reference: 'wyd-ab' }).reference).toBe('WYD-AB');
    expect(adminUserListQuerySchema.safeParse({ q: 'a\u0000b' }).success).toBe(false);
    expect(adminAuditListQuerySchema.safeParse({ action: "x'; DROP" }).success).toBe(false);
  });

  it('the signed-in user carries a role, from a closed set', () => {
    const base = {
      id: '01890000-0000-7000-8000-000000000000',
      name: 'A',
      email: 'a@b.co',
      emailVerified: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(safeUserSchema.safeParse({ ...base, role: 'admin' }).success).toBe(true);
    expect(safeUserSchema.safeParse({ ...base, role: 'superuser' }).success).toBe(false);
    expect(safeUserSchema.safeParse(base).success).toBe(false);
  });
});
