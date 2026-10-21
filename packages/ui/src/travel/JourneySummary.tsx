import {
  BusFront,
  CarTaxiFront,
  Plane,
  TrainFront,
  TrainFrontTunnel,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { formatDuration, formatDurationLong, plural } from '../lib/format';

export type TransportMode = 'flight' | 'train' | 'bus' | 'metro' | 'cab';

export interface JourneyPoint {
  /** City or station name. */
  name: string;
  /** IATA / station code, e.g. "BLR", "NDLS". */
  code?: string;
  /** Local time for display, e.g. "06:45". */
  time?: string;
  /** ISO datetime for the <time> element. */
  dateTime?: string;
  /** Terminal, platform or stop detail. */
  detail?: string;
}

export interface JourneySummaryProps {
  mode: TransportMode;
  origin: JourneyPoint;
  destination: JourneyPoint;
  durationMinutes?: number;
  /** 0 = direct. */
  stops?: number;
  /** Carrier or operator, e.g. "IndiGo 6E 2134". */
  operator?: string;
  /** Shown when arrival is on a later day, e.g. "+1". */
  dayOffset?: number;
  className?: string;
}

const modeIcons: Record<TransportMode, LucideIcon> = {
  flight: Plane,
  train: TrainFront,
  bus: BusFront,
  metro: TrainFrontTunnel,
  cab: CarTaxiFront,
};
const modeNames: Record<TransportMode, string> = {
  flight: 'Flight',
  train: 'Train',
  bus: 'Bus',
  metro: 'Metro',
  cab: 'Cab',
};

function Point({
  point,
  align,
  dayOffset,
}: {
  point: JourneyPoint;
  align: 'start' | 'end';
  dayOffset?: number;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col', align === 'end' && 'items-end text-end')}>
      {point.time ? (
        <span className="flex items-start gap-0.5">
          <time dateTime={point.dateTime} className="numeric text-numeric-lg text-ink">
            {point.time}
          </time>
          {dayOffset ? (
            <span className="numeric text-caption font-semibold text-warning-ink">
              {dayOffset > 0 ? `+${dayOffset}` : dayOffset}
            </span>
          ) : null}
        </span>
      ) : null}
      <span className="flex items-baseline gap-1.5">
        {point.code ? <span className="numeric text-label text-ink">{point.code}</span> : null}
        <span className="truncate text-body-sm text-ink-secondary">{point.name}</span>
      </span>
      {point.detail ? (
        <span className="text-caption text-ink-secondary">{point.detail}</span>
      ) : null}
    </div>
  );
}

/**
 * Origin → destination for any point-to-point journey. Visual layout is
 * hidden from screen readers in favour of one complete sentence.
 */
export function JourneySummary({
  mode,
  origin,
  destination,
  durationMinutes,
  stops,
  operator,
  dayOffset,
  className,
}: JourneySummaryProps) {
  const Icon = modeIcons[mode];
  const stopsText =
    stops === undefined ? undefined : stops === 0 ? 'Direct' : plural(stops, 'stop');
  const spoken = [
    `${modeNames[mode]}${operator ? ` ${operator}` : ''} from ${origin.name}${origin.time ? ` at ${origin.time}` : ''}`,
    `to ${destination.name}${destination.time ? ` arriving ${destination.time}` : ''}${dayOffset ? ` (${dayOffset > 0 ? '+' : ''}${dayOffset} day)` : ''}`,
    durationMinutes !== undefined ? formatDurationLong(durationMinutes) : '',
    stopsText ?? '',
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <p className="sr-only">{spoken}</p>
      <div
        aria-hidden="true"
        className="grid grid-cols-[minmax(0,1fr)_minmax(5rem,1.4fr)_minmax(0,1fr)] items-center gap-3"
      >
        <Point point={origin} align="start" />
        <div className="flex flex-col items-center gap-1.5">
          {durationMinutes !== undefined ? (
            <span className="numeric text-caption text-ink-secondary">
              {formatDuration(durationMinutes)}
            </span>
          ) : null}
          <div className="flex w-full items-center gap-1.5 text-brand">
            <span className="size-1.5 rounded-full bg-current" />
            <span className="h-px flex-1 bg-line-strong" />
            <Icon className="size-4" strokeWidth={1.75} />
            <span className="h-px flex-1 bg-line-strong" />
            <span className="size-1.5 rounded-full bg-current" />
          </div>
          {stopsText ? (
            <span
              className={cn(
                'text-caption',
                stops === 0 ? 'text-success-ink' : 'text-ink-secondary',
              )}
            >
              {stopsText}
            </span>
          ) : null}
        </div>
        <Point point={destination} align="end" dayOffset={dayOffset} />
      </div>
      {operator ? (
        <p aria-hidden="true" className="text-caption text-ink-secondary">
          {operator}
        </p>
      ) : null}
    </div>
  );
}
