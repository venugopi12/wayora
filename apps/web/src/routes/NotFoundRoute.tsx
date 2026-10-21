import { Link } from 'react-router';
import { Button } from '@wayora/ui';
import { FullPageMessage } from '../components/feedback/FullPageMessage';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function NotFoundRoute() {
  useDocumentTitle('Page not found');
  return (
    <FullPageMessage
      code="404"
      title="This page isn't on the map"
      description="The address may be mistyped, or the page may not exist yet. Booking pages arrive in later phases."
      actions={
        <Button asChild>
          <Link to="/">Go to the home page</Link>
        </Button>
      }
    />
  );
}
