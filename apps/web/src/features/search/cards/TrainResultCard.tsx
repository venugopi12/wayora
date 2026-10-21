import type { TrainResult } from '@wayora/contracts';
import { Badge, JourneySummary } from '@wayora/ui';
import { formatDay } from '../summary';
import { ResultCardShell, dayOffset, localDate, localTime } from './shared';

export function TrainResultCard({ result, href }: { result: TrainResult; href: string }) {
  return (
    <ResultCardShell
      result={result}
      href={href}
      heading={`${result.trainName} (${result.trainNumber})`}
      subheading={formatDay(localDate(result.departAt))}
      meta={
        <Badge
          size="sm"
          tone="neutral"
        >{`${result.travelClass.name} (${result.travelClass.code})`}</Badge>
      }
      body={
        <JourneySummary
          mode="train"
          origin={{
            name: result.origin.name,
            code: result.origin.code ?? undefined,
            time: localTime(result.departAt),
            dateTime: result.departAt,
          }}
          destination={{
            name: result.destination.name,
            code: result.destination.code ?? undefined,
            time: localTime(result.arriveAt),
            dateTime: result.arriveAt,
          }}
          durationMinutes={result.durationMinutes}
          dayOffset={dayOffset(result.departAt, result.arriveAt) || undefined}
        />
      }
    />
  );
}
