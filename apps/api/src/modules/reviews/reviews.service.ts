import {
  ASPECTS_FOR,
  MIN_REVIEWS_FOR_AVERAGE,
  MODERATION_TO,
  REVIEW_ASPECTS,
  REVIEW_SUBJECT_LABEL,
  canModerate,
  hasPermission,
  type AdminReview,
  type AdminReviewList,
  type AdminReviewSubjects,
  type BookingReviewState,
  type DestinationReviewState,
  type ModerationAction,
  type OwnReview,
  type OwnReviewList,
  type PublicReview,
  type ReportReason,
  type ReviewAspect,
  type ReviewList,
  type ReviewMetrics,
  type ReviewMetricsRange,
  type ReviewStatus,
  type ReviewSubject,
  type ReviewSubjectType,
  type ReviewVerification,
  type UserRole,
} from '@wayora/contracts';
import type {
  adminReviewListQuerySchema,
  adminReviewSubjectsQuerySchema,
  createReviewSchema,
  dismissReportsSchema,
  moderateReviewSchema,
  reportReviewSchema,
  reviewListQuerySchema,
  updateReviewSchema,
} from '@wayora/contracts';
import type { z } from 'zod';
import {
  Prisma,
  type PrismaClient,
  type ReviewActorKind,
  type ReviewEventKind,
  type ReviewReportReason,
  type ReviewStatus as DbReviewStatus,
  type ReviewSubjectType as DbSubjectType,
  type ReviewVerification as DbVerification,
} from '@wayora/database';
import { AppError } from '../../utils/errors.js';
import { bookingSnapshotSchema } from '../bookings/snapshot.js';
import { notify } from '../notifications/notify.js';
import { catalogDestination } from '../planner/catalog.js';
import {
  averageOf,
  bookingEligibility,
  editableUntil,
  indiaDay,
  publicAuthorName,
  ratingSummary,
  unexpectedAspects,
  type EligibilityBooking,
} from './rules.js';

/*
 * Reviews, ratings and travel feedback (Phase 28, docs/reviews.md).
 *
 * The author always comes from the session. The subject, verification,
 * status, aggregates and vote counts are decided here, never by the client.
 * Every change runs in a transaction with the review (or booking) row
 * locked; history, revisions, audit rows and notifications commit with it.
 */

type Tx = Prisma.TransactionClient;
type CreateInput = z.output<typeof createReviewSchema>;
type UpdateInput = z.output<typeof updateReviewSchema>;
type ListQuery = z.output<typeof reviewListQuerySchema>;
type ReportInput = z.output<typeof reportReviewSchema>;
type ModerateInput = z.output<typeof moderateReviewSchema>;
type DismissInput = z.output<typeof dismissReportsSchema>;
type AdminListQuery = z.output<typeof adminReviewListQuerySchema>;
type SubjectsQuery = z.output<typeof adminReviewSubjectsQuerySchema>;

export interface RequestContext {
  requestId?: string | undefined;
}
export interface Staff {
  id: string;
  role: UserRole;
}

const NOT_FOUND = "We couldn't find that review.";
const BOOKING_NOT_FOUND = "We couldn't find that booking in your trips.";
const STALE = 'This review changed since you opened it. Reload it and try again.';

// ─── Enum mapping ────────────────────────────────────────────────────────

const toDbType = (t: ReviewSubjectType) => t.toUpperCase() as DbSubjectType;
const fromDbType = (t: DbSubjectType) => t.toLowerCase() as ReviewSubjectType;
const toDbStatus = (s: ReviewStatus) => s.toUpperCase() as DbReviewStatus;
const fromDbStatus = (s: DbReviewStatus) => s.toLowerCase() as ReviewStatus;
const fromDbVerification = (v: DbVerification) => v.toLowerCase() as ReviewVerification;
const toDbReason = (r: ReportReason) => r.toUpperCase() as ReviewReportReason;
const fromDbReason = (r: ReviewReportReason) => r.toLowerCase() as ReportReason;

/** `_count._all` of a groupBy row (its type is lost in batched transactions). */
const countAll = (c: unknown) => (c as { _all: number })._all;

const isUnique = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/**
 * A booking review counts publicly only while its booking is still confirmed
 * (docs/reviews.md#ratings). Destination feedback has no booking.
 */
const COUNTED: Prisma.ReviewWhereInput = {
  status: 'PUBLISHED',
  OR: [{ bookingId: null }, { booking: { status: 'CONFIRMED' } }],
};

const aspectsOf = (row: Partial<Record<ReviewAspect, number | null>>) => {
  const out: Partial<Record<ReviewAspect, number>> = {};
  for (const a of REVIEW_ASPECTS) {
    const v = row[a];
    if (typeof v === 'number') out[a] = v;
  }
  return out;
};
/** Every aspect column, set or cleared, from the input. */
const aspectColumns = (aspects: Partial<Record<ReviewAspect, number>>) =>
  Object.fromEntries(REVIEW_ASPECTS.map((a) => [a, aspects[a] ?? null])) as Record<
    ReviewAspect,
    number | null
  >;

const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const month = (d: Date | null) => (d ? d.toISOString().slice(0, 7) : null);

const reviewInclude = {
  user: { select: { displayName: true } },
  booking: { select: { reference: true, status: true } },
  _count: { select: { votes: true } },
} satisfies Prisma.ReviewInclude;
type ReviewRow = Prisma.ReviewGetPayload<{ include: typeof reviewInclude }>;

export class ReviewsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ─── Helpers ───────────────────────────────────────────────────────────

  private async lockReview(tx: Tx, id: string) {
    await tx.$queryRaw`SELECT id FROM reviews WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.review.findUnique({ where: { id }, include: reviewInclude });
  }

  private audit(
    tx: Tx,
    actor: { type: 'USER' | 'ADMIN' | 'SYSTEM'; id: string | null },
    action: string,
    reviewId: string,
    metadata: Record<string, unknown>,
    ctx: RequestContext,
  ) {
    return tx.auditLog.create({
      data: {
        actorType: actor.type,
        actorId: actor.id,
        action,
        entityType: 'review',
        entityId: reviewId,
        requestId: ctx.requestId ?? null,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }

  private event(
    tx: Tx,
    data: {
      reviewId: string;
      kind: ReviewEventKind;
      actorKind: ReviewActorKind;
      actorId: string | null;
      from?: DbReviewStatus | null;
      to?: DbReviewStatus | null;
      reason?: string | null;
      revision: number;
    },
  ) {
    return tx.reviewEvent.create({
      data: {
        reviewId: data.reviewId,
        kind: data.kind,
        actorKind: data.actorKind,
        actorId: data.actorId,
        fromStatus: data.from ?? null,
        toStatus: data.to ?? null,
        reason: data.reason ?? null,
        revision: data.revision,
        createdAt: this.now(),
      },
    });
  }

  private eligibilityInput(b: {
    userId: string;
    category: string;
    status: string;
    isDemo: boolean;
    startsOn: Date | null;
    endsOn: Date | null;
    offerSnapshot: unknown;
    _count: { refunds: number };
    reservation: { status: string } | null;
  }): EligibilityBooking {
    const parsed = bookingSnapshotSchema.safeParse(b.offerSnapshot);
    return {
      userId: b.userId,
      category: b.category,
      status: b.status,
      isDemo: b.isDemo,
      startsOn: b.startsOn,
      endsOn: b.endsOn,
      offer: parsed.success ? parsed.data.offer : null,
      hasRefund: b._count.refunds > 0,
      reservationStatus: b.reservation?.status ?? null,
    };
  }

  private static subjectNameOf(snapshot: unknown): string | null {
    const parsed = bookingSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) return null;
    const offer = parsed.data.offer;
    if (offer.serviceType === 'hotels') return `${offer.property.name}, ${offer.property.cityName}`;
    if (offer.serviceType === 'holidays') return offer.packageName;
    return offer.title;
  }

  private static readonly bookingSelect = {
    id: true,
    reference: true,
    userId: true,
    category: true,
    status: true,
    isDemo: true,
    startsOn: true,
    endsOn: true,
    offerSnapshot: true,
    review: { select: { id: true } },
    reservation: { select: { status: true } },
    _count: { select: { refunds: true } },
  } satisfies Prisma.BookingSelect;

  private bookingState(
    b: Prisma.BookingGetPayload<{ select: typeof ReviewsService.bookingSelect }>,
  ): BookingReviewState {
    const e = bookingEligibility(this.eligibilityInput(b), this.now());
    const base = {
      bookingReference: b.reference,
      subject: e.subject,
      subjectName: e.subject ? ReviewsService.subjectNameOf(b.offerSnapshot) : null,
    };
    if (b.review) {
      return {
        ...base,
        state: 'reviewed',
        reason: 'You’ve reviewed this booking.',
        eligibleFrom: null,
        verification: null,
        reviewId: b.review.id,
      };
    }
    if (e.state === 'eligible') {
      return {
        ...base,
        state: 'eligible',
        reason: null,
        eligibleFrom: null,
        verification: e.verification,
        reviewId: null,
      };
    }
    return {
      ...base,
      state: e.state,
      reason: e.reason,
      eligibleFrom: e.state === 'not_yet' ? e.eligibleFrom : null,
      verification: null,
      reviewId: null,
    };
  }

  private presentPublic(
    row: ReviewRow,
    viewer: { id: string; voted: Set<string>; reported: Set<string> } | null,
  ): PublicReview {
    return {
      id: row.id,
      subject: { type: fromDbType(row.subjectType), key: row.subjectKey },
      author: publicAuthorName(row.user.displayName),
      verification: fromDbVerification(row.verification),
      rating: row.rating,
      aspects: aspectsOf(row),
      title: row.title,
      body: row.body,
      travelled: row.travelFrom
        ? { from: isoDay(row.travelFrom)!, to: isoDay(row.travelTo) }
        : null,
      visitedMonth: month(row.visitedMonth),
      publishedAt: (row.publishedAt ?? row.createdAt).toISOString(),
      edited: row.version > 1,
      helpful: row._count.votes,
      viewer: viewer
        ? {
            own: row.userId === viewer.id,
            votedHelpful: viewer.voted.has(row.id),
            reported: viewer.reported.has(row.id),
          }
        : null,
    };
  }

  private presentOwn(row: ReviewRow): OwnReview {
    const status = fromDbStatus(row.status);
    const until = editableUntil({ status, createdAt: row.createdAt }, this.now());
    return {
      id: row.id,
      subject: { type: fromDbType(row.subjectType), key: row.subjectKey },
      subjectName: row.subjectName,
      author: publicAuthorName(row.user.displayName),
      verification: fromDbVerification(row.verification),
      rating: row.rating,
      aspects: aspectsOf(row),
      title: row.title,
      body: row.body,
      travelled: row.travelFrom
        ? { from: isoDay(row.travelFrom)!, to: isoDay(row.travelTo) }
        : null,
      visitedMonth: month(row.visitedMonth),
      edited: row.version > 1,
      helpful: row._count.votes,
      status,
      // The author sees why it wasn't published or was removed; flag notes stay with staff.
      moderationNote: status === 'rejected' || status === 'removed' ? row.moderationNote : null,
      bookingReference: row.booking?.reference ?? null,
      revision: row.revision,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      publishedAt: status === 'published' ? (row.publishedAt?.toISOString() ?? null) : null,
      editableUntil: until?.toISOString() ?? null,
    };
  }

  private checkAspects(type: ReviewSubjectType, aspects: Partial<Record<ReviewAspect, number>>) {
    const extra = unexpectedAspects(type, aspects);
    if (extra.length > 0) {
      throw new AppError('VALIDATION_FAILED', 'The request is invalid.', {
        details: extra.map((a) => ({
          path: `body.aspects.${a}`,
          message:
            ASPECTS_FOR[type].length === 0
              ? `${REVIEW_SUBJECT_LABEL[type]} reviews take an overall rating only.`
              : `${REVIEW_SUBJECT_LABEL[type]} reviews don’t rate this.`,
          code: 'unrecognized_keys',
        })),
      });
    }
  }

  // ─── Public reviews ────────────────────────────────────────────────────

  /** Published reviews of one subject, with the rating summary (public). */
  async list(viewerId: string | null, q: ListQuery): Promise<ReviewList> {
    const subject: ReviewSubject = { type: q.type, key: q.key };
    if (q.type === 'destination' && !catalogDestination(q.key)) {
      throw new AppError('NOT_FOUND', 'We couldn’t find that destination.');
    }
    const where: Prisma.ReviewWhereInput = {
      ...COUNTED,
      subjectType: toDbType(q.type),
      subjectKey: q.key,
    };
    const listWhere = q.rating ? { ...where, rating: q.rating } : where;
    const orderBy: Prisma.ReviewOrderByWithRelationInput[] =
      q.sort === 'highest'
        ? [{ rating: 'desc' }, { publishedAt: 'desc' }, { id: 'desc' }]
        : q.sort === 'lowest'
          ? [{ rating: 'asc' }, { publishedAt: 'desc' }, { id: 'desc' }]
          : q.sort === 'helpful'
            ? [{ votes: { _count: 'desc' } }, { publishedAt: 'desc' }, { id: 'desc' }]
            : [{ publishedAt: 'desc' }, { id: 'desc' }];

    const [byRating, byVerification, aspectAgg, total, rows] = await this.prisma.$transaction([
      this.prisma.review.groupBy({
        by: ['rating'],
        where,
        _count: { _all: true },
        orderBy: { rating: 'asc' },
      }),
      this.prisma.review.groupBy({
        by: ['verification'],
        where,
        _count: { _all: true },
        orderBy: { verification: 'asc' },
      }),
      this.prisma.review.aggregate({
        where,
        _count: Object.fromEntries(REVIEW_ASPECTS.map((a) => [a, true])) as Record<
          ReviewAspect,
          true
        >,
        _sum: Object.fromEntries(REVIEW_ASPECTS.map((a) => [a, true])) as Record<
          ReviewAspect,
          true
        >,
      }),
      this.prisma.review.count({ where: listWhere }),
      this.prisma.review.findMany({
        where: listWhere,
        include: reviewInclude,
        orderBy,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);

    const counts = aspectAgg._count as Record<ReviewAspect, number>;
    const sums = aspectAgg._sum as Record<ReviewAspect, number | null>;
    const summary = ratingSummary({
      subject,
      byRating: new Map(byRating.map((g) => [g.rating, countAll(g._count)])),
      byVerification: Object.fromEntries(
        byVerification.map((g) => [fromDbVerification(g.verification), countAll(g._count)]),
      ),
      aspects: Object.fromEntries(
        REVIEW_ASPECTS.map((a) => [a, { count: counts[a] ?? 0, sum: sums[a] ?? 0 }]),
      ),
    });

    let viewer: { id: string; voted: Set<string>; reported: Set<string> } | null = null;
    if (viewerId) {
      const ids = rows.map((r) => r.id);
      const [votes, reports] = await Promise.all([
        this.prisma.reviewVote.findMany({
          where: { userId: viewerId, reviewId: { in: ids } },
          select: { reviewId: true },
        }),
        this.prisma.reviewReport.findMany({
          where: { reporterId: viewerId, reviewId: { in: ids } },
          select: { reviewId: true },
        }),
      ]);
      viewer = {
        id: viewerId,
        voted: new Set(votes.map((v) => v.reviewId)),
        reported: new Set(reports.map((r) => r.reviewId)),
      };
    }

    return {
      summary,
      items: rows.map((r) => this.presentPublic(r, viewer)),
      pagination: {
        page: q.page,
        pageSize: q.pageSize,
        totalResults: total,
        totalPages: Math.ceil(total / q.pageSize),
      },
    };
  }

  // ─── The author ────────────────────────────────────────────────────────

  async mine(userId: string, page: number, pageSize: number): Promise<OwnReviewList> {
    const where = { userId };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.review.count({ where }),
      this.prisma.review.findMany({
        where,
        include: reviewInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      items: rows.map((r) => this.presentOwn(r)),
      pagination: { page, pageSize, totalResults: total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  async own(userId: string, id: string): Promise<OwnReview> {
    const row = await this.prisma.review.findFirst({
      where: { id, userId },
      include: reviewInclude,
    });
    if (!row) throw new AppError('NOT_FOUND', NOT_FOUND);
    return this.presentOwn(row);
  }

  /** The customer's hotel and package bookings, and whether each can be reviewed. */
  async reviewableBookings(userId: string): Promise<{ items: BookingReviewState[] }> {
    const rows = await this.prisma.booking.findMany({
      where: { userId, category: { in: ['HOTEL', 'HOLIDAY_PACKAGE'] }, status: 'CONFIRMED' },
      select: ReviewsService.bookingSelect,
      orderBy: [{ endsOn: 'desc' }, { createdAt: 'desc' }],
      take: 50,
    });
    return { items: rows.map((b) => this.bookingState(b)) };
  }

  async bookingReviewState(userId: string, reference: string): Promise<BookingReviewState> {
    const b = await this.prisma.booking.findFirst({
      where: { reference, userId },
      select: ReviewsService.bookingSelect,
    });
    if (!b) throw new AppError('NOT_FOUND', BOOKING_NOT_FOUND);
    return this.bookingState(b);
  }

  async destinationState(userId: string, slug: string): Promise<DestinationReviewState> {
    const destination = catalogDestination(slug);
    if (!destination) throw new AppError('NOT_FOUND', 'We couldn’t find that destination.');
    const existing = await this.prisma.review.findFirst({
      where: { userId, subjectType: 'DESTINATION', subjectKey: slug, bookingId: null },
      select: { id: true },
    });
    return { destination: slug, name: destination.name, reviewId: existing?.id ?? null };
  }

  async create(userId: string, input: CreateInput, ctx: RequestContext): Promise<OwnReview> {
    const now = this.now();
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        let data: Prisma.ReviewUncheckedCreateInput;
        if (input.kind === 'booking') {
          // Lock the booking so two submissions can't both pass the checks.
          const found = await tx.booking.findFirst({
            where: { reference: input.bookingReference, userId },
            select: { id: true },
          });
          if (!found) throw new AppError('NOT_FOUND', BOOKING_NOT_FOUND);
          await tx.$queryRaw`SELECT id FROM bookings WHERE id = ${found.id}::uuid FOR UPDATE`;
          const b = await tx.booking.findUniqueOrThrow({
            where: { id: found.id },
            select: ReviewsService.bookingSelect,
          });
          if (b.review) {
            throw new AppError(
              'CONFLICT',
              'You’ve already reviewed this booking. You can edit that review instead.',
            );
          }
          const e = bookingEligibility(this.eligibilityInput(b), now);
          if (e.state !== 'eligible') throw new AppError('REVIEW_NOT_ELIGIBLE', e.reason);
          this.checkAspects(e.subject.type, input.aspects);
          data = {
            userId,
            subjectType: toDbType(e.subject.type),
            subjectKey: e.subject.key,
            subjectName: (ReviewsService.subjectNameOf(b.offerSnapshot) ?? e.subject.key).slice(
              0,
              200,
            ),
            bookingId: b.id,
            verification:
              e.verification === 'verified_booking' ? 'VERIFIED_BOOKING' : 'DEMO_BOOKING',
            travelFrom: new Date(`${e.travelFrom}T00:00:00Z`),
            travelTo: e.travelTo ? new Date(`${e.travelTo}T00:00:00Z`) : null,
            visitedMonth: null,
            rating: input.rating,
            ...aspectColumns(input.aspects),
            title: input.title,
            body: input.body,
          };
        } else {
          const destination = catalogDestination(input.destination);
          if (!destination) throw new AppError('NOT_FOUND', 'We couldn’t find that destination.');
          this.checkAspects('destination', input.aspects);
          if (input.visitedMonth) {
            const thisMonth = indiaDay(now).slice(0, 7);
            if (input.visitedMonth > thisMonth || input.visitedMonth < '2000-01') {
              throw new AppError('VALIDATION_FAILED', 'The request is invalid.', {
                details: [
                  {
                    path: 'body.visitedMonth',
                    message: 'Choose a month between January 2000 and this month.',
                    code: 'custom',
                  },
                ],
              });
            }
          }
          data = {
            userId,
            subjectType: 'DESTINATION',
            subjectKey: input.destination,
            subjectName: destination.name,
            bookingId: null,
            verification: 'UNVERIFIED',
            visitedMonth: input.visitedMonth
              ? new Date(`${input.visitedMonth}-01T00:00:00Z`)
              : null,
            rating: input.rating,
            ...aspectColumns(input.aspects),
            title: input.title,
            body: input.body,
          };
        }
        const review = await tx.review.create({
          data: { ...data, status: 'PENDING', statusChangedAt: now, createdAt: now },
        });
        await tx.reviewRevision.create({
          data: {
            reviewId: review.id,
            version: 1,
            rating: review.rating,
            aspects: aspectsOf(review) as Prisma.InputJsonValue,
            title: review.title,
            body: review.body,
            createdAt: now,
          },
        });
        await this.event(tx, {
          reviewId: review.id,
          kind: 'SUBMITTED',
          actorKind: 'AUTHOR',
          actorId: userId,
          to: 'PENDING',
          revision: 1,
        });
        await this.audit(
          tx,
          { type: 'USER', id: userId },
          'review.submitted',
          review.id,
          {
            subjectType: review.subjectType,
            subjectKey: review.subjectKey,
            verification: review.verification,
            rating: review.rating,
          },
          ctx,
        );
        return review.id;
      });
      return this.own(userId, id);
    } catch (e) {
      if (isUnique(e)) {
        throw new AppError(
          'CONFLICT',
          input.kind === 'booking'
            ? 'You’ve already reviewed this booking. You can edit that review instead.'
            : 'You’ve already shared feedback about this destination. You can edit it instead.',
        );
      }
      throw e;
    }
  }

  async update(
    userId: string,
    id: string,
    input: UpdateInput,
    ctx: RequestContext,
  ): Promise<OwnReview> {
    const now = this.now();
    await this.prisma.$transaction(async (tx) => {
      const row = await this.lockReview(tx, id);
      if (!row || row.userId !== userId) throw new AppError('NOT_FOUND', NOT_FOUND);
      const status = fromDbStatus(row.status);
      if (row.revision !== input.revision) throw new AppError('CONFLICT', STALE);
      if (status === 'removed' || status === 'flagged') {
        throw new AppError(
          'CONFLICT',
          status === 'removed'
            ? 'This review was removed, so it can’t be edited.'
            : 'This review is being checked by our team, so it can’t be edited right now.',
        );
      }
      if (!editableUntil({ status, createdAt: row.createdAt }, now)) {
        throw new AppError('CONFLICT', 'Reviews can be edited for 30 days after they’re written.');
      }
      this.checkAspects(fromDbType(row.subjectType), input.aspects);
      const version = row.version + 1;
      const revision = row.revision + 1;
      await tx.review.update({
        where: { id },
        data: {
          rating: input.rating,
          ...aspectColumns(input.aspects),
          title: input.title,
          body: input.body,
          status: 'PENDING',
          version,
          revision,
          editedAt: now,
          moderationNote: null,
          statusChangedAt: row.status === 'PENDING' ? row.statusChangedAt : now,
        },
      });
      await tx.reviewRevision.create({
        data: {
          reviewId: id,
          version,
          rating: input.rating,
          aspects: input.aspects as Prisma.InputJsonValue,
          title: input.title,
          body: input.body,
          createdAt: now,
        },
      });
      await this.event(tx, {
        reviewId: id,
        kind: 'EDITED',
        actorKind: 'AUTHOR',
        actorId: userId,
        from: row.status,
        to: 'PENDING',
        revision,
      });
      await this.audit(
        tx,
        { type: 'USER', id: userId },
        'review.edited',
        id,
        { version, from: row.status, rating: input.rating },
        ctx,
      );
    });
    return this.own(userId, id);
  }

  /** A review the public can see right now (published and counted). */
  private async visible(id: string) {
    return this.prisma.review.findFirst({
      where: { id, ...COUNTED },
      select: { id: true, userId: true },
    });
  }

  async vote(userId: string, id: string, helpful: boolean) {
    const review = await this.visible(id);
    if (!review) throw new AppError('NOT_FOUND', NOT_FOUND);
    if (review.userId === userId) {
      throw new AppError('FORBIDDEN', 'You can’t vote on your own review.');
    }
    if (helpful) {
      await this.prisma.reviewVote.createMany({
        data: [{ reviewId: id, userId, createdAt: this.now() }],
        skipDuplicates: true,
      });
    } else {
      await this.prisma.reviewVote.deleteMany({ where: { reviewId: id, userId } });
    }
    const [count, mine] = await Promise.all([
      this.prisma.reviewVote.count({ where: { reviewId: id } }),
      this.prisma.reviewVote.count({ where: { reviewId: id, userId } }),
    ]);
    return { helpful: count, votedHelpful: mine > 0 };
  }

  async report(userId: string, id: string, input: ReportInput, ctx: RequestContext) {
    const review = await this.visible(id);
    if (!review) throw new AppError('NOT_FOUND', NOT_FOUND);
    if (review.userId === userId) {
      throw new AppError('FORBIDDEN', 'You can’t report your own review. You can edit it instead.');
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        const report = await tx.reviewReport.create({
          data: {
            reviewId: id,
            reporterId: userId,
            reason: toDbReason(input.reason),
            details: input.details || null,
            createdAt: this.now(),
          },
        });
        // Reports never change the review or its rating by themselves.
        await this.audit(
          tx,
          { type: 'USER', id: userId },
          'review.reported',
          id,
          { reportId: report.id, reason: report.reason },
          ctx,
        );
      });
    } catch (e) {
      if (isUnique(e)) throw new AppError('CONFLICT', 'You’ve already reported this review.');
      throw e;
    }
    return { reported: true as const };
  }

  // ─── Staff ─────────────────────────────────────────────────────────────

  async adminList(q: AdminListQuery): Promise<AdminReviewList> {
    const where: Prisma.ReviewWhereInput = {
      ...(q.status ? { status: toDbStatus(q.status) } : {}),
      ...(q.type ? { subjectType: toDbType(q.type) } : {}),
      ...(q.verification ? { verification: q.verification.toUpperCase() as DbVerification } : {}),
      ...(q.rating ? { rating: q.rating } : {}),
      ...(q.reported === 'true' ? { reports: { some: { status: 'OPEN' } } } : {}),
      ...(q.reported === 'false' ? { reports: { none: { status: 'OPEN' } } } : {}),
      ...(q.q
        ? {
            OR: [
              { subjectName: { contains: q.q, mode: 'insensitive' } },
              { subjectKey: { contains: q.q.toLowerCase() } },
              { title: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const orderBy: Prisma.ReviewOrderByWithRelationInput[] =
      q.sort === 'newest'
        ? [{ createdAt: 'desc' }, { id: 'desc' }]
        : q.sort === 'reports'
          ? [{ reports: { _count: 'desc' } }, { createdAt: 'asc' }, { id: 'asc' }]
          : [{ statusChangedAt: 'asc' }, { id: 'asc' }];
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.review.count({ where }),
      this.prisma.review.findMany({
        where,
        orderBy,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          user: { select: { displayName: true } },
          _count: { select: { reports: { where: { status: 'OPEN' } } } },
        },
      }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        subject: { type: fromDbType(r.subjectType), key: r.subjectKey },
        subjectName: r.subjectName,
        status: fromDbStatus(r.status),
        verification: fromDbVerification(r.verification),
        rating: r.rating,
        title: r.title,
        author: publicAuthorName(r.user.displayName),
        openReports: r._count.reports,
        revision: r.revision,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
      pagination: {
        page: q.page,
        pageSize: q.pageSize,
        totalResults: total,
        totalPages: Math.ceil(total / q.pageSize),
      },
    };
  }

  async adminGet(staff: Staff, id: string): Promise<AdminReview> {
    const r = await this.prisma.review.findUnique({
      where: { id },
      include: {
        user: { select: { displayName: true } },
        booking: { select: { reference: true, status: true } },
        revisions: { orderBy: { version: 'asc' } },
        events: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          include: { actor: { select: { displayName: true } } },
        },
        reports: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        _count: { select: { votes: true, reports: { where: { status: 'OPEN' } } } },
      },
    });
    if (!r) throw new AppError('NOT_FOUND', NOT_FOUND);
    const status = fromDbStatus(r.status);
    const ownReview = r.userId === staff.id;
    const canRemove = hasPermission(staff.role, 'admin.reviews.remove');
    const actions = (['publish', 'reject', 'flag', 'remove'] as ModerationAction[]).filter(
      (a) => !ownReview && canModerate(a, status) && (a !== 'remove' || canRemove),
    );
    return {
      id: r.id,
      subject: { type: fromDbType(r.subjectType), key: r.subjectKey },
      subjectName: r.subjectName,
      status,
      verification: fromDbVerification(r.verification),
      rating: r.rating,
      title: r.title,
      author: r.user.displayName?.trim() || 'Wayora traveller',
      authorId: r.userId,
      openReports: r._count.reports,
      revision: r.revision,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      aspects: aspectsOf(r),
      body: r.body,
      bookingReference: r.booking?.reference ?? null,
      bookingStatus: r.booking ? r.booking.status.toLowerCase() : null,
      travelled: r.travelFrom ? { from: isoDay(r.travelFrom)!, to: isoDay(r.travelTo) } : null,
      visitedMonth: month(r.visitedMonth),
      helpful: r._count.votes,
      publishedAt: r.publishedAt?.toISOString() ?? null,
      moderationNote: r.moderationNote,
      revisions: r.revisions.map((v) => ({
        revision: v.version,
        rating: v.rating,
        aspects: (v.aspects ?? {}) as Partial<Record<ReviewAspect, number>>,
        title: v.title,
        body: v.body,
        createdAt: v.createdAt.toISOString(),
      })),
      history: r.events.map((e) => ({
        at: e.createdAt.toISOString(),
        actor:
          e.actorKind === 'AUTHOR'
            ? { kind: 'author' as const, name: 'Author' }
            : e.actorKind === 'STAFF'
              ? { kind: 'staff' as const, name: e.actor?.displayName?.trim() || 'Staff member' }
              : { kind: 'system' as const, name: 'Wayora' },
        event: e.kind.toLowerCase() as AdminReview['history'][number]['event'],
        from: e.fromStatus ? fromDbStatus(e.fromStatus) : null,
        to: e.toStatus ? fromDbStatus(e.toStatus) : null,
        reason: e.reason,
      })),
      reports: r.reports.map((p) => ({
        id: p.id,
        reason: fromDbReason(p.reason),
        details: p.details,
        status: p.status.toLowerCase() as 'open' | 'actioned' | 'dismissed',
        createdAt: p.createdAt.toISOString(),
        resolvedAt: p.resolvedAt?.toISOString() ?? null,
      })),
      allowed: {
        actions,
        dismissReports: !ownReview && r._count.reports > 0,
        ownReview,
      },
    };
  }

  async moderate(
    staff: Staff,
    id: string,
    input: ModerateInput,
    ctx: RequestContext,
  ): Promise<AdminReview> {
    const now = this.now();
    await this.prisma.$transaction(async (tx) => {
      const row = await this.lockReview(tx, id);
      if (!row) throw new AppError('NOT_FOUND', NOT_FOUND);
      // Moderation is separate from authorship: staff never decide on their own reviews.
      if (row.userId === staff.id) {
        throw new AppError('FORBIDDEN', 'You can’t moderate your own review.');
      }
      if (input.action === 'remove' && !hasPermission(staff.role, 'admin.reviews.remove')) {
        throw new AppError('FORBIDDEN', 'Removing reviews needs an administrator.');
      }
      if (row.revision !== input.revision) throw new AppError('CONFLICT', STALE);
      const from = fromDbStatus(row.status);
      if (!canModerate(input.action, from)) {
        throw new AppError(
          'CONFLICT',
          `A ${from === 'pending' ? 'pending' : from} review can’t be ${
            { publish: 'published', reject: 'rejected', flag: 'flagged', remove: 'removed' }[
              input.action
            ]
          }.`,
        );
      }
      const to = toDbStatus(MODERATION_TO[input.action]);
      const revision = row.revision + 1;
      const reason = input.reason?.trim() || null;
      await tx.review.update({
        where: { id },
        data: {
          status: to,
          revision,
          statusChangedAt: now,
          moderationNote: input.action === 'publish' ? null : reason,
          ...(input.action === 'publish' ? { publishedAt: now } : {}),
        },
      });
      await this.event(tx, {
        reviewId: id,
        kind: 'MODERATED',
        actorKind: 'STAFF',
        actorId: staff.id,
        from: row.status,
        to,
        reason,
        revision,
      });
      let resolved = 0;
      if (input.resolveReports) {
        const result = await tx.reviewReport.updateMany({
          where: { reviewId: id, status: 'OPEN' },
          data: {
            status: input.action === 'publish' ? 'DISMISSED' : 'ACTIONED',
            resolvedAt: now,
            resolvedBy: staff.id,
          },
        });
        resolved = result.count;
      }
      await this.audit(
        tx,
        { type: 'ADMIN', id: staff.id },
        'review.moderated',
        id,
        { action: input.action, from: row.status, to, reason, resolvedReports: resolved, revision },
        ctx,
      );
      // The author hears about decisions that change what they can see (not flags).
      const what = row.subjectName;
      const message =
        input.action === 'publish'
          ? {
              title: 'Your review is published',
              message: `Your review of ${what} is now visible to other travellers.`,
            }
          : input.action === 'reject'
            ? {
                title: 'Your review wasn’t published',
                message: `Your review of ${what} wasn’t published: ${reason}. You can edit it and send it again.`,
              }
            : input.action === 'remove'
              ? {
                  title: 'Your review was removed',
                  message: `Your review of ${what} was removed: ${reason}.`,
                }
              : null;
      if (message) {
        await notify(tx, now, {
          userId: row.userId,
          type: 'REVIEW',
          title: message.title,
          message: message.message.slice(0, 500),
          isDemo: row.verification === 'DEMO_BOOKING',
          dedupeKey: `review:${id}:${revision}`,
        });
      }
    });
    return this.adminGet(staff, id);
  }

  async dismissReports(
    staff: Staff,
    id: string,
    input: DismissInput,
    ctx: RequestContext,
  ): Promise<AdminReview> {
    const now = this.now();
    await this.prisma.$transaction(async (tx) => {
      const row = await this.lockReview(tx, id);
      if (!row) throw new AppError('NOT_FOUND', NOT_FOUND);
      if (row.userId === staff.id) {
        throw new AppError('FORBIDDEN', 'You can’t moderate your own review.');
      }
      if (row.revision !== input.revision) throw new AppError('CONFLICT', STALE);
      const result = await tx.reviewReport.updateMany({
        where: { reviewId: id, status: 'OPEN' },
        data: { status: 'DISMISSED', resolvedAt: now, resolvedBy: staff.id },
      });
      if (result.count === 0) throw new AppError('CONFLICT', 'This review has no open reports.');
      const revision = row.revision + 1;
      await tx.review.update({ where: { id }, data: { revision } });
      await this.event(tx, {
        reviewId: id,
        kind: 'REPORTS_DISMISSED',
        actorKind: 'STAFF',
        actorId: staff.id,
        reason: input.reason,
        revision,
      });
      await this.audit(
        tx,
        { type: 'ADMIN', id: staff.id },
        'review.reports_dismissed',
        id,
        { dismissed: result.count, reason: input.reason },
        ctx,
      );
    });
    return this.adminGet(staff, id);
  }

  // ─── Analytics ─────────────────────────────────────────────────────────

  async metrics(range: ReviewMetricsRange): Promise<ReviewMetrics> {
    const now = this.now();
    const days = { '7d': 7, '30d': 30, '90d': 90 }[range];
    const since = new Date(now.getTime() - days * 24 * 3600 * 1000);
    const staleBefore = new Date(now.getTime() - 48 * 3600 * 1000);

    const [
      byStatus,
      byVerification,
      distribution,
      openReports,
      reviewsWithReports,
      oldestPending,
      olderThan48h,
    ] = await this.prisma.$transaction([
      this.prisma.review.groupBy({
        by: ['status'],
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.review.groupBy({
        by: ['verification'],
        where: COUNTED,
        _count: { _all: true },
        orderBy: { verification: 'asc' },
      }),
      this.prisma.review.groupBy({
        by: ['rating'],
        where: COUNTED,
        _count: { _all: true },
        orderBy: { rating: 'asc' },
      }),
      this.prisma.reviewReport.count({ where: { status: 'OPEN' } }),
      this.prisma.review.count({ where: { reports: { some: { status: 'OPEN' } } } }),
      this.prisma.review.findFirst({
        where: { status: 'PENDING' },
        orderBy: { statusChangedAt: 'asc' },
        select: { statusChangedAt: true },
      }),
      this.prisma.review.count({
        where: { status: 'PENDING', statusChangedAt: { lt: staleBefore } },
      }),
    ]);

    const submissions = await this.prisma.$queryRaw<{ day: string; count: bigint }[]>`
      SELECT to_char((created_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day,
             count(*) AS count
      FROM reviews
      WHERE created_at >= ${since}
      GROUP BY 1
      ORDER BY 1`;

    const decisions = await this.prisma.reviewEvent.groupBy({
      by: ['actorId', 'toStatus'],
      where: { kind: 'MODERATED', createdAt: { gte: since } },
      _count: { _all: true },
      orderBy: { actorId: 'asc' },
    });
    const actorIds = [...new Set(decisions.map((d) => d.actorId).filter((v): v is string => !!v))];
    const actors = await this.prisma.user.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, displayName: true },
    });
    const names = new Map(actors.map((a) => [a.id, a.displayName?.trim() || 'Staff member']));
    const perModerator = new Map<string, { name: string; decisions: number; published: number }>();
    for (const d of decisions) {
      if (!d.actorId) continue;
      const m = perModerator.get(d.actorId) ?? {
        name: names.get(d.actorId) ?? 'Staff member',
        decisions: 0,
        published: 0,
      };
      m.decisions += d._count._all;
      if (d.toStatus === 'PUBLISHED') m.published += d._count._all;
      perModerator.set(d.actorId, m);
    }

    const statusCounts = Object.fromEntries(
      (['pending', 'published', 'rejected', 'flagged', 'removed'] as ReviewStatus[]).map((s) => [
        s,
        0,
      ]),
    ) as Record<ReviewStatus, number>;
    for (const g of byStatus)
      statusCounts[fromDbStatus(g.status)] = (g._count as { _all: number })._all;
    const verificationCounts: Record<ReviewVerification, number> = {
      verified_booking: 0,
      demo_booking: 0,
      unverified: 0,
    };
    for (const g of byVerification)
      verificationCounts[fromDbVerification(g.verification)] = (g._count as { _all: number })._all;
    const dist = [1, 2, 3, 4, 5].map(
      (r) =>
        (distribution.find((g) => g.rating === r)?._count as { _all: number } | undefined)?._all ??
        0,
    ) as [number, number, number, number, number];

    return {
      range,
      generatedAt: now.toISOString(),
      byStatus: statusCounts,
      publishedByVerification: verificationCounts,
      openReports,
      reviewsWithOpenReports: reviewsWithReports,
      pending: {
        count: statusCounts.pending,
        oldestAt: oldestPending?.statusChangedAt.toISOString() ?? null,
        olderThan48h,
      },
      distribution: dist,
      submissions: submissions.map((s) => ({ day: s.day, count: Number(s.count) })),
      moderators: [...perModerator.values()].sort(
        (a, b) => b.decisions - a.decisions || a.name.localeCompare(b.name),
      ),
    };
  }

  /** Per reviewed subject: published (counted) reviews, their average, and the moderation backlog. */
  async subjects(q: SubjectsQuery): Promise<AdminReviewSubjects> {
    const type = q.type
      ? Prisma.sql`AND r.subject_type = ${toDbType(q.type)}::review_subject_type`
      : Prisma.empty;
    const counted = Prisma.sql`r.status = 'PUBLISHED' AND (r.booking_id IS NULL OR b.status = 'CONFIRMED')`;
    const [totalRow] = await this.prisma.$queryRaw<{ total: bigint }[]>`
      SELECT count(*) AS total FROM (
        SELECT 1 FROM reviews r WHERE true ${type} GROUP BY r.subject_type, r.subject_key
      ) s`;
    const rows = await this.prisma.$queryRaw<
      {
        subject_type: DbSubjectType;
        subject_key: string;
        subject_name: string;
        published: bigint;
        rating_sum: bigint | null;
        pending: bigint;
        flagged: bigint;
      }[]
    >`
      SELECT r.subject_type, r.subject_key,
             (array_agg(r.subject_name ORDER BY r.created_at DESC))[1] AS subject_name,
             count(*) FILTER (WHERE ${counted}) AS published,
             sum(r.rating) FILTER (WHERE ${counted}) AS rating_sum,
             count(*) FILTER (WHERE r.status = 'PENDING') AS pending,
             count(*) FILTER (WHERE r.status = 'FLAGGED') AS flagged
      FROM reviews r
      LEFT JOIN bookings b ON b.id = r.booking_id
      WHERE true ${type}
      GROUP BY r.subject_type, r.subject_key
      ORDER BY published DESC, r.subject_key ASC
      LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;
    const total = Number(totalRow?.total ?? 0);
    return {
      items: rows.map((r) => {
        const published = Number(r.published);
        return {
          subject: { type: fromDbType(r.subject_type), key: r.subject_key },
          subjectName: r.subject_name,
          published,
          average:
            published >= MIN_REVIEWS_FOR_AVERAGE
              ? averageOf(Number(r.rating_sum ?? 0), published)
              : null,
          pending: Number(r.pending),
          flagged: Number(r.flagged),
        };
      }),
      pagination: {
        page: q.page,
        pageSize: q.pageSize,
        totalResults: total,
        totalPages: Math.ceil(total / q.pageSize),
      },
    };
  }
}
