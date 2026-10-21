import { vi } from 'vitest';
import type { SafeUser, Traveller } from '@wayora/contracts';

/**
 * In-memory stand-in for the account endpoints, installed as `fetch`. It
 * follows the real API's contract (envelopes, status codes, generic auth
 * errors) closely enough to drive the UI; the API's own behaviour is covered
 * by apps/api/test/integration against PostgreSQL. Other paths fail like an
 * offline network, as in the rest of the web tests.
 */
export interface FakeAccountApi {
  fetch: ReturnType<typeof vi.fn>;
  state: {
    account: (SafeUser & { password: string }) | null;
    signedIn: boolean;
    travellers: Traveller[];
  };
  /** Requests received, as "METHOD /path". */
  calls: () => string[];
  /** Hold every response for `path` until the returned function is called. */
  hold: (method: string, path: string) => () => void;
  /** Answer the next request for `path` with this status/body instead. */
  failNext: (method: string, path: string, status: number, code: string, message?: string) => void;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (data: unknown, status = 200) => json(status, { data, meta: { requestId: 'req-test' } });
const fail = (status: number, code: string, message: string, details?: unknown[]) =>
  json(status, {
    error: { code, message, requestId: 'req-test', ...(details ? { details } : {}) },
  });

export const TEST_USER: SafeUser & { password: string } = {
  id: '01890000-0000-7000-8000-000000000001',
  name: 'Asha Rao',
  email: 'asha@example.com',
  emailVerified: false,
  createdAt: '2026-10-01T09:00:00.000Z',
  password: 'blue river morning',
};

let nextId = 100;
const newId = () => `01890000-0000-7000-8000-${String((nextId += 1)).padStart(12, '0')}`;

export function installFakeAccountApi({
  signedIn = false,
  account = TEST_USER,
  travellers = [],
}: {
  signedIn?: boolean;
  account?: (SafeUser & { password: string }) | null;
  travellers?: Traveller[];
} = {}): FakeAccountApi {
  const state = { account: account ? { ...account } : null, signedIn, travellers: [...travellers] };
  const calls: string[] = [];
  const holds = new Map<string, Promise<void>>();
  const failures = new Map<string, Response>();

  const safe = () => {
    const { password: _password, ...user } = state.account!;
    return user;
  };

  const handle = (method: string, path: string, body: Record<string, unknown>): Response => {
    const authed = state.signedIn && state.account !== null;
    const unauth = () => fail(401, 'UNAUTHENTICATED', 'Sign in to continue.');

    if (method === 'GET' && path === '/auth/me') return authed ? ok({ user: safe() }) : unauth();
    if (method === 'POST' && path === '/auth/login') {
      const email = String(body.email ?? '')
        .trim()
        .toLowerCase();
      if (
        state.account &&
        email === state.account.email &&
        body.password === state.account.password
      ) {
        state.signedIn = true;
        return ok({ user: safe() });
      }
      return fail(401, 'UNAUTHENTICATED', 'That email and password combination is not correct.');
    }
    if (method === 'POST' && path === '/auth/register') {
      const email = String(body.email ?? '')
        .trim()
        .toLowerCase();
      if (state.account?.email === email) {
        return fail(
          409,
          'CONFLICT',
          "We couldn't create an account with that email. If you already have one, sign in instead.",
        );
      }
      state.account = {
        ...TEST_USER,
        id: newId(),
        name: String(body.name),
        email,
        password: String(body.password),
      };
      state.signedIn = true;
      return ok({ user: safe() }, 201);
    }
    if (method === 'POST' && path === '/auth/logout') {
      state.signedIn = false;
      return ok({ signedOut: true });
    }
    if (!authed) return unauth();
    if (method === 'POST' && path === '/auth/logout-all') {
      state.signedIn = false;
      return ok({ signedOut: true, sessionsRevoked: 2 });
    }
    if (method === 'PATCH' && path === '/users/me') {
      state.account!.name = String(body.name).trim().replace(/\s+/g, ' ');
      return ok(safe());
    }
    if (path === '/users/me/travellers') {
      if (method === 'GET') return ok(state.travellers);
      if (method === 'POST') {
        const now = new Date().toISOString();
        const t: Traveller = {
          id: newId(),
          firstName: String(body.firstName),
          lastName: String(body.lastName),
          dateOfBirth: (body.dateOfBirth as string | null | undefined) ?? null,
          nationality: (body.nationality as string | null | undefined) ?? null,
          createdAt: now,
          updatedAt: now,
        };
        state.travellers.push(t);
        return ok(t, 201);
      }
    }
    const match = /^\/users\/me\/travellers\/([^/]+)$/.exec(path);
    if (match) {
      const index = state.travellers.findIndex((t) => t.id === match[1]);
      if (index === -1) return fail(404, 'NOT_FOUND', 'That traveller was not found.');
      if (method === 'PATCH') {
        state.travellers[index] = { ...state.travellers[index]!, ...body } as Traveller;
        return ok(state.travellers[index]);
      }
      if (method === 'DELETE') {
        state.travellers.splice(index, 1);
        return ok({ id: match[1], deleted: true });
      }
    }
    return fail(404, 'NOT_FOUND', 'Not found.');
  };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = init?.method ?? 'GET';
    const isAccount = path.startsWith('/auth/') || path.startsWith('/users/');
    if (!isAccount) throw new TypeError('offline');
    const key = `${method} ${path}`;
    calls.push(key);
    const held = holds.get(key);
    if (held) await held;
    const failure = failures.get(key);
    if (failure) {
      failures.delete(key);
      return failure;
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    return handle(method, path, body);
  });

  vi.stubGlobal('fetch', fetchMock);

  return {
    fetch: fetchMock,
    state,
    calls: () => [...calls],
    hold: (method, path) => {
      let release!: () => void;
      holds.set(`${method} ${path}`, new Promise<void>((r) => (release = r)));
      return () => {
        holds.delete(`${method} ${path}`);
        release();
      };
    },
    failNext: (method, path, status, code, message = 'Something went wrong.') => {
      failures.set(`${method} ${path}`, fail(status, code, message));
    },
  };
}
