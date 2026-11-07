import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, MessageSquareText, PenLine, RotateCw } from 'lucide-react';
import { useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  ASPECTS_FOR,
  REVIEW_ASPECT_LABEL,
  REVIEW_BODY_MAX,
  REVIEW_BODY_MIN,
  REVIEW_EDIT_DAYS,
  REVIEW_STATUS_LABEL,
  REVIEW_TITLE_MAX,
  REVIEW_TITLE_MIN,
  type OwnReview,
  type ReviewAspect,
  type ReviewStatus,
  type ReviewSubjectType,
  type ReviewVerification,
} from '@wayora/contracts';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Skeleton,
  Textarea,
  type BadgeTone,
} from '@wayora/ui';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { ApiClientError } from '../../lib/api-client';
import {
  createReview,
  getBookingReviewState,
  getDestinationReviewState,
  getMyReview,
  getMyReviews,
  getReviewableBookings,
  updateReview,
} from '../../services/reviews';
import { AccountShell, Panel } from '../account/AccountShell';
import { tripPath } from '../bookings/paths';
import { SearchPagination } from '../search/results/SearchPagination';
import {
  STAR_WORDS,
  StarInput,
  Stars,
  VerificationBadge,
  formatDay,
  formatMonth,
  messageOf,
} from './components';
import { reviewKeys } from './keys';
import { MY_REVIEWS_PATH, editReviewPath, writeReviewPath } from './paths';

/*
 * The customer's reviews (docs/reviews.md#web): their reviews with status
 * and moderation notes, bookings ready to review, writing (with a preview)
 * and editing. Nothing here decides eligibility or verification: the
 * server does, and its answers are shown as they are.
 */

const STATUS_TONE: Record<ReviewStatus, BadgeTone> = {
  pending: 'warning',
  published: 'success',
  rejected: 'danger',
  flagged: 'warning',
  removed: 'neutral',
};

const fieldErrors = (e: unknown): Record<string, string> =>
  e instanceof ApiClientError
    ? Object.fromEntries(
        e.details.flatMap((d) =>
          d.path ? [[d.path.replace(/^body\./, '').split('.')[0]!, d.message]] : [],
        ),
      )
    : {};

const dateRange = (from: string, to: string | null) => {
  const f = (d: string) =>
    new Intl.DateTimeFormat('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${d}T00:00:00Z`));
  return to && to !== from ? `${f(from)} – ${f(to)}` : f(from);
};

// ─── My reviews ──────────────────────────────────────────────────────────

export function MyReviewsRoute() {
  useDocumentTitle('Your reviews');
  const location = useLocation();
  const flash = (location.state as { saved?: 'created' | 'updated' } | null)?.saved;
  const [page, setPage] = useState(1);
  const mine = useQuery({
    queryKey: reviewKeys.minePage(page),
    queryFn: ({ signal }) => getMyReviews(page, signal),
    placeholderData: (previous) => previous,
  });
  const bookings = useQuery({
    queryKey: reviewKeys.bookings,
    queryFn: ({ signal }) => getReviewableBookings(signal),
  });
  const ready = bookings.data?.items.filter((b) => b.state === 'eligible') ?? [];
  const upcoming = bookings.data?.items.filter((b) => b.state === 'not_yet') ?? [];

  return (
    <AccountShell
      title="Your reviews"
      description="Reviews of your stays and trips, and feedback about destinations. Every review is checked before it appears."
    >
      {flash ? (
        <Alert tone="success" title={flash === 'created' ? 'Review sent' : 'Changes sent'}>
          Our team checks every review before it’s published. You’ll get a notification when it’s
          decided.
        </Alert>
      ) : null}

      <Panel
        title="Ready to review"
        description="Hotel stays and holiday packages you’ve completed. You can review each booking once, from the day after it ends."
      >
        {bookings.isPending ? (
          <Skeleton className="h-16 rounded-lg" />
        ) : bookings.isError ? (
          <p className="text-body-sm text-ink-secondary">
            We couldn’t check your bookings. Try again later.
          </p>
        ) : ready.length === 0 && upcoming.length === 0 ? (
          <p className="text-body-sm text-ink-secondary">
            Nothing to review right now. Completed hotel stays and holiday packages appear here.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {ready.map((b) => (
              <li
                key={b.bookingReference}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <span className="min-w-0">
                  <span className="block font-semibold">{b.subjectName}</span>
                  <Link
                    to={tripPath(b.bookingReference)}
                    className="font-mono text-caption text-ink-secondary hover:underline"
                  >
                    {b.bookingReference}
                  </Link>
                </span>
                <Button asChild size="sm">
                  <Link to={writeReviewPath({ booking: b.bookingReference })}>
                    <PenLine aria-hidden="true" />
                    Write a review
                  </Link>
                </Button>
              </li>
            ))}
            {upcoming.map((b) => (
              <li
                key={b.bookingReference}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <span className="min-w-0">
                  <span className="block font-semibold">{b.subjectName}</span>
                  <span className="text-caption text-ink-secondary">
                    You can review it from{' '}
                    {b.eligibleFrom ? formatDay(`${b.eligibleFrom}T00:00:00Z`) : 'after your trip'}.
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <section aria-labelledby="your-reviews-title" className="flex flex-col gap-4">
        <h2 id="your-reviews-title" className="text-heading-3">
          Written by you
        </h2>
        {mine.isPending ? (
          <div role="status" aria-label="Loading your reviews" className="flex flex-col gap-3">
            <Skeleton className="h-32 rounded-xl" />
            <Skeleton className="h-32 rounded-xl" />
          </div>
        ) : mine.isError ? (
          <ErrorState
            title="We couldn’t load your reviews"
            description="Check your connection and try again."
            action={
              <Button variant="secondary" onClick={() => void mine.refetch()}>
                <RotateCw aria-hidden="true" />
                Try again
              </Button>
            }
          />
        ) : mine.data.items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line-strong bg-card">
            <EmptyState
              icon={<MessageSquareText />}
              title="No reviews yet"
              description="When you write one, you’ll see it here with its status."
            />
          </div>
        ) : (
          <>
            <ul aria-label="Your reviews" className="flex flex-col gap-4">
              {mine.data.items.map((r) => (
                <li key={r.id}>
                  <OwnReviewCard review={r} />
                </li>
              ))}
            </ul>
            <SearchPagination
              page={page}
              totalPages={mine.data.pagination.totalPages}
              onPage={setPage}
            />
          </>
        )}
      </section>
    </AccountShell>
  );
}

function OwnReviewCard({ review }: { review: OwnReview }) {
  return (
    <article className="flex flex-col gap-2 rounded-xl border border-line bg-card p-5 shadow-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge size="sm" tone={STATUS_TONE[review.status]}>
          {REVIEW_STATUS_LABEL[review.status]}
        </Badge>
        <VerificationBadge verification={review.verification} />
        <span className="text-caption text-ink-secondary">{review.subjectName}</span>
      </div>
      <h3 className="text-title">{review.title}</h3>
      <Stars rating={review.rating} />
      <p className="line-clamp-3 whitespace-pre-line text-body-sm text-ink-secondary">
        {review.body}
      </p>
      {review.moderationNote ? (
        <Alert tone={review.status === 'removed' ? 'info' : 'warning'} title="Note from Wayora">
          {review.moderationNote}
        </Alert>
      ) : null}
      <p className="text-caption text-ink-secondary">
        Written <time dateTime={review.createdAt}>{formatDay(review.createdAt)}</time>
        {review.edited ? ' · edited' : ''}
        {review.status === 'published' ? ` · ${review.helpful} found it helpful` : ''}
      </p>
      {review.editableUntil ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild variant="secondary" size="sm">
            <Link to={editReviewPath(review.id)}>
              <PenLine aria-hidden="true" />
              Edit
            </Link>
          </Button>
          <span className="text-caption text-ink-secondary">
            Until {formatDay(review.editableUntil)}. Edited reviews are checked again before they
            reappear.
          </span>
        </div>
      ) : null}
    </article>
  );
}

// ─── Writing and editing ─────────────────────────────────────────────────

interface Draft {
  rating: number | null;
  aspects: Partial<Record<ReviewAspect, number>>;
  title: string;
  body: string;
  visitedMonth: string;
}

interface Target {
  type: ReviewSubjectType;
  name: string;
  verification: ReviewVerification;
  /** For the preview. */
  travelled: { from: string; to: string | null } | null;
}

function ReviewForm({
  target,
  initial,
  submitLabel,
  saving,
  error,
  onSubmit,
  editing = false,
}: {
  editing?: boolean;
  target: Target;
  initial: Draft;
  submitLabel: string;
  saving: boolean;
  error: unknown;
  onSubmit: (draft: Draft) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<Draft>(initial);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState(false);
  const server = useMemo(() => fieldErrors(error), [error]);
  const errors = { ...server, ...problems };
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setProblems((p) => ({ ...p, [k]: '' }));
  };

  const check = () => {
    const p: Record<string, string> = {};
    if (!draft.rating) p.rating = 'Choose a rating from 1 to 5 stars.';
    const title = draft.title.trim();
    if (title.length < REVIEW_TITLE_MIN)
      p.title = `The title needs at least ${REVIEW_TITLE_MIN} characters.`;
    const body = draft.body.trim();
    if (body.length < REVIEW_BODY_MIN)
      p.body = `Your review needs at least ${REVIEW_BODY_MIN} characters.`;
    setProblems(p);
    return Object.keys(p).length === 0;
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (saving || !check()) return;
    onSubmit(draft);
  };

  const aspects = ASPECTS_FOR[target.type];
  const generic = error && Object.keys(server).length === 0 ? messageOf(error) : null;

  return (
    <form
      noValidate
      onSubmit={submit}
      className="flex flex-col gap-6"
      aria-describedby={`${id}-policy`}
    >
      <StarInput
        legend="Overall rating"
        required
        value={draft.rating}
        onChange={(n) => set('rating', n)}
        error={errors.rating || null}
        hint="Rate honestly: low ratings are published like any other."
      />
      {aspects.length > 0 ? (
        <fieldset className="flex flex-col gap-3 rounded-lg border border-line p-4">
          <legend className="px-1 text-label">Rate the details (optional)</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            {aspects.map((a) => (
              <div key={a} className="flex flex-col gap-1">
                <StarInput
                  legend={REVIEW_ASPECT_LABEL[a]}
                  size="sm"
                  value={draft.aspects[a] ?? null}
                  onChange={(n) => set('aspects', { ...draft.aspects, [a]: n })}
                />
                {draft.aspects[a] ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="self-start"
                    onClick={() => {
                      const next = { ...draft.aspects };
                      delete next[a];
                      set('aspects', next);
                    }}
                  >
                    Clear {REVIEW_ASPECT_LABEL[a].toLowerCase()}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        </fieldset>
      ) : null}
      <Field
        label="Title"
        error={errors.title || undefined}
        hint={`${draft.title.trim().length} / ${REVIEW_TITLE_MAX} characters`}
      >
        <Input
          value={draft.title}
          maxLength={REVIEW_TITLE_MAX}
          onChange={(e) => set('title', e.target.value)}
        />
      </Field>
      <Field
        label="Your review"
        error={errors.body || undefined}
        hint={`${draft.body.trim().length.toLocaleString('en-IN')} / ${REVIEW_BODY_MAX.toLocaleString('en-IN')} characters (at least ${REVIEW_BODY_MIN}). What was good, what wasn’t? Don’t include phone numbers, emails or other people’s names.`}
      >
        <Textarea
          rows={8}
          maxLength={REVIEW_BODY_MAX}
          value={draft.body}
          onChange={(e) => set('body', e.target.value)}
        />
      </Field>
      {target.type === 'destination' && !editing ? (
        <Field
          label="When did you visit? (optional)"
          error={errors.visitedMonth || undefined}
          className="sm:max-w-xs"
        >
          <Input
            type="month"
            value={draft.visitedMonth}
            onChange={(e) => set('visitedMonth', e.target.value)}
          />
        </Field>
      ) : null}

      {preview && draft.rating ? (
        <section
          aria-label="Preview"
          className="flex flex-col gap-2 rounded-xl border border-dashed border-brand-300 bg-brand-soft/40 p-5"
        >
          <p className="text-caption font-semibold tracking-wide text-brand-ink uppercase">
            Preview
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Stars rating={draft.rating} />
            <VerificationBadge verification={target.verification} />
          </div>
          <p className="text-title">{draft.title.trim() || 'Your title'}</p>
          <p className="text-caption text-ink-secondary">
            {target.travelled
              ? `Stayed ${dateRange(target.travelled.from, target.travelled.to)}`
              : null}
            {target.type === 'destination' && draft.visitedMonth
              ? `Visited ${formatMonth(draft.visitedMonth)}`
              : null}
          </p>
          <p className="whitespace-pre-line break-words">{draft.body.trim() || 'Your review'}</p>
          {Object.keys(draft.aspects).length > 0 ? (
            <p className="text-caption text-ink-secondary">
              {(Object.entries(draft.aspects) as [ReviewAspect, number][])
                .map(([a, n]) => `${REVIEW_ASPECT_LABEL[a]} ${n}/5 (${STAR_WORDS[n - 1]})`)
                .join(' · ')}
            </p>
          ) : null}
        </section>
      ) : null}

      <p id={`${id}-policy`} className="text-caption text-ink-secondary">
        Our team checks every review before it’s published, and doesn’t change what you write. You
        can edit it for {REVIEW_EDIT_DAYS} days. Wayora doesn’t reward reviews.
      </p>
      {generic ? (
        <Alert tone="danger" title="Not sent">
          {generic}
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" loading={saving}>
          {submitLabel}
        </Button>
        <Button
          type="button"
          variant="secondary"
          aria-pressed={preview}
          disabled={!draft.rating}
          onClick={() => setPreview((p) => !p)}
        >
          <Eye aria-hidden="true" />
          {preview ? 'Hide preview' : 'Preview'}
        </Button>
        <Button asChild variant="ghost">
          <Link to={MY_REVIEWS_PATH}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}

const toBody = (d: Draft) => ({
  rating: d.rating!,
  aspects: d.aspects,
  title: d.title,
  body: d.body,
});

function StateCard({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-card">
      <EmptyState
        icon={<MessageSquareText />}
        title={title}
        description={description}
        action={action}
      />
    </div>
  );
}

export function WriteReviewRoute() {
  const [params] = useSearchParams();
  const booking = params.get('booking');
  const destination = params.get('destination');
  useDocumentTitle('Write a review');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const bookingState = useQuery({
    queryKey: reviewKeys.booking(booking ?? ''),
    queryFn: ({ signal }) => getBookingReviewState(booking!, signal),
    enabled: Boolean(booking),
    retry: false,
  });
  const destinationState = useQuery({
    queryKey: reviewKeys.destination(destination ?? ''),
    queryFn: ({ signal }) => getDestinationReviewState(destination!, signal),
    enabled: Boolean(destination) && !booking,
    retry: false,
  });
  const create = useMutation({
    mutationFn: (d: Draft) =>
      booking
        ? createReview({ kind: 'booking', bookingReference: booking, ...toBody(d) })
        : createReview({
            kind: 'destination',
            destination: destination!,
            visitedMonth: d.visitedMonth || null,
            ...toBody(d),
          }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: reviewKeys.all });
      void navigate(MY_REVIEWS_PATH, { state: { saved: 'created' } });
    },
  });

  let body;
  if (!booking && !destination) {
    body = (
      <StateCard
        title="Choose what to review"
        description="Start from a completed booking on your trips, or from a destination page."
        action={
          <Button asChild variant="secondary">
            <Link to={MY_REVIEWS_PATH}>Your reviews</Link>
          </Button>
        }
      />
    );
  } else if (bookingState.isPending && booking) {
    body = <Skeleton className="h-96 rounded-xl" />;
  } else if (destinationState.isPending && destination && !booking) {
    body = <Skeleton className="h-96 rounded-xl" />;
  } else if (bookingState.isError || destinationState.isError) {
    body = (
      <StateCard
        title={booking ? 'We couldn’t find that booking' : 'We couldn’t find that destination'}
        description={messageOf(bookingState.error ?? destinationState.error)}
      />
    );
  } else if (booking && bookingState.data) {
    const s = bookingState.data;
    if (s.state === 'reviewed' && s.reviewId) {
      body = (
        <StateCard
          title="You’ve reviewed this booking"
          description="Each booking takes one review. You can edit yours instead."
          action={
            <Button asChild>
              <Link to={editReviewPath(s.reviewId)}>Edit your review</Link>
            </Button>
          }
        />
      );
    } else if (s.state !== 'eligible') {
      body = (
        <StateCard
          title={s.state === 'not_yet' ? 'Not yet' : 'This booking can’t be reviewed'}
          description={`${s.reason ?? ''}${s.eligibleFrom ? ` From ${formatDay(`${s.eligibleFrom}T00:00:00Z`)}.` : ''}`}
          action={
            <Button asChild variant="secondary">
              <Link to={tripPath(s.bookingReference)}>Back to the booking</Link>
            </Button>
          }
        />
      );
    } else {
      body = (
        <Panel
          title={s.subjectName ?? 'Your stay'}
          description={`Booking ${s.bookingReference}. Reviewed as a ${s.verification === 'demo_booking' ? 'demo booking: it’s labelled that way' : 'verified booking'}.`}
        >
          <ReviewForm
            target={{
              type: s.subject!.type,
              name: s.subjectName ?? '',
              verification: s.verification!,
              travelled: null,
            }}
            initial={{ rating: null, aspects: {}, title: '', body: '', visitedMonth: '' }}
            submitLabel="Send review"
            saving={create.isPending}
            error={create.error}
            onSubmit={(d) => create.mutate(d)}
          />
        </Panel>
      );
    }
  } else if (destination && destinationState.data) {
    const s = destinationState.data;
    body = s.reviewId ? (
      <StateCard
        title={`You’ve shared feedback about ${s.name}`}
        description="One per destination. You can edit yours instead."
        action={
          <Button asChild>
            <Link to={editReviewPath(s.reviewId)}>Edit your feedback</Link>
          </Button>
        }
      />
    ) : (
      <Panel
        title={s.name}
        description="Destination feedback isn’t tied to a booking, so it’s labelled “Not verified”."
      >
        <ReviewForm
          target={{
            type: 'destination',
            name: s.name,
            verification: 'unverified',
            travelled: null,
          }}
          initial={{ rating: null, aspects: {}, title: '', body: '', visitedMonth: '' }}
          submitLabel="Send feedback"
          saving={create.isPending}
          error={create.error}
          onSubmit={(d) => create.mutate(d)}
        />
      </Panel>
    );
  }

  return (
    <AccountShell
      title={destination && !booking ? 'Share your feedback' : 'Write a review'}
      description="Tell other travellers what it was really like."
    >
      {body}
    </AccountShell>
  );
}

export function EditReviewRoute() {
  const { id = '' } = useParams();
  useDocumentTitle('Edit your review');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const review = useQuery({
    queryKey: reviewKeys.own(id),
    queryFn: ({ signal }) => getMyReview(id, signal),
    retry: false,
  });
  const save = useMutation({
    mutationFn: (d: Draft) => updateReview(id, { ...toBody(d), revision: review.data!.revision }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: reviewKeys.all });
      void navigate(MY_REVIEWS_PATH, { state: { saved: 'updated' } });
    },
  });
  let body;
  if (review.isPending) body = <Skeleton className="h-96 rounded-xl" />;
  else if (review.isError)
    body = <StateCard title="We couldn’t find that review" description={messageOf(review.error)} />;
  else if (!review.data.editableUntil)
    body = (
      <StateCard
        title="This review can’t be edited"
        description={
          review.data.status === 'removed'
            ? 'It was removed.'
            : review.data.status === 'flagged'
              ? 'Our team is checking it.'
              : `Reviews can be edited for ${REVIEW_EDIT_DAYS} days after they’re written.`
        }
        action={
          <Button asChild variant="secondary">
            <Link to={MY_REVIEWS_PATH}>Your reviews</Link>
          </Button>
        }
      />
    );
  else {
    const r = review.data;
    body = (
      <Panel
        title={r.subjectName}
        description={`Saving sends it back to our team before it reappears${r.status === 'published' ? ' (it’s hidden until then)' : ''}.`}
      >
        <ReviewForm
          target={{
            type: r.subject.type,
            name: r.subjectName,
            verification: r.verification,
            travelled: r.travelled,
          }}
          initial={{
            rating: r.rating,
            aspects: r.aspects,
            title: r.title,
            body: r.body,
            visitedMonth: r.visitedMonth ?? '',
          }}
          editing
          submitLabel="Save changes"
          saving={save.isPending}
          error={save.error}
          onSubmit={(d) => save.mutate(d)}
        />
      </Panel>
    );
  }
  return (
    <AccountShell title="Edit your review" description="Change your rating or what you wrote.">
      {body}
    </AccountShell>
  );
}
