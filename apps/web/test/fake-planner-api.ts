import { vi } from 'vitest';
import {
  EMPTY_PLANNER_PREFERENCES,
  plannerActivityListSchema,
  receivedInvitationSchema,
  sentInvitationSchema,
  tripMembersSchema,
  type PlannerActivity,
  type ReceivedInvitation,
  type TripMembers,
  plannedTripSchema,
  suggestionsResponseSchema,
  type ActivitySuggestion,
  type Booking,
  type ItineraryItem,
  type ItineraryWarning,
  type PlannedTrip,
  type PlannerDestination,
  type SuggestionsResponse,
} from '@wayora/contracts';
import { createFakeBudgetApi, type FakeBudgetState } from './fake-budget-api';
import { installFakeBookingApi } from './fake-booking-api';
import { hotel } from './search-fixtures';

/*
 * A stand-in for the trip-planner API (docs/planner.md#api), on top of the
 * booking, account and search fakes. It follows the contract and the API's
 * rules closely enough to drive the UI: writes return the whole trip,
 * creating POSTs need an Idempotency-Key (same key + body replays), trip
 * edits need the current `version`, and a reorder must list exactly the
 * day's activities. Schedule warnings are whatever the fixture says (the
 * real rules are tested in apps/api/test/planner-unit.test.ts), and the
 * real API's behaviour is covered by apps/api/test/integration/planner.test.ts.
 */

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
const ok = (data: unknown, status = 200, headers?: Record<string, string>) =>
  json(status, { data, meta: { requestId: 'req-planner' } }, headers);
const fail = (status: number, code: string, message: string, details?: unknown[]) =>
  json(status, {
    error: { code, message, requestId: 'req-planner', ...(details ? { details } : {}) },
  });

export const DESTINATIONS: PlannerDestination[] = [
  { id: 'goa', name: 'Goa', country: 'India', timeZone: 'Asia/Kolkata', hasSuggestions: true },
  { id: 'kyoto', name: 'Kyoto', country: 'Japan', timeZone: 'Asia/Tokyo', hasSuggestions: true },
];

const AT = '2026-10-22T10:00:00.000Z';
let ids = 0;
export const uuid = () => {
  ids += 1;
  return `01890000-0000-7000-a000-${String(ids).padStart(12, '0')}`;
};

const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function item(
  overrides: Partial<ItineraryItem> & { title: string; day: string },
): ItineraryItem {
  return {
    id: uuid(),
    position: 0,
    category: 'sightseeing',
    startTime: null,
    durationMinutes: null,
    endTime: null,
    endsNextDay: false,
    location: null,
    notes: null,
    suggestionId: null,
    version: 1,
    addedBy: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

/** A valid planned trip; days are derived from the dates and `items`. */
export function plannedTrip({
  items = [],
  warnings = [],
  ...overrides
}: Partial<Omit<PlannedTrip, 'days'>> & {
  items?: ItineraryItem[];
  warnings?: ItineraryWarning[];
} = {}): PlannedTrip {
  const startDate = overrides.startDate ?? '2026-11-12';
  const endDate = overrides.endDate ?? '2026-11-14';
  return rebuild({
    id: uuid(),
    title: 'Goa with friends',
    destination: DESTINATIONS[0]!,
    startDate,
    endDate,
    dayCount: 0,
    itemCount: 0,
    linkedBooking: null,
    access: { role: 'owner', canEdit: true, canManage: true },
    owner: { name: 'Asha Rao', isYou: true },
    memberCount: 0,
    createdAt: AT,
    updatedAt: AT,
    version: 1,
    revision: 1,
    notes: null,
    preferences: EMPTY_PLANNER_PREFERENCES,
    days: [],
    outsideDates: [],
    warnings,
    travelTimeValidated: false,
    ...overrides,
    // `items` (flat) is the source of truth; rebuild lays them out.
    ...{ _items: items },
  } as PlannedTrip & { _items: ItineraryItem[] });
}

function rebuild(trip: PlannedTrip & { _items?: ItineraryItem[] }): PlannedTrip {
  const items = trip._items ?? [...trip.days.flatMap((d) => d.items), ...trip.outsideDates];
  const dates: string[] = [];
  for (let d = trip.startDate; d <= trip.endDate; d = addDays(d, 1)) dates.push(d);
  const byDay = (date: string) =>
    items
      .filter((i) => i.day === date)
      .sort((a, b) => a.position - b.position)
      .map((i, position) => ({ ...i, position }));
  const { _items: _ignored, ...rest } = trip;
  return plannedTripSchema.parse({
    ...rest,
    dayCount: dates.length,
    itemCount: items.length,
    days: dates.map((date, index) => ({ date, dayNumber: index + 1, items: byDay(date) })),
    outsideDates: items.filter((i) => i.day < trip.startDate || i.day > trip.endDate),
  });
}

export const SUGGESTIONS: ActivitySuggestion[] = [
  {
    id: 'goa:palolem-beach',
    title: 'Palolem Beach',
    category: 'beach',
    area: 'South Goa',
    summary: 'A crescent-shaped beach known for calm water and a slower pace.',
    typicalMinutes: 180,
    costLevel: 'free-or-low',
    bestTime: 'afternoon',
    reasons: ['Matches your interest in beach'],
  },
  {
    id: 'goa:fort-aguada',
    title: 'Fort Aguada',
    category: 'sightseeing',
    area: 'Candolim',
    summary: 'A seventeenth-century Portuguese fort and lighthouse above the sea.',
    typicalMinutes: 90,
    costLevel: 'free-or-low',
    bestTime: 'morning',
    reasons: ['A sample highlight of Goa'],
  },
];

/** Members as the API returns them (owner Asha Rao; `you` decides who "isYou" is). */
export function membersOf(trip: PlannedTrip, extra: Partial<TripMembers> = {}): TripMembers {
  return tripMembersSchema.parse({
    owner: { name: trip.owner.name, initials: 'AR', isYou: trip.owner.isYou },
    members: [],
    invitations: [],
    access: trip.access,
    limits: { maxMembers: 20, used: 0 },
    ...extra,
  });
}

export interface PlannerRequest {
  method: string;
  path: string;
  key: string | null;
  body: Record<string, unknown> | null;
}

export function installFakePlannerApi({
  trips = [],
  bookings = [],
  members: initialMembers = {},
  received = [],
  activity: initialActivity = {},
  budgets = {},
}: {
  trips?: PlannedTrip[];
  bookings?: Booking[];
  /** Members per plan id (default: the owner alone). */
  members?: Record<string, TripMembers>;
  /** Invitations addressed to the signed-in user. */
  received?: ReceivedInvitation[];
  /** History per plan id, newest first. */
  activity?: Record<string, PlannerActivity[]>;
  /** Budget, expenses and settlements per plan id (default: nothing recorded). */
  budgets?: Record<string, FakeBudgetState>;
} = {}) {
  const membersStore = new Map(Object.entries(initialMembers));
  const receivedStore = new Map(received.map((r) => [r.id, r]));
  const activityStore = new Map(Object.entries(initialActivity));
  const base = installFakeBookingApi({ results: [hotel], bookings });
  const baseFetch = globalThis.fetch;
  const store = new Map(trips.map((t) => [t.id, t]));
  const requests: PlannerRequest[] = [];
  const keys = new Map<string, { body: string; tripId: string }>();
  const failures: { method: string; pattern: RegExp; response: () => Response }[] = [];
  const holds: { method: string; pattern: RegExp; promise: Promise<void> }[] = [];
  const budget = createFakeBudgetApi(budgets, ok, fail);

  const save = (trip: PlannedTrip & { _items?: ItineraryItem[] }) => {
    const next = rebuild({
      ...trip,
      revision: trip.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    store.set(next.id, next);
    return next;
  };
  const allItems = (t: PlannedTrip) => [...t.days.flatMap((d) => d.items), ...t.outsideDates];
  const toItem = (body: Record<string, unknown>, day: string, position: number): ItineraryItem => {
    const start = (body.startTime as string | null | undefined) ?? null;
    const duration = (body.durationMinutes as number | null | undefined) ?? null;
    let endTime: string | null = null;
    let endsNextDay = false;
    if (start && duration) {
      const [h, m] = start.split(':').map(Number);
      const end = h! * 60 + m! + duration;
      endsNextDay = end > 1440;
      const e = end % 1440;
      endTime = `${String(Math.floor(e / 60)).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}`;
    }
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    return item({
      day,
      position,
      title: String(body.title).trim(),
      category: body.category as ItineraryItem['category'],
      startTime: start,
      durationMinutes: duration,
      endTime,
      endsNextDay,
      location: text(body.location),
      notes: text(body.notes),
      suggestionId: (body.suggestionId as string | undefined) ?? null,
    });
  };

  const handle = (
    method: string,
    path: string,
    body: Record<string, unknown> | null,
    key: string | null,
  ) => {
    if (path === '/planner/invitations' && method === 'GET') {
      return ok({ items: [...receivedStore.values()].filter((r) => r.status === 'pending') });
    }
    const invitationMatch = /^\/planner\/invitations\/([^/]+)(?:\/(accept|decline))?$/.exec(path);
    if (invitationMatch) {
      const invitation = receivedStore.get(invitationMatch[1]!);
      if (!invitation) {
        return fail(
          404,
          'NOT_FOUND',
          'This invitation doesn’t exist, or it isn’t addressed to you.',
        );
      }
      if (!invitationMatch[2]) return ok(invitation);
      if (invitation.status !== 'pending') {
        return fail(409, 'INVITATION_CLOSED', 'The owner withdrew this invitation.');
      }
      const answered = receivedInvitationSchema.parse({
        ...invitation,
        status: invitationMatch[2] === 'accept' ? 'accepted' : 'declined',
      });
      receivedStore.set(answered.id, answered);
      return ok({
        invitation: answered,
        tripId: invitationMatch[2] === 'accept' ? invitation.trip.id : null,
      });
    }
    if (method === 'GET' && path === '/planner/destinations') {
      return ok({ items: DESTINATIONS, sample: true });
    }
    if (path === '/planner/trips') {
      if (method === 'GET') {
        const items = [...store.values()].sort((a, b) => a.startDate.localeCompare(b.startDate));
        return ok({
          items: items.map(
            ({
              version: _v,
              notes: _n,
              preferences: _p,
              days: _d,
              outsideDates: _o,
              warnings: _w,
              travelTimeValidated: _t,
              ...summary
            }) => summary,
          ),
          page: 1,
          pageSize: 20,
          total: items.length,
          limit: 50,
        });
      }
      if (method === 'POST') {
        if (!key) return fail(400, 'BAD_REQUEST', 'Send an Idempotency-Key header.');
        const serialized = JSON.stringify(body);
        const seen = keys.get(key);
        if (seen) {
          if (seen.body !== serialized) return fail(422, 'IDEMPOTENCY_KEY_REUSED', 'Key reused.');
          return ok(store.get(seen.tripId), 201, { 'Idempotent-Replayed': 'true' });
        }
        const destination = DESTINATIONS.find((d) => d.id === body!.destinationId) ?? {
          id: null,
          name: String(body!.destinationName),
          country: null,
          timeZone: null,
          hasSuggestions: false,
        };
        const prefs =
          (body!.preferences as PlannedTrip['preferences'] | undefined) ??
          EMPTY_PLANNER_PREFERENCES;
        const trip = save({
          ...plannedTrip({
            title: String(body!.title).trim(),
            destination,
            startDate: String(body!.startDate),
            endDate: String(body!.endDate),
            notes: (body!.notes as string) || null,
            preferences: prefs,
          }),
        });
        keys.set(key, { body: serialized, tripId: trip.id });
        return ok(trip, 201);
      }
    }
    const tripMatch = /^\/planner\/trips\/([^/]+)(\/.*)?$/.exec(path);
    if (!tripMatch) return fail(404, 'NOT_FOUND', 'Not found.');
    const trip = store.get(tripMatch[1]!);
    const rest = tripMatch[2] ?? '';
    if (!trip) return fail(404, 'NOT_FOUND', 'This planned trip doesn’t exist, or it isn’t yours.');

    if (rest === '') {
      if (method === 'GET') return ok(trip);
      if (method === 'DELETE') {
        store.delete(trip.id);
        return ok({ deleted: true });
      }
      if (method === 'PATCH') {
        if (body!.version !== trip.version) {
          return fail(
            409,
            'PLAN_OUT_OF_DATE',
            'This trip was changed somewhere else since you opened it.',
          );
        }
        const { version: _v, bookingReference, destinationId, destinationName, ...fields } = body!;
        const destination =
          destinationId === undefined
            ? trip.destination
            : (DESTINATIONS.find((d) => d.id === destinationId) ?? {
                id: null,
                name: String(destinationName),
                country: null,
                timeZone: null,
                hasSuggestions: false,
              });
        let linkedBooking = trip.linkedBooking;
        if (bookingReference === null) linkedBooking = null;
        else if (typeof bookingReference === 'string') {
          const b = base.store.find((x) => x.reference === bookingReference);
          if (!b) return fail(404, 'NOT_FOUND', 'No booking with that reference in your account.');
          linkedBooking = {
            reference: b.reference,
            category: b.serviceType,
            status: b.status,
            startsOn: b.startsOn,
            endsOn: b.endsOn,
            demo: true,
          };
        }
        return ok(
          save({
            ...trip,
            ...(fields as Partial<PlannedTrip>),
            notes: typeof fields.notes === 'string' ? fields.notes || null : trip.notes,
            destination,
            linkedBooking,
            version: trip.version + 1,
          }),
        );
      }
    }
    const members = () => membersStore.get(trip.id) ?? membersOf(trip);
    if (rest === '/members' && method === 'GET') return ok(members());
    if (rest === '/invitations' && method === 'POST') {
      const email = String(body!.email ?? '')
        .trim()
        .toLowerCase();
      if (!email.includes('@') || email.startsWith('nobody')) {
        return fail(400, 'VALIDATION_FAILED', 'The request is invalid.', [
          {
            path: 'body.email',
            message:
              'There’s no Wayora account with that email. Ask them to create one, then invite them.',
            code: 'custom',
          },
        ]);
      }
      const name = email.split('@')[0]!.replace(/^./, (c) => c.toUpperCase());
      const invitation = sentInvitationSchema.parse({
        id: uuid(),
        invitee: {
          name,
          initials: name.slice(0, 2).toUpperCase(),
          isYou: false,
          emailMasked: `${email[0]}•••@${email.split('@')[1]}`,
        },
        role: body!.role,
        status: 'pending',
        createdAt: AT,
        expiresAt: '2026-11-05T10:00:00.000Z',
      });
      const current = members();
      membersStore.set(trip.id, {
        ...current,
        invitations: [...current.invitations, invitation],
        limits: { ...current.limits, used: current.limits.used + 1 },
      });
      return ok(invitation, 201);
    }
    const revokeMatch = /^\/invitations\/([^/]+)$/.exec(rest);
    if (revokeMatch && method === 'DELETE') {
      const current = members();
      const invitation = current.invitations.find((i) => i.id === revokeMatch[1]);
      if (!invitation) return fail(404, 'NOT_FOUND', 'That invitation doesn’t exist.');
      membersStore.set(trip.id, {
        ...current,
        invitations: current.invitations.filter((i) => i.id !== invitation.id),
      });
      return ok({ ...invitation, status: 'revoked' });
    }
    const memberMatch = /^\/members\/([^/]+)$/.exec(rest);
    if (memberMatch) {
      const current = members();
      const member = current.members.find((m) => m.id === memberMatch[1]);
      if (!member) return fail(404, 'NOT_FOUND', 'That person isn’t a member of this plan.');
      if (method === 'PATCH') {
        if (!current.access.canManage) {
          return fail(403, 'FORBIDDEN', 'Only the plan’s owner can do that.');
        }
        const next = {
          ...current,
          members: current.members.map((m) =>
            m.id === member.id ? { ...m, role: body!.role as typeof m.role } : m,
          ),
        };
        membersStore.set(trip.id, next);
        return ok(next);
      }
      if (method === 'DELETE') {
        membersStore.set(trip.id, {
          ...current,
          members: current.members.filter((m) => m.id !== member.id),
        });
        if (member.isYou) store.delete(trip.id);
        return ok({ removed: true });
      }
    }
    if (rest === '/activity' && method === 'GET') {
      return ok(
        plannerActivityListSchema.parse({
          items: activityStore.get(trip.id) ?? [],
          nextBefore: null,
        }),
      );
    }
    if (rest === '/suggestions' && method === 'GET') {
      const planned = new Set(allItems(trip).map((i) => i.suggestionId));
      const response: SuggestionsResponse = {
        available: trip.destination.hasSuggestions,
        source: 'curated-sample',
        method: 'rules',
        capacity: { days: trip.dayCount, perDay: 3, planned: trip.itemCount },
        suggestions: trip.destination.hasSuggestions
          ? SUGGESTIONS.filter((s) => !planned.has(s.id))
          : [],
      };
      return ok(suggestionsResponseSchema.parse(response));
    }
    if (rest === '/items' && method === 'POST') {
      if (!key) return fail(400, 'BAD_REQUEST', 'Send an Idempotency-Key header.');
      const seen = keys.get(key);
      if (seen) return ok(trip, 201, { 'Idempotent-Replayed': 'true' });
      const day = String(body!.day);
      if (day < trip.startDate || day > trip.endDate) {
        return fail(400, 'VALIDATION_FAILED', 'The request is invalid.', [
          { path: 'body.day', message: 'Choose a day within the trip dates.', code: 'custom' },
        ]);
      }
      const onDay = allItems(trip).filter((i) => i.day === day).length;
      keys.set(key, { body: JSON.stringify(body), tripId: trip.id });
      return ok(save({ ...trip, _items: [...allItems(trip), toItem(body!, day, onDay)] }), 201);
    }
    const itemMatch = /^\/items\/([^/]+)(\/duplicate)?$/.exec(rest);
    if (itemMatch) {
      const items = allItems(trip);
      const target = items.find((i) => i.id === itemMatch[1]);
      if (!target) return fail(404, 'NOT_FOUND', 'This activity doesn’t exist in this trip.');
      if (itemMatch[2] && method === 'POST') {
        const day = (body?.day as string | undefined) ?? target.day;
        const copy = { ...target, id: uuid(), day, suggestionId: null, position: 999 };
        return ok(save({ ...trip, _items: [...items, copy] }), 201);
      }
      if (method === 'DELETE') {
        return ok(save({ ...trip, _items: items.filter((i) => i.id !== target.id) }));
      }
      if (method === 'PATCH') {
        if (body!.version !== target.version) {
          return fail(
            409,
            'PLAN_OUT_OF_DATE',
            'Someone else changed this activity since you opened it. Load the latest version, then make your change again.',
          );
        }
        const next = {
          ...target,
          ...(body as Partial<ItineraryItem>),
          version: target.version + 1,
        };
        if (body!.day && body!.day !== target.day) next.position = 999;
        return ok(save({ ...trip, _items: items.map((i) => (i.id === target.id ? next : i)) }));
      }
    }
    const orderMatch = /^\/days\/([^/]+)\/order$/.exec(rest);
    if (orderMatch && method === 'PUT') {
      const day = orderMatch[1]!;
      const order = (body!.itemIds as string[]) ?? [];
      const items = allItems(trip);
      const onDay = items.filter((i) => i.day === day);
      if (onDay.length !== order.length || onDay.some((i) => !order.includes(i.id))) {
        return fail(409, 'PLAN_OUT_OF_DATE', 'This day changed since you loaded it.');
      }
      const saved = [...onDay].sort((a, b) => a.position - b.position).map((i) => i.id);
      if (saved.join() !== ((body!.previousOrder as string[]) ?? []).join()) {
        return fail(
          409,
          'PLAN_OUT_OF_DATE',
          'Someone else reordered this day since you loaded it.',
        );
      }
      return ok(
        save({
          ...trip,
          _items: items.map((i) => (i.day === day ? { ...i, position: order.indexOf(i.id) } : i)),
        }),
      );
    }
    return fail(404, 'NOT_FOUND', 'Not found.');
  };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (!url.pathname.startsWith('/api/v1/planner')) return baseFetch(input, init);
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const headers = new Headers(init?.headers);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const key = headers.get('Idempotency-Key');
    requests.push({ method, path, key, body });
    const hold = holds.find((h) => h.method === method && h.pattern.test(path));
    if (hold) await hold.promise;
    const failure = failures.findIndex((f) => f.method === method && f.pattern.test(path));
    if (failure !== -1) return failures.splice(failure, 1)[0]!.response();
    const budgetMatch =
      /^\/planner\/trips\/([^/]+)(\/(?:budget|expenses|balances|settlements)(?:\/.*)?)$/.exec(path);
    if (budgetMatch) {
      const response = budget.handle(
        store.get(budgetMatch[1]!),
        method,
        budgetMatch[2]!,
        url.searchParams,
        body,
        key,
      );
      if (response) return response;
    }
    return handle(method, path, body, key);
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    base,
    store,
    members: membersStore,
    /** Budget state per plan id (created on first use). */
    budgets: budget.states,
    requests,
    writes: () => requests.filter((r) => r.method !== 'GET'),
    /** The next matching request fails with this error envelope. */
    failNext(
      method: string,
      pattern: RegExp,
      status: number,
      code: string,
      message = 'Something went wrong.',
    ) {
      failures.push({ method, pattern, response: () => fail(status, code, message) });
    },
    /** Matching requests wait until the returned function is called. */
    hold(method: string, pattern: RegExp) {
      let release!: () => void;
      const entry = { method, pattern, promise: new Promise<void>((r) => (release = r)) };
      holds.push(entry);
      return () => {
        holds.splice(holds.indexOf(entry), 1);
        release();
      };
    },
  };
}
