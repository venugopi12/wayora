import type { HolidayResult } from '@wayora/contracts';
import { Badge } from '@wayora/ui';
import { formatDay } from '../summary';
import { Chips, ResultCardShell } from './shared';

export const interestLabel = (i: HolidayResult['interests'][number]) =>
  i.charAt(0).toUpperCase() + i.slice(1);

export function HolidayResultCard({ result, href }: { result: HolidayResult; href: string }) {
  return (
    <ResultCardShell
      result={result}
      href={href}
      heading={result.packageName}
      subheading={`${result.destination.name} · ${formatDay(result.startDate)} – ${formatDay(result.endDate)}`}
      meta={<Badge size="sm" tone="neutral">{`${result.nights} nights`}</Badge>}
      body={
        <div className="flex flex-col gap-3">
          <p className="text-body-sm text-ink">
            {result.travellers} traveller{result.travellers === 1 ? '' : 's'} · Includes{' '}
            {result.inclusions.slice(0, 2).join(', ').toLowerCase()}
            {result.inclusions.length > 2 ? ` and ${result.inclusions.length - 2} more` : ''}
          </p>
          <Chips items={result.interests.map(interestLabel)} />
        </div>
      }
    />
  );
}
