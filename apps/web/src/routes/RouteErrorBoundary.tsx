import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { Button } from '@wayora/ui';
import { FullPageMessage } from '../components/feedback/FullPageMessage';
import { NotFoundRoute } from './NotFoundRoute';

/** Router-level error element: 404s render the not-found page; everything else a recoverable error. */
export function RouteErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundRoute />;

  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.error('Route error', error);
  }

  return (
    <FullPageMessage
      code="Something went wrong"
      title="This page didn't load"
      description="Something failed while showing this page. Go back to the home page or reload to try again."
      actions={
        <>
          <Button asChild>
            <Link to="/">Go to the home page</Link>
          </Button>
          <Button variant="secondary" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </>
      }
    />
  );
}
