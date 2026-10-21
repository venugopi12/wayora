import type { MetroResult } from '@wayora/contracts';
import { Badge, formatDuration } from '@wayora/ui';
import { ResultCardShell } from './shared';

export const changesLabel = (n: number) =>
  n === 0 ? 'No changes' : `${n} change${n === 1 ? '' : 's'}`;

/** The lines of a journey, in order, as coloured pills. */
export function LineSequence({ legs }: { legs: MetroResult['legs'] }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5" aria-label="Lines">
      {legs.map((leg, i) => (
        <li key={`${leg.line.id}-${i}`} className="flex items-center gap-1.5 text-body-sm">
          {i > 0 ? (
            <span aria-hidden="true" className="text-ink-subtle">
              →
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5">
            <span
              aria-hidden="true"
              className="size-2.5 rounded-full"
              style={{ backgroundColor: leg.line.colour }}
            />
            {leg.line.name}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function MetroResultCard({ result, href }: { result: MetroResult; href: string }) {
  return (
    <ResultCardShell
      result={result}
      href={href}
      heading={`${result.origin.name} to ${result.destination.name}`}
      subheading={result.cityName}
      meta={
        <Badge size="sm" tone="neutral">
          {changesLabel(result.transfers)}
        </Badge>
      }
      body={
        <div className="flex flex-col gap-2">
          <LineSequence legs={result.legs} />
          <p className="text-body-sm text-ink">
            About {formatDuration(result.durationMinutes)}{' '}
            <span className="text-ink-secondary">(estimate; no timetable in the demo)</span>
          </p>
        </div>
      }
    />
  );
}
