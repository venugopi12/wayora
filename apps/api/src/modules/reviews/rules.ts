import {
  ASPECTS_FOR,
  MIN_ASPECT_RATINGS_FOR_AVERAGE,
  MIN_REVIEWS_FOR_AVERAGE,
  REVIEW_ASPECTS,
  REVIEW_EDIT_DAYS,
  reviewSubjectOf,
  type RatingSummary,
  type ReviewAspect,
  type ReviewStatus,
  type ReviewSubject,
  type ReviewSubjectType,
  type ReviewVerification,
  type SearchResult,
} from '@wayora/contracts';

/*
 * Pure review rules (docs/reviews.md): booking eligibility, the public rating
 * maths, display names and the edit window. No database access, so they're
 * unit-tested directly.
 */

const IST = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
/** Today's date in India (YYYY-MM-DD): stays and trips are dated in local days. */
export const indiaDay = (at: Date) => IST.format(at);

/** YYYY-MM-DD plus n days. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export interface EligibilityBooking {
  userId: string;
  category: string; // TravelCategory (database enum)
  status: string; // BookingStatus
  isDemo: boolean;
  startsOn: Date | null;
  endsOn: Date | null;
  /** The parsed snapshot's offer; null if the snapshot can't be read. */
  offer: Pick<SearchResult, 'serviceType' | 'providerId' | 'offerRef'> | null;
  hasRefund: boolean;
  /** The supplier reservation's status, for non-demo bookings. */
  reservationStatus: string | null;
}

export type Eligibility =
  | {
      state: 'eligible';
      subject: ReviewSubject;
      verification: Extract<ReviewVerification, 'verified_booking' | 'demo_booking'>;
      travelFrom: string;
      travelTo: string | null;
    }
  | {
      state: 'not_yet';
      subject: ReviewSubject;
      eligibleFrom: string;
      reason: string;
    }
  | { state: 'not_eligible'; subject: ReviewSubject | null; reason: string };

const REVIEWABLE_CATEGORIES = new Set(['HOTEL', 'HOLIDAY_PACKAGE']);

/**
 * Whether the owner may review this booking now (docs/reviews.md#eligibility).
 * Ownership is checked by the caller first (anyone else's booking is a 404).
 */
export function bookingEligibility(b: EligibilityBooking, now: Date): Eligibility {
  if (!REVIEWABLE_CATEGORIES.has(b.category)) {
    return {
      state: 'not_eligible',
      subject: null,
      reason: 'Only hotel stays and holiday packages can be reviewed.',
    };
  }
  const subject = b.offer ? reviewSubjectOf(b.offer) : null;
  if (!subject) {
    return {
      state: 'not_eligible',
      subject: null,
      reason: 'This property or package can’t be identified reliably, so it can’t be reviewed.',
    };
  }
  if (b.status !== 'CONFIRMED') {
    return {
      state: 'not_eligible',
      subject,
      reason:
        b.status === 'CANCELLED'
          ? 'Cancelled bookings can’t be reviewed.'
          : 'Only completed, confirmed bookings can be reviewed.',
    };
  }
  if (b.hasRefund) {
    return { state: 'not_eligible', subject, reason: 'Refunded bookings can’t be reviewed.' };
  }
  if (!b.isDemo && b.reservationStatus !== 'CONFIRMED') {
    return {
      state: 'not_eligible',
      subject,
      reason: 'The supplier hasn’t confirmed this booking, so it can’t be reviewed.',
    };
  }
  const start = b.startsOn ? isoDay(b.startsOn) : null;
  const end = b.endsOn ? isoDay(b.endsOn) : start;
  if (!start || !end) {
    return {
      state: 'not_eligible',
      subject,
      reason: 'This booking has no travel dates, so it can’t be reviewed.',
    };
  }
  const eligibleFrom = addDays(end, 1);
  if (indiaDay(now) < eligibleFrom) {
    return {
      state: 'not_yet',
      subject,
      eligibleFrom,
      reason:
        subject.type === 'hotel'
          ? 'You can review your stay from the day after you check out.'
          : 'You can review your trip from the day after it ends.',
    };
  }
  return {
    state: 'eligible',
    subject,
    verification: b.isDemo ? 'demo_booking' : 'verified_booking',
    travelFrom: start,
    travelTo: b.endsOn ? isoDay(b.endsOn) : null,
  };
}

/** Aspects outside the subject's set are refused (not silently dropped). */
export function unexpectedAspects(
  type: ReviewSubjectType,
  aspects: Partial<Record<ReviewAspect, number>>,
): ReviewAspect[] {
  const allowed = new Set(ASPECTS_FOR[type]);
  return (Object.keys(aspects) as ReviewAspect[]).filter((a) => !allowed.has(a));
}

/** "Asha Rao" → "Asha R."; no name → "Wayora traveller". Never an email. */
export function publicAuthorName(displayName: string | null): string {
  const parts = (displayName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Wayora traveller';
  const first = parts[0]!.slice(0, 40);
  const lastInitial =
    parts.length > 1 ? ` ${parts[parts.length - 1]!.charAt(0).toUpperCase()}.` : '';
  return `${first}${lastInitial}`;
}

/** One decimal, half up; computed in tenths with integers. */
export function averageOf(sum: number, count: number): number {
  return Math.round((sum * 10) / count) / 10;
}

export interface SummaryInput {
  subject: ReviewSubject;
  /** Counted reviews per star rating (1–5). */
  byRating: Map<number, number>;
  byVerification: Partial<Record<ReviewVerification, number>>;
  /** Per aspect: how many counted reviews rated it, and the sum of those ratings. */
  aspects: Partial<Record<ReviewAspect, { count: number; sum: number }>>;
}

/**
 * The public rating summary (docs/reviews.md#ratings). The average appears
 * only with at least MIN_REVIEWS_FOR_AVERAGE counted reviews; each aspect's
 * average only with MIN_ASPECT_RATINGS_FOR_AVERAGE ratings of it.
 */
export function ratingSummary(input: SummaryInput): RatingSummary {
  const distribution = [1, 2, 3, 4, 5].map((r) => input.byRating.get(r) ?? 0) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const count = distribution.reduce((a, b) => a + b, 0);
  const sum = distribution.reduce((a, n, i) => a + n * (i + 1), 0);
  return {
    subject: input.subject,
    count,
    average: count >= MIN_REVIEWS_FOR_AVERAGE ? averageOf(sum, count) : null,
    distribution,
    aspects: ASPECTS_FOR[input.subject.type].map((aspect) => {
      const a = input.aspects[aspect] ?? { count: 0, sum: 0 };
      return {
        aspect,
        count: a.count,
        average: a.count >= MIN_ASPECT_RATINGS_FOR_AVERAGE ? averageOf(a.sum, a.count) : null,
      };
    }),
    byVerification: {
      verified_booking: input.byVerification.verified_booking ?? 0,
      demo_booking: input.byVerification.demo_booking ?? 0,
      unverified: input.byVerification.unverified ?? 0,
    },
    minimumForAverage: MIN_REVIEWS_FOR_AVERAGE,
  };
}

/** Until when the author may edit; null when they can't (removed, flagged, or the window closed). */
export function editableUntil(
  review: { status: ReviewStatus; createdAt: Date },
  now: Date,
): Date | null {
  if (review.status === 'removed' || review.status === 'flagged') return null;
  const until = new Date(review.createdAt.getTime() + REVIEW_EDIT_DAYS * 24 * 3600 * 1000);
  return until.getTime() > now.getTime() ? until : null;
}

/** Database column per aspect (all nullable smallints). */
export const ASPECT_COLUMNS = REVIEW_ASPECTS;
