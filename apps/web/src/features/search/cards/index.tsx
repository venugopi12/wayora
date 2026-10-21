import type { SearchResult } from '@wayora/contracts';
import { BusResultCard } from './BusResultCard';
import { CabResultCard } from './CabResultCard';
import { FlightResultCard } from './FlightResultCard';
import { HolidayResultCard } from './HolidayResultCard';
import { HotelResultCard } from './HotelResultCard';
import { MetroResultCard } from './MetroResultCard';
import { TrainResultCard } from './TrainResultCard';

/** The category's own card for a result; `href` is its offer page. */
export function ResultCard({ result, href }: { result: SearchResult; href: string }) {
  switch (result.serviceType) {
    case 'flights':
      return <FlightResultCard result={result} href={href} />;
    case 'hotels':
      return <HotelResultCard result={result} href={href} />;
    case 'trains':
      return <TrainResultCard result={result} href={href} />;
    case 'buses':
      return <BusResultCard result={result} href={href} />;
    case 'metro':
      return <MetroResultCard result={result} href={href} />;
    case 'cabs':
      return <CabResultCard result={result} href={href} />;
    case 'holidays':
      return <HolidayResultCard result={result} href={href} />;
  }
}
