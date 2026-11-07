import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { Flag, MessageSquareText, RotateCw, Star, ThumbsUp } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import {
  RATING_MAX,
  REPORT_REASONS,
  REPORT_REASON_LABEL,
  REVIEW_ASPECT_LABEL,
  REVIEW_VERIFICATION_LABEL,
  REVIEW_SORTS,
  type PublicReview,
  type RatingSummary,
  type ReportReason,
  type ReviewSort,
  type ReviewSubject,
  type ReviewVerification,
} from '@wayora/contracts';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  EmptyState,
  ErrorState,
  Field,
  RatingBadge,
  Select,
  Skeleton,
  Textarea,
  cn,
} from '@wayora/ui';
import { ApiClientError } from '../../lib/api-client';
import { getReviews, reportReview, setHelpful } from '../../services/reviews';
import { useAuth } from '../auth/AuthProvider';
import { SIGN_IN_PATH } from '../navigation/config';
import { SearchPagination } from '../search/results/SearchPagination';
import { reviewKeys } from './keys';

/*
 * Review building blocks (docs/reviews.md#web). Everything shown comes from
 * the server: averages, counts, verification and votes are never computed
 * or assumed here. Review text is rendered as text, never as HTML.
 */

export const messageOf = (error: unknown) =>
  error instanceof ApiClientError ? error.message : 'Something went wrong. Try again.';

const dayFmt = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const monthFmt = new Intl.DateTimeFormat('en-IN', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
export const formatDay = (iso: string) => dayFmt.format(new Date(iso));
export const formatMonth = (ym: string) => monthFmt.format(new Date(`${ym}-01T00:00:00Z`));
const formatDate = (day: string) =>
  new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));

const FROM_KIND: Record<ReviewVerification, string> = {
  verified_booking: 'from verified bookings',
  demo_booking: 'from demo bookings',
  unverified: 'not verified',
};

export const STAR_WORDS = ['Terrible', 'Poor', 'Okay', 'Good', 'Excellent'] as const;

// ─── Stars ───────────────────────────────────────────────────────────────

/** Whole-star rating, announced as one phrase. */
export function Stars({ rating, size = 'sm' }: { rating: number; size?: 'sm' | 'md' }) {
  return (
    <span
      role="img"
      aria-label={`${rating} out of ${RATING_MAX} stars`}
      className="inline-flex gap-0.5"
    >
      {Array.from({ length: RATING_MAX }, (_, i) => (
        <Star
          key={i}
          aria-hidden="true"
          className={cn(
            size === 'md' ? 'size-5' : 'size-4',
            i < rating ? 'fill-brand text-brand' : 'fill-transparent text-line-strong',
          )}
        />
      ))}
    </span>
  );
}

/**
 * Star input: a radio group (arrow keys move between stars; Space or a click
 * chooses). Unset until the customer chooses: no star is preselected.
 */
export function StarInput({
  legend,
  value,
  onChange,
  error,
  hint,
  required = false,
  size = 'md',
}: {
  legend: string;
  value: number | null;
  onChange: (value: number) => void;
  error?: string | null;
  hint?: string;
  required?: boolean;
  size?: 'sm' | 'md';
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value ?? 0;
  return (
    <fieldset
      className="flex flex-col gap-1.5"
      aria-describedby={
        [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].join(' ').trim() || undefined
      }
      aria-invalid={error ? true : undefined}
    >
      <legend className="mb-1 text-label text-ink">
        {legend}
        {required ? <span className="text-ink-secondary"> (required)</span> : null}
      </legend>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex" onMouseLeave={() => setHover(null)}>
          {Array.from({ length: RATING_MAX }, (_, i) => {
            const n = i + 1;
            return (
              <label
                key={n}
                className={cn(
                  'relative flex cursor-pointer items-center justify-center rounded-md',
                  size === 'md' ? 'size-11' : 'size-9',
                  'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus',
                )}
                onMouseEnter={() => setHover(n)}
              >
                <input
                  type="radio"
                  name={`${id}-stars`}
                  value={n}
                  checked={value === n}
                  onChange={() => onChange(n)}
                  className="peer sr-only"
                  aria-label={`${n} ${n === 1 ? 'star' : 'stars'}: ${STAR_WORDS[i]}`}
                />
                <Star
                  aria-hidden="true"
                  className={cn(
                    'transition-colors duration-150',
                    size === 'md' ? 'size-7' : 'size-6',
                    n <= shown ? 'fill-brand text-brand' : 'fill-transparent text-line-strong',
                  )}
                />
              </label>
            );
          })}
        </div>
        <span className="min-w-20 text-body-sm text-ink-secondary" aria-hidden="true">
          {shown ? STAR_WORDS[shown - 1] : 'Not rated'}
        </span>
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="text-caption text-ink-secondary">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-caption font-medium text-danger-ink">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

export function VerificationBadge({ verification }: { verification: ReviewVerification }) {
  const tone =
    verification === 'verified_booking'
      ? 'success'
      : verification === 'demo_booking'
        ? 'brand'
        : 'neutral';
  return (
    <Badge size="sm" tone={tone}>
      {REVIEW_VERIFICATION_LABEL[verification]}
    </Badge>
  );
}

// ─── Summary ─────────────────────────────────────────────────────────────

/** Average (once there are enough reviews), count, distribution and category ratings. */
export function RatingSummaryPanel({ summary }: { summary: RatingSummary }) {
  const max = Math.max(1, ...summary.distribution);
  const kinds = (Object.entries(summary.byVerification) as [ReviewVerification, number][]).filter(
    ([, n]) => n > 0,
  );
  return (
    <div className="grid gap-6 rounded-xl border border-line bg-card p-5 shadow-xs md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
      <div className="flex flex-col gap-2">
        {summary.average !== null ? (
          <>
            <RatingBadge score={summary.average} outOf={5} reviewCount={summary.count} />
            <Stars rating={Math.round(summary.average)} size="md" />
          </>
        ) : (
          <p className="text-body-sm text-ink-secondary">
            {summary.count === 0
              ? 'No published reviews yet.'
              : `${summary.count} published ${summary.count === 1 ? 'review' : 'reviews'}. An average appears from ${summary.minimumForAverage}.`}
          </p>
        )}
        {kinds.length > 0 ? (
          <p className="text-caption text-ink-secondary">
            {kinds.map(([k, n]) => `${n} ${FROM_KIND[k]}`).join(' · ')}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-4">
        <dl aria-label="Rating distribution" className="flex flex-col gap-1.5">
          {[5, 4, 3, 2, 1].map((stars) => {
            const n = summary.distribution[stars - 1]!;
            return (
              <div
                key={stars}
                className="grid grid-cols-[4.5rem_minmax(0,1fr)_2rem] items-center gap-2"
              >
                <dt className="text-body-sm text-ink-secondary">
                  {stars} {stars === 1 ? 'star' : 'stars'}
                </dt>
                <dd className="contents">
                  <span aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-sunken">
                    <span
                      className="block h-full rounded-full bg-brand"
                      style={{ width: `${(n / max) * 100}%` }}
                    />
                  </span>
                  <span className="numeric text-right text-body-sm">{n}</span>
                </dd>
              </div>
            );
          })}
        </dl>
        {summary.aspects.some((a) => a.count > 0) ? (
          <dl aria-label="Category ratings" className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {summary.aspects.map((a) => (
              <div
                key={a.aspect}
                className="flex items-baseline justify-between gap-3 text-body-sm"
              >
                <dt className="text-ink-secondary">{REVIEW_ASPECT_LABEL[a.aspect]}</dt>
                <dd className="numeric">
                  {a.average !== null ? (
                    <>
                      {a.average.toFixed(1)}
                      <span className="sr-only"> out of 5</span>
                    </>
                  ) : (
                    <span className="text-ink-secondary">
                      {a.count === 0 ? 'Not rated' : `${a.count} rated`}
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </div>
  );
}

// ─── One review ──────────────────────────────────────────────────────────

function HelpfulButton({ review, subject }: { review: PublicReview; subject: ReviewSubject }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState({
    helpful: review.helpful,
    voted: review.viewer?.votedHelpful ?? false,
  });
  const vote = useMutation({
    mutationFn: (helpful: boolean) => setHelpful(review.id, helpful),
    onSuccess: (data) => {
      setState({ helpful: data.helpful, voted: data.votedHelpful });
      void queryClient.invalidateQueries({
        queryKey: reviewKeys.subject(subject.type, subject.key),
      });
    },
  });
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant={state.voted ? 'secondary' : 'ghost'}
        size="sm"
        aria-pressed={state.voted}
        loading={vote.isPending}
        onClick={() => vote.mutate(!state.voted)}
      >
        <ThumbsUp aria-hidden="true" />
        Helpful
      </Button>
      {vote.isError ? (
        <span className="text-caption text-danger-ink">{messageOf(vote.error)}</span>
      ) : null}
    </span>
  );
}

function ReportButton({ review }: { review: PublicReview }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason | ''>('');
  const [details, setDetails] = useState('');
  const [done, setDone] = useState(review.viewer?.reported ?? false);
  const report = useMutation({
    mutationFn: () =>
      reportReview(review.id, { reason: reason as ReportReason, details: details.trim() || null }),
    onSuccess: () => {
      setDone(true);
      setOpen(false);
    },
  });
  if (done) {
    return (
      <span className="text-caption text-ink-secondary">
        Reported. Thanks, our team will look at it.
      </span>
    );
  }
  const missingDetails = reason === 'other' && details.trim().length < 10;
  return (
    <Dialog open={open} onOpenChange={(o) => !report.isPending && setOpen(o)}>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Flag aria-hidden="true" />
        Report
      </Button>
      <DialogContent
        title="Report this review"
        description="Tell us what’s wrong. The author isn’t told who reported it, and a report doesn’t remove a review by itself: our team checks it."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={report.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => report.mutate()}
              loading={report.isPending}
              disabled={!reason || missingDetails}
            >
              Send report
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Reason">
            <Select
              value={reason}
              placeholder="Choose a reason"
              onChange={(e) => setReason(e.target.value as ReportReason)}
              options={REPORT_REASONS.map((r) => ({ value: r, label: REPORT_REASON_LABEL[r] }))}
            />
          </Field>
          <Field
            label={reason === 'other' ? 'Details' : 'Details (optional)'}
            hint="Up to 500 characters. Don’t include personal information."
          >
            <Textarea
              rows={3}
              maxLength={500}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
            />
          </Field>
          {report.isError ? (
            <Alert tone="danger" title="Not sent">
              {messageOf(report.error)}
            </Alert>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ReviewCard({
  review,
  subject,
  headingLevel = 'h3',
}: {
  review: PublicReview;
  subject: ReviewSubject;
  headingLevel?: 'h3' | 'h4';
}) {
  const { status } = useAuth();
  const Heading = headingLevel;
  const aspects = Object.entries(review.aspects) as [keyof typeof REVIEW_ASPECT_LABEL, number][];
  const canAct = status === 'authenticated' && review.viewer && !review.viewer.own;
  return (
    <article className="flex flex-col gap-3 rounded-xl border border-line bg-card p-5 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Stars rating={review.rating} />
        <VerificationBadge verification={review.verification} />
      </div>
      <Heading className="text-title text-ink">{review.title}</Heading>
      <p className="text-caption text-ink-secondary">
        {review.author}
        {review.travelled
          ? ` · stayed ${formatDate(review.travelled.from)}${review.travelled.to && review.travelled.to !== review.travelled.from ? ` – ${formatDate(review.travelled.to)}` : ''}`
          : review.visitedMonth
            ? ` · visited ${formatMonth(review.visitedMonth)}`
            : ''}
        {' · '}
        <time dateTime={review.publishedAt}>{formatDay(review.publishedAt)}</time>
        {review.edited ? ' · edited' : ''}
      </p>
      <p className="text-body whitespace-pre-line break-words text-ink">{review.body}</p>
      {aspects.length > 0 ? (
        <ul aria-label="Category ratings" className="flex flex-wrap gap-2">
          {aspects.map(([a, n]) => (
            <li key={a} className="rounded-md bg-sunken px-2 py-1 text-caption">
              {REVIEW_ASPECT_LABEL[a]}: <span className="numeric font-semibold">{n}</span>
              <span className="sr-only"> out of 5</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-caption text-ink-secondary">
          {review.helpful === 0
            ? 'No helpful votes yet'
            : `${review.helpful} ${review.helpful === 1 ? 'person' : 'people'} found this helpful`}
        </span>
        {canAct ? (
          <>
            <HelpfulButton review={review} subject={subject} />
            <ReportButton review={review} />
          </>
        ) : review.viewer?.own ? (
          <span className="text-caption text-ink-secondary">Your review</span>
        ) : null}
      </div>
    </article>
  );
}

// ─── A subject's reviews ─────────────────────────────────────────────────

const SORT_LABEL: Record<ReviewSort, string> = {
  recent: 'Most recent',
  highest: 'Highest rated',
  lowest: 'Lowest rated',
  helpful: 'Most helpful',
};

/**
 * The public reviews of a hotel, package or destination: summary, sort and
 * star filter, paged list. Shows nothing invented when there are none.
 */
export function ReviewsSection({
  subject,
  title = 'Reviews',
  action,
  note,
}: {
  subject: ReviewSubject;
  title?: string;
  /** e.g. "Share your feedback" for destinations. */
  action?: ReactNode;
  /** What the reviews are (verification), shown under the heading. */
  note?: ReactNode;
}) {
  const id = useId();
  const location = useLocation();
  const { status } = useAuth();
  const [sort, setSort] = useState<ReviewSort>('recent');
  const [rating, setRating] = useState<number | ''>('');
  const [page, setPage] = useState(1);
  const params = { sort, page, ...(rating ? { rating } : {}) };
  const reviews = useQuery({
    queryKey: reviewKeys.list(subject.type, subject.key, params),
    queryFn: ({ signal }) =>
      getReviews({ type: subject.type, key: subject.key, pageSize: 10, ...params }, signal),
    placeholderData: (previous) => previous,
  });
  const data = reviews.data;

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h2 id={`${id}-title`} className="text-heading-3">
            {title}
          </h2>
          {note ? <p className="max-w-2xl text-body-sm text-ink-secondary">{note}</p> : null}
        </div>
        {action}
      </div>
      {reviews.isPending ? (
        <div role="status" aria-label="Loading reviews" className="flex flex-col gap-4">
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-36 rounded-xl" />
        </div>
      ) : reviews.isError ? (
        <ErrorState
          title="We couldn’t load reviews"
          description="Check your connection and try again."
          action={
            <Button variant="secondary" onClick={() => void reviews.refetch()}>
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          }
        />
      ) : data!.summary.count === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong bg-card">
          <EmptyState
            icon={<MessageSquareText />}
            title="No reviews yet"
            description={
              subject.type === 'destination'
                ? 'Been here? Your feedback helps other travellers.'
                : 'Reviews come from customers who booked and completed their stay or trip.'
            }
          />
        </div>
      ) : (
        <>
          <RatingSummaryPanel summary={data!.summary} />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label="Sort by" className="sm:w-48">
              <Select
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value as ReviewSort);
                  setPage(1);
                }}
                options={REVIEW_SORTS.map((s) => ({ value: s, label: SORT_LABEL[s] }))}
              />
            </Field>
            <Field label="Show" className="sm:w-48">
              <Select
                value={String(rating)}
                onChange={(e) => {
                  setRating(e.target.value ? Number(e.target.value) : '');
                  setPage(1);
                }}
                options={[
                  { value: '', label: 'All ratings' },
                  ...[5, 4, 3, 2, 1].map((n) => ({
                    value: String(n),
                    label: `${n} ${n === 1 ? 'star' : 'stars'} (${data!.summary.distribution[n - 1]})`,
                  })),
                ]}
              />
            </Field>
          </div>
          <p role="status" aria-live="polite" className="sr-only">
            {`${data!.pagination.totalResults} ${data!.pagination.totalResults === 1 ? 'review' : 'reviews'} shown`}
          </p>
          {data!.items.length === 0 ? (
            <p className="text-body-sm text-ink-secondary">No reviews with this rating.</p>
          ) : (
            <ul
              aria-label={`${title}: page ${data!.pagination.page}`}
              className="flex flex-col gap-4"
            >
              <AnimatePresence initial={false}>
                {data!.items.map((r) => (
                  <motion.li
                    key={r.id}
                    layout="position"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <ReviewCard review={r} subject={subject} />
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
          <SearchPagination
            page={data!.pagination.page}
            totalPages={data!.pagination.totalPages}
            onPage={setPage}
          />
          {status !== 'authenticated' ? (
            <p className="text-caption text-ink-secondary">
              <Link
                to={`${SIGN_IN_PATH}?redirect=${encodeURIComponent(location.pathname + location.search)}`}
                className="font-semibold text-brand-ink hover:underline"
              >
                Sign in
              </Link>{' '}
              to mark reviews helpful or report one.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
