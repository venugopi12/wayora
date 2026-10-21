import type { HotelResult } from '@wayora/contracts';
import { Badge } from '@wayora/ui';
import { formatDay } from '../summary';
import { Chips, ResultCardShell } from './shared';

export const AMENITY_LABELS: Record<HotelResult['amenities'][number], string> = {
  wifi: 'Wi-Fi',
  breakfast: 'Breakfast',
  pool: 'Pool',
  spa: 'Spa',
  parking: 'Parking',
  gym: 'Gym',
};

export const propertyTypeLabel = (type: HotelResult['property']['propertyType']) =>
  type.charAt(0).toUpperCase() + type.slice(1);

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export function HotelResultCard({ result, href }: { result: HotelResult; href: string }) {
  const { property } = result;
  return (
    <ResultCardShell
      result={result}
      href={href}
      heading={property.name}
      subheading={[property.area, property.cityName].filter(Boolean).join(', ')}
      meta={
        <Badge size="sm" tone="neutral">
          {propertyTypeLabel(property.propertyType)}
        </Badge>
      }
      body={
        <div className="flex flex-col gap-3">
          <p className="text-body-sm text-ink">
            {result.roomType} · {formatDay(result.checkIn)} – {formatDay(result.checkOut)} ·{' '}
            {plural(result.nights, 'night')} · {plural(result.rooms, 'room')} ·{' '}
            {plural(result.guests, 'guest')}
          </p>
          <Chips
            items={[
              ...(result.breakfastIncluded ? ['Breakfast included'] : []),
              ...result.amenities
                .filter((a) => !(a === 'breakfast' && result.breakfastIncluded))
                .map((a) => AMENITY_LABELS[a]),
            ]}
          />
        </div>
      }
    />
  );
}
