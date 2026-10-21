import type { CabResult } from '@wayora/contracts';
import { Badge, formatDuration } from '@wayora/ui';
import { formatDay } from '../summary';
import { ResultCardShell, localDate, localTime } from './shared';

export function CabResultCard({ result, href }: { result: CabResult; href: string }) {
  return (
    <ResultCardShell
      result={result}
      href={href}
      heading={result.vehicleLabel}
      subheading={`${result.pickup.name} to ${result.dropoff.name}`}
      meta={<Badge size="sm" tone="neutral">{`Up to ${result.capacity} passengers`}</Badge>}
      body={
        <p className="text-body-sm text-ink">
          Pick-up {formatDay(localDate(result.pickupAt))}, {localTime(result.pickupAt)} · about{' '}
          {result.distanceKm} km · about {formatDuration(result.durationMinutes)} in normal traffic
        </p>
      }
    />
  );
}
