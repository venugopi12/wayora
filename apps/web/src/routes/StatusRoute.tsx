import { SystemStatus } from '../features/system/SystemStatus';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

/** /status — live API readiness (moved off the consumer homepage in Phase 4). */
export function StatusRoute() {
  useDocumentTitle('Platform status');
  return <SystemStatus headingLevel="h1" />;
}
