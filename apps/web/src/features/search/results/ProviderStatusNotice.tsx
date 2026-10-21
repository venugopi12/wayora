import { FlaskConical, RotateCw } from 'lucide-react';
import type { SearchResponse } from '@wayora/contracts';
import { Alert, Button } from '@wayora/ui';

const answered = (s: SearchResponse['providerStatuses'][number]) =>
  s.status === 'success' || s.status === 'empty';

/**
 * Where these results came from: a demo-data line whenever demo providers
 * answered, and a warning naming any provider that didn't, with a retry.
 */
export function ProviderStatusNotice({
  response,
  onRetry,
  retrying,
}: {
  response: SearchResponse;
  onRetry: () => void;
  retrying: boolean;
}) {
  const failed = response.providerStatuses.filter((s) => !answered(s));
  const ok = response.providerStatuses.filter(answered);
  return (
    <div className="flex flex-col gap-3">
      {response.disclaimer ? (
        <p className="flex items-start gap-2 text-caption text-ink-secondary">
          <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            Demo data from {ok.map((s) => s.providerName).join(', ') || 'demo providers'}:
            illustrative prices and times, availability not checked, nothing bookable.
          </span>
        </p>
      ) : null}
      {failed.length > 0 ? (
        <Alert
          tone="warning"
          title="Some results may be missing"
          action={
            <Button variant="secondary" size="sm" onClick={onRetry} loading={retrying}>
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          }
        >
          <ul className="list-disc pl-5">
            {failed.map((s) => (
              <li key={s.providerId}>
                {s.providerName}: {s.message ?? 'did not answer.'}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
    </div>
  );
}
