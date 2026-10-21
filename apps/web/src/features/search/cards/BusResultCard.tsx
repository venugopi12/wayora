import type { BusResult } from '@wayora/contracts';
import { Badge, JourneySummary } from '@wayora/ui';
import { formatDay } from '../summary';
import { Chips, ResultCardShell, dayOffset, localDate, localTime } from './shared';

export const BUS_TYPE_LABELS: Record<BusResult['busType'], string> = {
  'ac-sleeper': 'AC sleeper',
  'ac-seater': 'AC seater',
  'non-ac-sleeper': 'Non-AC sleeper',
  'non-ac-seater': 'Non-AC seater',
};

export function BusResultCard({ result, href }: { result: BusResult; href: string }) {
  return (
    <ResultCardShell
      result={result}
      href={href}
      heading={result.operatorName}
      subheading={formatDay(localDate(result.departAt))}
      meta={
        <Badge size="sm" tone="neutral">
          {BUS_TYPE_LABELS[result.busType]}
        </Badge>
      }
      body={
        <div className="flex flex-col gap-3">
          <JourneySummary
            mode="bus"
            origin={{
              name: result.origin.cityName,
              time: localTime(result.departAt),
              dateTime: result.departAt,
              detail: result.origin.name,
            }}
            destination={{
              name: result.destination.cityName,
              time: localTime(result.arriveAt),
              dateTime: result.arriveAt,
              detail: result.destination.name,
            }}
            durationMinutes={result.durationMinutes}
            dayOffset={dayOffset(result.departAt, result.arriveAt) || undefined}
          />
          <Chips items={result.amenities} />
        </div>
      }
    />
  );
}
