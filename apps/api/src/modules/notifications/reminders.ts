import type { PrismaClient } from '@wayora/database';
import { BOOKING_CALENDAR_TIME_ZONE } from '../bookings/bookings.service.js';
import { TripsService } from '../trips/trips.service.js';
import { notify } from './notify.js';

/*
 * Travel reminders (docs/notifications.md#events): one notification per
 * confirmed booking, the day before it starts (India calendar, like every
 * booking date rule). Run periodically by the API (server.ts); the dedupe key
 * makes repeated runs, and several API instances, harmless.
 *
 * Each reminder also goes on the trip timeline (Phase 17, docs/trips.md), and
 * stays get a timeline-only check-out reminder the day before they end.
 */

const dayFormat = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** YYYY-MM-DD in the booking calendar, `days` from `now`. */
function calendarDay(now: Date, days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: BOOKING_CALENDAR_TIME_ZONE }).format(
    now,
  );
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function createTravelReminders(prisma: PrismaClient, now: Date): Promise<number> {
  const tomorrow = new Date(`${calendarDay(now, 1)}T00:00:00Z`);
  const due = await prisma.booking.findMany({
    where: {
      status: 'CONFIRMED',
      startsOn: tomorrow,
      notifications: { none: { type: 'TRAVEL_REMINDER' } },
    },
    select: { id: true, reference: true, userId: true, isDemo: true },
    take: 500,
  });
  let created = 0;
  for (const booking of due) {
    const made = await prisma.$transaction(async (tx) => {
      // Still confirmed now (it may have been cancelled since the query).
      const current = await tx.booking.findUnique({
        where: { id: booking.id },
        select: { status: true },
      });
      if (current?.status !== 'CONFIRMED') return false;
      await TripsService.reminder(tx, {
        bookingId: booking.id,
        type: 'TRAVEL_REMINDER',
        on: calendarDay(now, 1),
        now,
      });
      return notify(tx, now, {
        type: 'TRAVEL_REMINDER',
        title: booking.isDemo ? 'Your demo trip is tomorrow' : 'Your trip is tomorrow',
        message: booking.isDemo
          ? `Booking ${booking.reference} starts on ${dayFormat.format(tomorrow)}. It is a demo booking: no ticket or supplier reservation exists, so there is nothing to show when you travel.`
          : `Booking ${booking.reference} starts on ${dayFormat.format(tomorrow)}.`,
        userId: booking.userId,
        isDemo: booking.isDemo,
        bookingId: booking.id,
        dedupeKey: `booking:${booking.id}:REMINDER`,
      });
    });
    if (made) created += 1;
  }

  // Stays: check-out tomorrow (timeline only; the trip itself is underway).
  const checkingOut = await prisma.booking.findMany({
    where: {
      status: 'CONFIRMED',
      category: 'HOTEL',
      endsOn: tomorrow,
      tripEvents: { none: { type: 'CHECK_OUT_REMINDER' } },
    },
    select: { id: true },
    take: 500,
  });
  for (const booking of checkingOut) {
    const made = await prisma.$transaction(async (tx) => {
      const current = await tx.booking.findUnique({
        where: { id: booking.id },
        select: { status: true },
      });
      if (current?.status !== 'CONFIRMED') return false;
      return TripsService.reminder(tx, {
        bookingId: booking.id,
        type: 'CHECK_OUT_REMINDER',
        on: calendarDay(now, 1),
        now,
      });
    });
    if (made) created += 1;
  }
  return created;
}
