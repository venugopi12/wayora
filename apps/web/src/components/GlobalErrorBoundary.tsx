import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@wayora/ui';
import { FullPageMessage } from './feedback/FullPageMessage';

interface State {
  error: Error | null;
}

/**
 * Last line of defence for render errors outside the router (providers, router
 * construction). Route-level errors are handled by RouteErrorBoundary.
 */
export class GlobalErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Later phases: forward to an error-reporting service. Never include user PII.
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.error('Unhandled UI error', error, info.componentStack);
    }
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <FullPageMessage
        code="Something went wrong"
        title="Wayora couldn't load"
        description="The page failed to start. Reload to try again. If it keeps happening, the problem is on our side."
        actions={<Button onClick={() => window.location.reload()}>Reload page</Button>}
      />
    );
  }
}
