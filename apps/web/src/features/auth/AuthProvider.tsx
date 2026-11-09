import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { LoginRequest, RegisterRequest, SafeUser } from '@wayora/contracts';
import {
  createAccount,
  fetchCurrentUser,
  signIn as signInRequest,
  signOut as signOutRequest,
  signOutEverywhere as signOutEverywhereRequest,
} from '../../services/account';
import { onSessionEnded } from '../../services/api';
import { forgetDeviceData } from '../../pwa/device-data';
import { removePushBeforeSignOut } from '../../pwa/push';

/** React Query keys. Everything under `account` belongs to the signed-in user. */
export const authKeys = {
  me: ['auth', 'me'] as const,
  account: ['account'] as const,
  travellers: ['account', 'travellers'] as const,
};

/**
 * - `loading`: the one `/auth/session` check hasn't answered yet. Protected pages
 *   show a loader (never their content) and the header shows placeholders.
 * - `authenticated`: a valid session; `user` is set.
 * - `unauthenticated`: no session, or the check failed (API unreachable).
 */
export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

/** Why the last session in this tab ended: the person signed out, or the server said so. */
export type SessionEnd = 'signed-out' | 'expired' | null;

export interface AuthContextValue {
  status: AuthStatus;
  user: SafeUser | null;
  sessionEnd: SessionEnd;
  /** The `/auth/session` check failed (network or server error), not "signed out". */
  checkFailed: boolean;
  retryCheck: () => void;
  signIn: (body: LoginRequest) => Promise<SafeUser>;
  register: (body: RegisterRequest) => Promise<SafeUser>;
  signOut: () => Promise<void>;
  signOutEverywhere: () => Promise<number>;
  /** Replace the cached user after a profile update. */
  setUser: (user: SafeUser) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Drops every cached query that belongs to the previous user. */
function forgetAccountData(client: QueryClient) {
  client.removeQueries({ queryKey: authKeys.account });
}

/**
 * Session state for the whole app, from a single `GET /auth/session` request
 * (cached by React Query; never refetched on focus). The session cookie is
 * HttpOnly, so JavaScript can't see it: the server's answer is the only source
 * of truth, and nothing about the session is kept in browser storage.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const me = useQuery({
    queryKey: authKeys.me,
    queryFn: ({ signal }) => fetchCurrentUser(signal),
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const [sessionEnd, setSessionEnd] = useState<SessionEnd>(null);

  const signedOutLocally = useCallback(
    (reason: Exclude<SessionEnd, null>) => {
      forgetAccountData(client);
      // A shared device: the next person shouldn't see this one's searches or saved pages.
      forgetDeviceData();
      setSessionEnd(reason);
      client.setQueryData(authKeys.me, null);
    },
    [client],
  );

  // Any authenticated call answered 401: the session expired or was revoked
  // elsewhere. Treat the browser as signed out; protected pages redirect.
  useEffect(() => onSessionEnded(() => signedOutLocally('expired')), [signedOutLocally]);

  const signedIn = useCallback(
    (user: SafeUser) => {
      forgetAccountData(client);
      setSessionEnd(null);
      client.setQueryData(authKeys.me, user);
      return user;
    },
    [client],
  );

  const value = useMemo<AuthContextValue>(() => {
    const user = me.data ?? null;
    const status: AuthStatus = me.isPending
      ? 'loading'
      : user
        ? 'authenticated'
        : 'unauthenticated';
    return {
      status,
      user,
      sessionEnd,
      checkFailed: me.isError,
      retryCheck: () => void me.refetch(),
      signIn: async (body) => signedIn(await signInRequest(body)),
      register: async (body) => signedIn(await createAccount(body)),
      // Only forget the user once the server has revoked the session; if the
      // call fails the cookie is still valid, so the caller reports the error.
      signOut: async () => {
        // This device stops getting the account's push notifications first (Phase 30).
        await removePushBeforeSignOut();
        await signOutRequest();
        signedOutLocally('signed-out');
      },
      signOutEverywhere: async () => {
        await removePushBeforeSignOut();
        const count = await signOutEverywhereRequest();
        signedOutLocally('signed-out');
        return count;
      },
      setUser: (user) => client.setQueryData(authKeys.me, user),
    };
  }, [me, client, sessionEnd, signedIn, signedOutLocally]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>.');
  return value;
}
