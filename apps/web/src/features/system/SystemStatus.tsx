import { RefreshCw } from 'lucide-react';
import type { DependencyHealth, ReadinessStatus } from '@wayora/contracts';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  ErrorState,
  PageHeader,
  Section,
  Skeleton,
  Spinner,
} from '@wayora/ui';
import { publicEnv } from '../../lib/env';
import { useReadiness } from './useReadiness';

const overall: Record<ReadinessStatus, { tone: BadgeTone; label: string; summary: string }> = {
  ready: {
    tone: 'success',
    label: 'Ready',
    summary: 'All services the API depends on are responding.',
  },
  degraded: {
    tone: 'warning',
    label: 'Degraded',
    summary: 'The API is serving requests, but an optional service is down.',
  },
  unready: {
    tone: 'danger',
    label: 'Not ready',
    summary: 'The database is unavailable, so the API cannot serve data requests.',
  },
};

const stateTone: Record<DependencyHealth['state'], BadgeTone> = {
  up: 'success',
  down: 'danger',
  disabled: 'neutral',
};
const stateLabel: Record<DependencyHealth['state'], string> = {
  up: 'Up',
  down: 'Down',
  disabled: 'Off',
};
const dependencyLabel: Record<string, string> = { postgres: 'PostgreSQL', redis: 'Redis' };

/** Live readiness of the API and its dependencies, for the foundation build. */
export function SystemStatus({ headingLevel = 'h2' }: { headingLevel?: 'h1' | 'h2' }) {
  const { data, isPending, isError, refetch, isFetching, dataUpdatedAt } = useReadiness();

  return (
    <Section
      id="status"
      tone="sunken"
      spacing="sm"
      aria-labelledby="status-title"
      className="scroll-mt-(--header-offset)"
    >
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] lg:gap-16">
        <PageHeader
          id="status-title"
          headingLevel={headingLevel}
          title="Platform status"
          description="A live check of the API and the services behind it. PostgreSQL is required; Redis is optional and only slows things down when it's missing."
        />

        <Card padding="lg">
          <div className="flex items-center justify-between gap-3">
            <div aria-live="polite" className="flex items-center gap-3">
              {isPending ? (
                <>
                  <Spinner label="" className="text-brand" />
                  <span className="text-body-sm text-ink-secondary">Checking the API…</span>
                </>
              ) : data ? (
                <Badge tone={overall[data.status].tone} dot>
                  {overall[data.status].label}
                </Badge>
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refetch()}
              disabled={isFetching}
              aria-label="Check status again"
              leadingIcon={
                <RefreshCw className={isFetching ? 'animate-spin' : undefined} aria-hidden="true" />
              }
            >
              Refresh
            </Button>
          </div>
          {data ? (
            <p className="mt-3 text-body-sm text-ink-secondary">{overall[data.status].summary}</p>
          ) : isPending ? (
            // Reserves the summary line so the card doesn't grow when data arrives.
            <Skeleton shape="text" lines={1} className="mt-4 mb-1 max-w-80" />
          ) : null}

          {isError ? (
            <ErrorState
              className="mt-5"
              title="The API isn't responding"
              description={
                <>
                  Nothing answered at {publicEnv.apiBaseUrl}. Start it with{' '}
                  <code className="rounded-xs bg-card px-1 py-0.5 font-mono text-caption">
                    npm run dev:api
                  </code>{' '}
                  and refresh.
                </>
              }
            />
          ) : null}

          {isPending ? (
            // Placeholder rows matching the two dependencies (PostgreSQL, Redis),
            // so the card keeps its height when the check completes.
            <ul aria-hidden="true" className="mt-5 divide-y divide-line border-t border-line">
              {[0, 1].map((i) => (
                <li key={i} className="flex items-center justify-between gap-4 py-4">
                  <div className="flex flex-1 flex-col gap-2 py-0.5">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-3.5 w-40" />
                  </div>
                  <Skeleton className="h-6 w-12 rounded-full" />
                </li>
              ))}
            </ul>
          ) : null}

          {data ? (
            <ul className="mt-5 divide-y divide-line border-t border-line">
              {data.dependencies.map((dep) => (
                <li key={dep.name} className="flex items-center justify-between gap-4 py-4">
                  <div className="min-w-0">
                    <p className="text-label text-ink">{dependencyLabel[dep.name] ?? dep.name}</p>
                    <p className="numeric text-body-sm break-words text-ink-secondary">
                      {dep.essential ? 'Required' : 'Optional'}
                      {dep.latencyMs !== undefined && dep.state === 'up'
                        ? `, ${dep.latencyMs} ms`
                        : ''}
                      {dep.error ? `, ${dep.error}` : ''}
                    </p>
                  </div>
                  <Badge tone={stateTone[dep.state]} size="sm">
                    {stateLabel[dep.state]}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}

          {dataUpdatedAt > 0 ? (
            <p className="mt-3 text-caption text-ink-secondary">
              Checked at {new Date(dataUpdatedAt).toLocaleTimeString()}
            </p>
          ) : isPending ? (
            <Skeleton className="mt-4 h-3 w-32" />
          ) : null}
        </Card>
      </div>
    </Section>
  );
}
