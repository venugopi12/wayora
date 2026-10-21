import {
  BedDouble,
  Bus,
  CarTaxiFront,
  Plane,
  TrainFront,
  TrainFrontTunnel,
  TreePalm,
  type LucideIcon,
} from 'lucide-react';
import type { TravelCategorySlug } from '@wayora/contracts';

export const categoryIcons: Record<TravelCategorySlug, LucideIcon> = {
  flights: Plane,
  hotels: BedDouble,
  trains: TrainFront,
  buses: Bus,
  metro: TrainFrontTunnel,
  cabs: CarTaxiFront,
  holidays: TreePalm,
};
