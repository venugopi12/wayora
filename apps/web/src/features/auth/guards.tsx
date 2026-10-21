import { RotateCw } from 'lucide-react';
import { Navigate, Outlet, useLocation, useSearchParams } from 'react-router';
import { Button, Container, ErrorState } from '@wayora/ui';
import { PageLoader } from '../../components/feedback/PageLoader';
import { useAuth } from './AuthProvider';
import { REDIRECT_PARAM, loginPathFor, safeRedirectPath } from './redirect';

/** Router state passed to /login when a session ended on the server. */
export interface LoginLocationState {
  sessionExpired?: boolean;
}

/**
 * Wraps protected routes. Until `/auth/session` answers, only a loader renders,
 * so protected content never flashes. Signed-out visitors go to
 * `/login?redirect=<this page>`; someone who just signed out goes home.
 * If the check itself failed (API unreachable), say so instead of bouncing
 * to a sign-in page that can't work either.
 */
export function RequireAuth() {
  const { status, sessionEnd, checkFailed, retryCheck } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <PageLoader />;
  if (status === 'authenticated') return <Outlet />;
  if (checkFailed) {
    return (
      <Container size="narrow" className="py-section-sm">
        <ErrorState
          title="We couldn't check whether you're signed in"
          description="Wayora's servers didn't answer. Check your connection, then try again."
          action={
            <Button onClick={retryCheck} variant="secondary">
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          }
        />
      </Container>
    );
  }
  if (sessionEnd === 'signed-out') return <Navigate to="/" replace />;
  return (
    <Navigate
      to={loginPathFor(`${location.pathname}${location.search}${location.hash}`)}
      replace
      state={
        sessionEnd === 'expired'
          ? ({ sessionExpired: true } satisfies LoginLocationState)
          : undefined
      }
    />
  );
}

/** The validated `?redirect=` destination of the current auth page. */
export function useRedirectTarget(): string {
  const [params] = useSearchParams();
  return safeRedirectPath(params.get(REDIRECT_PARAM));
}

/**
 * Wraps /login and /register. Signed-in visitors (including someone who has
 * just signed in on this page) continue to the validated destination.
 */
export function RedirectIfSignedIn() {
  const { status } = useAuth();
  const target = useRedirectTarget();
  if (status === 'authenticated') return <Navigate to={target} replace />;
  if (status === 'loading') return <PageLoader />;
  return <Outlet />;
}
