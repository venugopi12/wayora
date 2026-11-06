import { vi } from 'vitest';
import {
  adminPromotionListSchema,
  adminPromotionSchema,
  adminPromotionUsageSchema,
  bookingPricingSchema,
  promotionListSchema,
  ROLE_PERMISSIONS,
  type AdminPromotion,
  type AppliedPromotion,
  type Booking,
  type BookingPricing,
  type PromotionOffer,
  type UserRole,
} from '@wayora/contracts';

/*
 * A stand-in for the promotions API (Phase 26), installed over another fake's
 * `fetch` (the booking fake, or the admin fake), so a booking's amount due
 * changes when a coupon is applied, as the server would. Responses are
 * validated against the shared contract. The server's own rules (eligibility,
 * limits, stacking, concurrency) are tested in apps/api.
 */

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (data: unknown) => json(200, { data, meta: { requestId: 'req-promotions' } });
const fail = (status: number, code: string, message: string) =>
  json(status, { error: { code, message, requestId: 'req-promotions' } });

export const PROMO_ID = '01890000-0000-7000-8000-00000000a001';
export const AUTO_ID = '01890000-0000-7000-8000-00000000a002';

export function offer(over: Partial<PromotionOffer> = {}): PromotionOffer {
  return {
    id: PROMO_ID,
    kind: 'coupon',
    code: 'SAVE10',
    name: 'Ten off hotels',
    description: '10% off hotel stays, up to ₹1,000',
    terms: 'One use per customer. Applies to the price before points and credit.',
    discountType: 'percentage',
    percentBps: 1_000,
    amount: null,
    maxDiscount: { amountMinor: '100000', currency: 'INR' },
    minAmount: { amountMinor: '500000', currency: 'INR' },
    categories: ['hotels'],
    startsAt: '2026-10-01T00:00:00+05:30',
    endsAt: '2030-12-31T23:59:00+05:30',
    firstBookingOnly: false,
    stackable: false,
    personal: false,
    ...over,
  };
}

export interface FakePromotionsOptions {
  /** The booking store of the booking fake, if checkout is tested. */
  bookings?: Booking[];
  offers?: PromotionOffer[];
  /** A price-change notice the next pricing read returns (e.g. a coupon was removed). */
  notice?: BookingPricing['notice'];
}

export function installFakePromotionsApi(options: FakePromotionsOptions = {}) {
  const next = globalThis.fetch;
  const offers = options.offers ?? [offer()];
  const applied = new Map<string, AppliedPromotion>();
  const originals = new Map<string, bigint>();
  const puts: unknown[] = [];
  const requests: string[] = [];
  let notice = options.notice ?? null;

  const bookingOf = (reference: string) => options.bookings?.find((b) => b.reference === reference);
  const pricing = (reference: string): BookingPricing => {
    const b = bookingOf(reference)!;
    const total = originals.get(reference) ?? BigInt(b.payment.amount!.amountMinor);
    originals.set(reference, total);
    const a = applied.get(reference);
    const discount = a ? BigInt(a.discount.amountMinor) : 0n;
    const m = (v: bigint) => ({ amountMinor: v.toString(), currency: 'INR' });
    const out = bookingPricingSchema.parse({
      demo: true,
      original: m(total),
      promotions: a ? [a] : [],
      promotionDiscount: a ? m(discount) : null,
      afterPromotions: m(total - discount),
      points: null,
      credit: null,
      payable: m(total - discount),
      canChangePromotions: b.payment.canPay,
      reason: b.payment.canPay ? null : 'Offers can only be changed before a booking is paid.',
      notice,
    });
    notice = null;
    return out;
  };
  const sync = (reference: string) => {
    const b = bookingOf(reference);
    if (b) Object.assign(b, { payment: { ...b.payment, amount: pricing(reference).payable } });
  };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace('/api/v1', '');
    if (path === '/promotions' && method === 'GET') {
      requests.push(`${method} ${path}${url.search}`);
      return ok(promotionListSchema.parse({ items: offers }));
    }
    const m = /^\/bookings\/([^/]+)\/pricing(\/coupon)?$/.exec(path);
    if (!m) return next(input, init);
    requests.push(`${method} ${path}`);
    const reference = decodeURIComponent(m[1]!);
    if (!bookingOf(reference)) return fail(404, 'NOT_FOUND', "We couldn't find that booking.");
    if (!m[2] && method === 'GET') return ok(pricing(reference));
    if (method === 'DELETE') {
      applied.delete(reference);
      sync(reference);
      return ok(pricing(reference));
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { code: string };
    puts.push(body);
    const code = body.code.replace(/\s+/g, '').toUpperCase();
    if (code === 'OLDDEAL') return fail(422, 'COUPON_EXPIRED', 'This coupon has expired.');
    const found = offers.find((o) => o.code === code);
    if (!found) return fail(422, 'COUPON_NOT_FOUND', 'We don’t recognise that coupon code.');
    const total =
      originals.get(reference) ?? BigInt(bookingOf(reference)!.payment.amount!.amountMinor);
    originals.set(reference, total);
    let d = (total * BigInt(found.percentBps ?? 0)) / 10_000n;
    if (found.maxDiscount && d > BigInt(found.maxDiscount.amountMinor))
      d = BigInt(found.maxDiscount.amountMinor);
    applied.set(reference, {
      promotionId: found.id,
      kind: 'coupon',
      code,
      name: found.name,
      description: found.description,
      discount: { amountMinor: d.toString(), currency: 'INR' },
      status: 'reserved',
      reservedUntil: '2030-01-01T10:30:00.000Z',
    });
    sync(reference);
    return ok(pricing(reference));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { puts, requests };
}

// ─── Admin ────────────────────────────────────────────────────────────────

export function adminPromotion(over: Partial<AdminPromotion> = {}): AdminPromotion {
  return adminPromotionSchema.parse({
    ...offer(),
    currency: 'INR',
    usageLimit: 500,
    perUserLimit: 1,
    userId: null,
    listed: true,
    active: true,
    version: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    usage: {
      reserved: 2,
      redeemed: 7,
      released: 3,
      reversed: 1,
      redeemedDiscount: { amountMinor: '700000', currency: 'INR' },
      redeemedBookingValue: { amountMinor: '16380000', currency: 'INR' },
    },
    state: 'running',
    ...over,
  });
}

/** Admin promotions endpoints over the admin fake, with the role's real permissions. */
export function installFakeAdminPromotionsApi(role: UserRole) {
  const next = globalThis.fetch;
  let current = adminPromotion();
  const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const can = (p: string) => (ROLE_PERMISSIONS[role] as readonly string[]).includes(p);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace('/api/v1', '');
      if (!path.startsWith('/admin/promotions')) return next(input, init);
      const method = init?.method ?? 'GET';
      const write = method !== 'GET';
      if (!can(write ? 'admin.promotions.manage' : 'admin.promotions.read'))
        return fail(403, 'FORBIDDEN', 'You don’t have access to this.');
      const page = { page: 1, pageSize: 25, totalResults: 1, totalPages: 1 };
      if (path === '/admin/promotions' && !write)
        return ok(adminPromotionListSchema.parse({ items: [current], pagination: page }));
      if (path === `/admin/promotions/${PROMO_ID}` && !write) return ok(current);
      if (path === `/admin/promotions/${PROMO_ID}/usage`)
        return ok(
          adminPromotionUsageSchema.parse({
            items: [
              {
                id: '01890000-0000-7000-8000-00000000b001',
                status: 'redeemed',
                bookingReference: 'WYD-7KQ2-M9XD',
                discount: { amountMinor: '100000', currency: 'INR' },
                eligibleAmount: { amountMinor: '2340000', currency: 'INR' },
                promotionVersion: 1,
                createdAt: '2026-10-20T10:00:00.000Z',
                redeemedAt: '2026-10-20T10:05:00.000Z',
                closedAt: null,
                closeReason: null,
              },
            ],
            pagination: page,
          }),
        );
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      writes.push({ method, path, body });
      if (path === '/admin/promotions' && method === 'POST') {
        if (body.code === 'TAKEN') return fail(409, 'CONFLICT', 'That code is already used.');
        current = adminPromotion({ ...(body as Partial<AdminPromotion>), id: PROMO_ID });
        return json(201, { data: current, meta: { requestId: 'r' } });
      }
      if (path === `/admin/promotions/${PROMO_ID}/status`) {
        current = adminPromotion({
          ...current,
          active: Boolean(body.active),
          state: body.active ? 'running' : 'inactive',
        });
        return ok(current);
      }
      if (path === `/admin/promotions/${PROMO_ID}` && method === 'PATCH') {
        current = adminPromotion({
          ...current,
          name: String(body.name),
          version: current.version + 1,
        });
        return ok(current);
      }
      return fail(404, 'NOT_FOUND', 'Not found.');
    }),
  );
  return { writes };
}
