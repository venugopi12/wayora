import type {
  ActivityCategory,
  ItineraryItem as ItineraryItemDto,
  LinkedBooking,
  PlannedTrip as PlannedTripDto,
  PlannedTripSummary,
  PlannerDestination,
  PlannerPreferences,
} from '@wayora/contracts';
import type {
  ActivityCategory as DbActivityCategory,
  BookingModel as Booking,
  ItineraryItemModel as ItineraryItem,
  PlannedTripModel as PlannedTrip,
} from '@wayora/database';
import { SERVICE_TYPE } from '../../utils/categories.js';
import { catalogDestination } from './catalog.js';
import { formatMinute, scheduleWarnings } from './schedule.js';

/** A `@db.Date` column (UTC midnight) as `YYYY-MM-DD`: no local-time conversion. */
export const dateOnly = (value: Date): string => value.toISOString().slice(0, 10);
/** `YYYY-MM-DD` as the Date Prisma writes to a `@db.Date` column. */
export const toDbDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every date from `start` to `end`, inclusive (`YYYY-MM-DD`). */
export function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  for (let t = toDbDate(start).getTime(); t <= toDbDate(end).getTime(); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export const toDbCategory = (c: ActivityCategory) => c.toUpperCase() as DbActivityCategory;
export const fromDbCategory = (c: DbActivityCategory) => c.toLowerCase() as ActivityCategory;

type BookingLink = Pick<
  Booking,
  'reference' | 'category' | 'status' | 'startsOn' | 'endsOn' | 'isDemo'
> | null;

export const LINKED_BOOKING_SELECT = {
  reference: true,
  category: true,
  status: true,
  startsOn: true,
  endsOn: true,
  isDemo: true,
} as const;

export function presentDestination(
  trip: Pick<PlannedTrip, 'destinationId' | 'destinationName'>,
): PlannerDestination {
  const curated = catalogDestination(trip.destinationId);
  return {
    id: curated?.id ?? null,
    name: curated?.name ?? trip.destinationName,
    country: curated?.country ?? null,
    timeZone: curated?.timeZone ?? null,
    hasSuggestions: curated !== null,
  };
}

function presentBooking(booking: BookingLink): LinkedBooking | null {
  if (!booking) return null;
  return {
    reference: booking.reference,
    category: SERVICE_TYPE[booking.category],
    status: booking.status.toLowerCase() as LinkedBooking['status'],
    startsOn: booking.startsOn ? dateOnly(booking.startsOn) : null,
    endsOn: booking.endsOn ? dateOnly(booking.endsOn) : null,
    demo: booking.isDemo,
  };
}

export function presentPreferences(
  trip: Pick<PlannedTrip, 'pace' | 'budget' | 'groupType' | 'interests'>,
): PlannerPreferences {
  return {
    pace: trip.pace ? (trip.pace.toLowerCase() as PlannerPreferences['pace']) : null,
    budget: trip.budget ? (trip.budget.toLowerCase() as PlannerPreferences['budget']) : null,
    group: trip.groupType ? (trip.groupType.toLowerCase() as PlannerPreferences['group']) : null,
    interests: (trip.interests ?? []).map(
      (c) => c.toLowerCase() as PlannerPreferences['interests'][number],
    ),
  };
}

export function presentItem(item: ItineraryItem): ItineraryItemDto {
  const end =
    item.startMinute !== null && item.durationMinutes !== null
      ? item.startMinute + item.durationMinutes
      : null;
  return {
    id: item.id,
    day: dateOnly(item.day),
    position: item.position,
    title: item.title,
    category: fromDbCategory(item.category),
    startTime: item.startMinute !== null ? formatMinute(item.startMinute) : null,
    durationMinutes: item.durationMinutes,
    endTime: end !== null ? formatMinute(end) : null,
    endsNextDay: end !== null && end > 24 * 60,
    location: item.location,
    notes: item.notes,
    suggestionId: item.suggestionId,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

export function presentSummary(
  trip: PlannedTrip & { booking: BookingLink; _count: { items: number } },
): PlannedTripSummary {
  const startDate = dateOnly(trip.startDate);
  const endDate = dateOnly(trip.endDate);
  return {
    id: trip.id,
    title: trip.title,
    destination: presentDestination(trip),
    startDate,
    endDate,
    dayCount: datesBetween(startDate, endDate).length,
    itemCount: trip._count.items,
    linkedBooking: presentBooking(trip.booking),
    createdAt: trip.createdAt.toISOString(),
    updatedAt: trip.updatedAt.toISOString(),
  };
}

/** The full trip: days in order, activities in saved order, warnings. */
export function presentTrip(
  trip: PlannedTrip & { booking: BookingLink; items: ItineraryItem[] },
): PlannedTripDto {
  const startDate = dateOnly(trip.startDate);
  const endDate = dateOnly(trip.endDate);
  const items = trip.items
    .map(presentItem)
    .sort((a, b) => (a.day === b.day ? a.position - b.position : a.day < b.day ? -1 : 1));
  const dates = datesBetween(startDate, endDate);
  const days = dates.map((date, index) => ({
    date,
    dayNumber: index + 1,
    items: items.filter((i) => i.day === date),
  }));
  return {
    ...presentSummary({ ...trip, _count: { items: trip.items.length } }),
    version: trip.version,
    notes: trip.notes,
    preferences: presentPreferences(trip),
    days,
    outsideDates: items.filter((i) => i.day < startDate || i.day > endDate),
    warnings: scheduleWarnings(
      trip.items.map((i) => ({
        id: i.id,
        day: dateOnly(i.day),
        position: i.position,
        title: i.title,
        startMinute: i.startMinute,
        durationMinutes: i.durationMinutes,
      })),
      { startDate, endDate },
    ),
    travelTimeValidated: false,
  };
}
