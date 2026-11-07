import { describe, expect, it } from 'vitest';
import {
  MODERATION_FROM,
  canModerate,
  createReviewSchema,
  moderateReviewSchema,
  reportReviewSchema,
  reviewSubjectOf,
  type ReviewStatus,
} from '@wayora/contracts';
import {
  addDays,
  averageOf,
  bookingEligibility,
  editableUntil,
  indiaDay,
  publicAuthorName,
  ratingSummary,
  unexpectedAspects,
  type EligibilityBooking,
} from '../src/modules/reviews/rules.js';

/*
 * Pure review rules (docs/reviews.md): eligibility, the public rating maths,
 * names, the edit window, subject identity and input validation.
 */

const stay = (over: Partial<EligibilityBooking> = {}): EligibilityBooking => ({
  userId: 'u1',
  category: 'HOTEL',
  status: 'CONFIRMED',
  isDemo: true,
  startsOn: new Date('2026-11-01T00:00:00Z'),
  endsOn: new Date('2026-11-04T00:00:00Z'),
  offer: {
    serviceType: 'hotels',
    providerId: 'demo-hotels',
    offerRef: 'goa-casa-lagoa/2026-11-01/2026-11-04/1',
  },
  hasRefund: false,
  reservationStatus: null,
  ...over,
});

describe('booking eligibility', () => {
  // 18:00 UTC on 4 Nov is 23:30 on 4 Nov in India; 18:31 UTC is already 5 Nov there.
  const checkoutEvening = new Date('2026-11-04T18:00:00Z');
  const dayAfter = new Date('2026-11-04T18:31:00Z');

  it('opens the day after checkout, in India time, as a demo booking for demo stays', () => {
    expect(bookingEligibility(stay(), checkoutEvening)).toMatchObject({
      state: 'not_yet',
      eligibleFrom: '2026-11-05',
      subject: { type: 'hotel', key: 'demo-hotels:goa-casa-lagoa' },
    });
    expect(bookingEligibility(stay(), dayAfter)).toMatchObject({
      state: 'eligible',
      verification: 'demo_booking',
      travelFrom: '2026-11-01',
      travelTo: '2026-11-04',
    });
  });

  it('marks only supplier-confirmed real bookings as verified', () => {
    expect(
      bookingEligibility(stay({ isDemo: false, reservationStatus: 'CONFIRMED' }), dayAfter),
    ).toMatchObject({
      state: 'eligible',
      verification: 'verified_booking',
    });
    for (const reservationStatus of [null, 'PENDING', 'UNKNOWN', 'FAILED', 'CANCELLED']) {
      expect(bookingEligibility(stay({ isDemo: false, reservationStatus }), dayAfter).state).toBe(
        'not_eligible',
      );
    }
  });

  it('refuses unconfirmed, cancelled, refunded, undated and unsupported bookings', () => {
    for (const status of ['PENDING', 'HELD', 'CANCELLED', 'FAILED', 'EXPIRED']) {
      const e = bookingEligibility(stay({ status }), dayAfter);
      expect(e.state, status).toBe('not_eligible');
    }
    expect(bookingEligibility(stay({ status: 'CANCELLED' }), dayAfter)).toMatchObject({
      reason: 'Cancelled bookings can’t be reviewed.',
    });
    expect(bookingEligibility(stay({ hasRefund: true }), dayAfter)).toMatchObject({
      state: 'not_eligible',
      reason: 'Refunded bookings can’t be reviewed.',
    });
    expect(bookingEligibility(stay({ startsOn: null, endsOn: null }), dayAfter).state).toBe(
      'not_eligible',
    );
    for (const category of ['FLIGHT', 'TRAIN', 'BUS', 'METRO', 'CAB']) {
      expect(bookingEligibility(stay({ category }), dayAfter)).toMatchObject({
        state: 'not_eligible',
        subject: null,
      });
    }
    // A provider without a known, stable property reference.
    expect(
      bookingEligibility(
        stay({ offer: { serviceType: 'hotels', providerId: 'acme-live', offerRef: 'x/1' } }),
        dayAfter,
      ),
    ).toMatchObject({ state: 'not_eligible', subject: null });
    expect(bookingEligibility(stay({ offer: null }), dayAfter).state).toBe('not_eligible');
  });

  it('dates a package by its end date', () => {
    const pkg = stay({
      category: 'HOLIDAY_PACKAGE',
      offer: {
        serviceType: 'holidays',
        providerId: 'demo-holidays',
        offerRef: 'ker-ayurveda/2026-11-01',
      },
    });
    expect(bookingEligibility(pkg, dayAfter)).toMatchObject({
      state: 'eligible',
      subject: { type: 'holiday_package', key: 'demo-holidays:ker-ayurveda' },
    });
  });
});

describe('subjects', () => {
  it('derives a subject only for known providers and matching travel types', () => {
    expect(
      reviewSubjectOf({
        serviceType: 'hotels',
        providerId: 'demo-hotels',
        offerRef: 'jai-haveli/a/b/1',
      }),
    ).toEqual({
      type: 'hotel',
      key: 'demo-hotels:jai-haveli',
    });
    expect(
      reviewSubjectOf({ serviceType: 'flights', providerId: 'demo-hotels', offerRef: 'x/1' }),
    ).toBeNull();
    expect(
      reviewSubjectOf({
        serviceType: 'flights',
        providerId: 'demo-flights',
        offerRef: 'AI101/2026',
      }),
    ).toBeNull();
    expect(
      reviewSubjectOf({ serviceType: 'hotels', providerId: 'demo-hotels', offerRef: 'Bad Ref/1' }),
    ).toBeNull();
  });
});

describe('rating maths', () => {
  it('rounds the average to one decimal, half up, without float drift', () => {
    expect(averageOf(11, 3)).toBe(3.7);
    expect(averageOf(9, 2)).toBe(4.5);
    expect(averageOf(13, 3)).toBe(4.3);
    expect(averageOf(5, 1)).toBe(5);
  });

  it('shows an average only from three counted reviews, and per aspect from three ratings', () => {
    const two = ratingSummary({
      subject: { type: 'hotel', key: 'demo-hotels:a' },
      byRating: new Map([
        [5, 1],
        [1, 1],
      ]),
      byVerification: { demo_booking: 2 },
      aspects: { cleanliness: { count: 2, sum: 9 } },
    });
    expect(two).toMatchObject({
      count: 2,
      average: null,
      distribution: [1, 0, 0, 0, 1],
      minimumForAverage: 3,
    });
    expect(two.aspects.find((a) => a.aspect === 'cleanliness')).toEqual({
      aspect: 'cleanliness',
      count: 2,
      average: null,
    });

    const three = ratingSummary({
      subject: { type: 'hotel', key: 'demo-hotels:a' },
      byRating: new Map([
        [5, 2],
        [2, 1],
      ]),
      byVerification: { demo_booking: 3 },
      aspects: { cleanliness: { count: 3, sum: 13 } },
    });
    expect(three).toMatchObject({ count: 3, average: 4, distribution: [0, 1, 0, 0, 2] });
    expect(three.aspects.map((a) => a.aspect)).toEqual([
      'cleanliness',
      'location',
      'service',
      'comfort',
      'value',
    ]);
    expect(three.aspects[0]).toEqual({ aspect: 'cleanliness', count: 3, average: 4.3 });
    expect(three.byVerification).toEqual({ verified_booking: 0, demo_booking: 3, unverified: 0 });
  });

  it('gives destinations no category ratings', () => {
    expect(
      ratingSummary({
        subject: { type: 'destination', key: 'goa' },
        byRating: new Map(),
        byVerification: {},
        aspects: {},
      }).aspects,
    ).toEqual([]);
    expect(unexpectedAspects('destination', { location: 4 })).toEqual(['location']);
    expect(unexpectedAspects('hotel', { cleanliness: 4, experience: 3 })).toEqual(['experience']);
    expect(
      unexpectedAspects('holiday_package', { experience: 4, organisation: 5, value: 3 }),
    ).toEqual([]);
  });
});

describe('names, dates and the edit window', () => {
  it('shows a first name and initial, never more', () => {
    expect(publicAuthorName('Asha Rao')).toBe('Asha R.');
    expect(publicAuthorName('  ravi   kumar  singh ')).toBe('ravi S.');
    expect(publicAuthorName('Lena')).toBe('Lena');
    expect(publicAuthorName(null)).toBe('Wayora traveller');
    expect(publicAuthorName('   ')).toBe('Wayora traveller');
  });

  it('uses India dates', () => {
    expect(indiaDay(new Date('2026-11-04T18:29:00Z'))).toBe('2026-11-04');
    expect(indiaDay(new Date('2026-11-04T18:30:00Z'))).toBe('2026-11-05');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('allows edits for 30 days, except for flagged or removed reviews', () => {
    const createdAt = new Date('2026-11-01T00:00:00Z');
    const now = new Date('2026-11-20T00:00:00Z');
    for (const status of ['pending', 'published', 'rejected'] as ReviewStatus[]) {
      expect(editableUntil({ status, createdAt }, now)?.toISOString()).toBe(
        '2026-12-01T00:00:00.000Z',
      );
    }
    expect(editableUntil({ status: 'flagged', createdAt }, now)).toBeNull();
    expect(editableUntil({ status: 'removed', createdAt }, now)).toBeNull();
    expect(
      editableUntil({ status: 'published', createdAt }, new Date('2026-12-01T00:00:01Z')),
    ).toBeNull();
  });
});

describe('moderation rules and input', () => {
  it('defines which decisions each status allows; removal is final', () => {
    expect(canModerate('publish', 'pending')).toBe(true);
    expect(canModerate('publish', 'published')).toBe(false);
    expect(canModerate('reject', 'published')).toBe(false);
    expect(canModerate('flag', 'flagged')).toBe(false);
    for (const action of Object.keys(MODERATION_FROM) as (keyof typeof MODERATION_FROM)[]) {
      expect(canModerate(action, 'removed'), action).toBe(false);
    }
  });

  it('needs a reason for every decision except publishing', () => {
    expect(moderateReviewSchema.safeParse({ action: 'publish', revision: 1 }).success).toBe(true);
    for (const action of ['reject', 'flag', 'remove']) {
      expect(moderateReviewSchema.safeParse({ action, revision: 1 }).success, action).toBe(false);
      expect(
        moderateReviewSchema.safeParse({ action, revision: 1, reason: 'Abc' }).success,
        action,
      ).toBe(false);
      expect(
        moderateReviewSchema.safeParse({ action, revision: 1, reason: 'Off topic' }).success,
        action,
      ).toBe(true);
    }
  });

  it('validates review and report input strictly', () => {
    const base = {
      kind: 'destination',
      destination: 'goa',
      rating: 5,
      title: 'Lovely',
      body: 'A long enough description of a lovely visit to Goa.',
    };
    expect(createReviewSchema.safeParse(base).success).toBe(true);
    expect(
      createReviewSchema.safeParse({ ...base, verification: 'verified_booking' }).success,
    ).toBe(false);
    expect(createReviewSchema.safeParse({ ...base, rating: 0 }).success).toBe(false);
    expect(createReviewSchema.safeParse({ ...base, visitedMonth: '2026-13' }).success).toBe(false);
    expect(createReviewSchema.safeParse({ ...base, body: '  <b>short</b>  ' }).success).toBe(false);
    expect(reportReviewSchema.safeParse({ reason: 'spam' }).success).toBe(true);
    expect(reportReviewSchema.safeParse({ reason: 'other', details: 'short' }).success).toBe(false);
    expect(
      reportReviewSchema.safeParse({ reason: 'other', details: 'Promotes another hotel' }).success,
    ).toBe(true);
    expect(reportReviewSchema.safeParse({ reason: 'made-up' }).success).toBe(false);
  });
});
