import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import {
  MIN_REVIEWS_FOR_AVERAGE,
  REPORT_REASON_LABEL,
  REVIEW_ASPECT_LABEL,
  REVIEW_STATUSES,
  REVIEW_SUBJECT_LABEL,
  REVIEW_SUBJECT_TYPES,
  REVIEW_VERIFICATIONS,
  REVIEW_VERIFICATION_LABEL,
  type AdminReview,
  type ModerationAction,
  type ReviewAspect,
  type ReviewMetricsRange,
  type ReviewStatus,
} from '@wayora/contracts';
import { Alert, Badge, Button, Field, Input, type BadgeTone } from '@wayora/ui';
import { ApiClientError } from '../../lib/api-client';
import {
  adminDismissReports,
  adminModerateReview,
  adminReview,
  adminReviewMetrics,
  adminReviewSubjects,
  adminReviews,
} from '../../services/reviews';
import { Stars } from '../reviews/components';
import { useCan } from './AdminLayout';
import { formatUtc, humanize } from './format';
import { adminKeys } from './keys';
import { ADMIN_PATHS } from './paths';
import {
  AdminPage,
  BarList,
  DetailList,
  EmptyRows,
  FilterBar,
  Note,
  Pager,
  QueryView,
  Section,
  Stat,
  StatGrid,
  Table,
  useFilters,
} from './ui';

/*
 * Review moderation and analytics (Phase 28, docs/reviews.md#moderation).
 * Reading needs admin.reviews.read; publishing, rejecting, flagging and
 * dismissing reports need admin.reviews.moderate; removing needs
 * admin.reviews.remove. The page shows only the actions the server says
 * this person may take on this review (never on their own review).
 */

const link = 'font-medium text-brand-ink underline-offset-2 hover:underline';
const STATUS_TONE: Record<ReviewStatus, BadgeTone> = {
  pending: 'warning',
  published: 'success',
  rejected: 'danger',
  flagged: 'warning',
  removed: 'neutral',
};
const STATUS_TEXT: Record<ReviewStatus, string> = {
  pending: 'Pending',
  published: 'Published',
  rejected: 'Rejected',
  flagged: 'Flagged',
  removed: 'Removed',
};
const errorText = (error: unknown) =>
  error instanceof ApiClientError
    ? [error.message, ...error.details.map((d) => d.message)].join(' ')
    : 'Something went wrong. Try again.';

function StatusBadge({ status }: { status: ReviewStatus }) {
  return (
    <Badge size="sm" tone={STATUS_TONE[status]}>
      {STATUS_TEXT[status]}
    </Badge>
  );
}

// ─── Dashboard ───────────────────────────────────────────────────────────

const RANGES: { value: ReviewMetricsRange; label: string }[] = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
];

export function ReviewsDashboardRoute() {
  const [params, setParams] = useSearchParams();
  const range = (RANGES.find((r) => r.value === params.get('range'))?.value ??
    '30d') as ReviewMetricsRange;
  const [subjectsPage, setSubjectsPage] = useState(1);
  const metrics = useQuery({
    queryKey: adminKeys.view('review-metrics', range),
    queryFn: ({ signal }) => adminReviewMetrics(range, signal),
  });
  const subjects = useQuery({
    queryKey: adminKeys.view('review-subjects', subjectsPage),
    queryFn: ({ signal }) => adminReviewSubjects({ page: subjectsPage }, signal),
    placeholderData: (previous) => previous,
  });
  return (
    <AdminPage
      title="Reviews"
      description="Customer reviews and destination feedback: what’s waiting for a decision, what’s been reported, and how ratings look."
      actions={
        <div role="group" aria-label="Time range" className="flex gap-1">
          {RANGES.map((r) => (
            <Button
              key={r.value}
              size="sm"
              variant={r.value === range ? 'secondary' : 'ghost'}
              aria-pressed={r.value === range}
              onClick={() => setParams({ range: r.value })}
            >
              {r.label}
            </Button>
          ))}
        </div>
      }
    >
      <div className="flex flex-wrap gap-3 text-body-sm">
        <Link to={`${ADMIN_PATHS.reviewQueue}?status=pending`} className={link}>
          Waiting for moderation
        </Link>
        <Link to={`${ADMIN_PATHS.reviewQueue}?reported=true&sort=reports`} className={link}>
          Reported
        </Link>
        <Link to={`${ADMIN_PATHS.reviewQueue}?status=flagged`} className={link}>
          Flagged
        </Link>
        <Link to={ADMIN_PATHS.reviewQueue} className={link}>
          All reviews
        </Link>
      </div>
      <QueryView query={metrics} label="review metrics">
        {(m) => (
          <>
            <Section title="Right now">
              <StatGrid>
                <Stat
                  label="Waiting for moderation"
                  value={String(m.pending.count)}
                  hint={
                    m.pending.oldestAt
                      ? `Oldest since ${formatUtc(m.pending.oldestAt)} · ${m.pending.olderThan48h} older than 48 h`
                      : 'Nothing waiting'
                  }
                />
                <Stat label="Published" value={String(m.byStatus.published)} />
                <Stat label="Flagged" value={String(m.byStatus.flagged)} />
                <Stat
                  label="Open reports"
                  value={String(m.openReports)}
                  hint={`On ${m.reviewsWithOpenReports} ${m.reviewsWithOpenReports === 1 ? 'review' : 'reviews'}`}
                />
                <Stat label="Rejected" value={String(m.byStatus.rejected)} />
                <Stat label="Removed" value={String(m.byStatus.removed)} />
              </StatGrid>
            </Section>
            <div className="grid gap-6 lg:grid-cols-2">
              <Section title="Published ratings">
                <BarList
                  label="Published reviews by rating"
                  items={Object.fromEntries(
                    [5, 4, 3, 2, 1].map((s) => [String(s), m.distribution[s - 1]!]),
                  )}
                  format={(k) => `${k} ${k === '1' ? 'star' : 'stars'}`}
                />
              </Section>
              <Section title="Published, by verification">
                <BarList
                  label="Published reviews by verification"
                  items={m.publishedByVerification}
                  format={(k) =>
                    REVIEW_VERIFICATION_LABEL[k as keyof typeof REVIEW_VERIFICATION_LABEL]
                  }
                />
              </Section>
            </div>
            <Section title={`Written in the last ${RANGES.find((r) => r.value === range)!.label}`}>
              {m.submissions.length === 0 ? (
                <p className="text-body-sm text-ink-secondary">
                  No reviews were written in this period.
                </p>
              ) : (
                <BarList
                  label="Reviews written per day"
                  items={Object.fromEntries(m.submissions.map((s) => [s.day, s.count]))}
                  format={(k) => k}
                />
              )}
            </Section>
            <Section title="Moderation workload">
              {m.moderators.length === 0 ? (
                <p className="text-body-sm text-ink-secondary">
                  No moderation decisions in this period.
                </p>
              ) : (
                <Table label="Moderation decisions" head={['Moderator', 'Decisions', 'Published']}>
                  {m.moderators.map((x) => (
                    <tr key={x.name}>
                      <td>{x.name}</td>
                      <td className="numeric">{x.decisions}</td>
                      <td className="numeric">{x.published}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Section>
            <Note>
              Counts come from stored reviews and moderation history. Published counts and ratings
              include only reviews the public can see: published, and for booking reviews only while
              the booking is still confirmed. Rejected, removed, pending and flagged reviews never
              count. Days are India dates.
            </Note>
          </>
        )}
      </QueryView>
      <Section title="By hotel, package and destination">
        <QueryView query={subjects} label="reviewed places">
          {(s) =>
            s.items.length === 0 ? (
              <p className="text-body-sm text-ink-secondary">No reviews yet.</p>
            ) : (
              <>
                <Table
                  label="Reviewed places"
                  head={['Name', 'Type', 'Published', 'Average', 'Pending', 'Flagged']}
                >
                  {s.items.map((i) => (
                    <tr key={`${i.subject.type}:${i.subject.key}`}>
                      <td>
                        <Link
                          to={`${ADMIN_PATHS.reviewQueue}?q=${encodeURIComponent(i.subject.key)}`}
                          className={link}
                        >
                          {i.subjectName}
                        </Link>
                      </td>
                      <td>{REVIEW_SUBJECT_LABEL[i.subject.type]}</td>
                      <td className="numeric">{i.published}</td>
                      <td className="numeric">
                        {i.average !== null ? (
                          i.average.toFixed(1)
                        ) : (
                          <span className="text-ink-secondary">—</span>
                        )}
                      </td>
                      <td className="numeric">{i.pending}</td>
                      <td className="numeric">{i.flagged}</td>
                    </tr>
                  ))}
                </Table>
                {s.pagination.totalPages > 1 ? (
                  <div className="mt-3 flex gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={subjectsPage <= 1}
                      onClick={() => setSubjectsPage((n) => n - 1)}
                    >
                      Previous
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={subjectsPage >= s.pagination.totalPages}
                      onClick={() => setSubjectsPage((n) => n + 1)}
                    >
                      Next
                    </Button>
                  </div>
                ) : null}
                <p className="mt-3 text-caption text-ink-secondary">
                  “—”: fewer than {MIN_REVIEWS_FOR_AVERAGE} published reviews, so no average is
                  shown (to the public either).
                </p>
              </>
            )
          }
        </QueryView>
      </Section>
    </AdminPage>
  );
}

// ─── Queue ───────────────────────────────────────────────────────────────

export function ReviewQueueRoute() {
  const { values, page } = useFilters([
    'status',
    'type',
    'verification',
    'reported',
    'rating',
    'q',
    'sort',
  ]);
  const query = useQuery({
    queryKey: adminKeys.view('reviews', values, page),
    queryFn: ({ signal }) => adminReviews({ ...values, page } as never, signal),
    placeholderData: (previous) => previous,
  });
  return (
    <AdminPage
      title="Review queue"
      description="Oldest first by default, so nothing waits too long."
      back={{ to: ADMIN_PATHS.reviews, label: 'Reviews' }}
    >
      <FilterBar
        label="Filter reviews"
        specs={[
          { name: 'q', label: 'Place or title', kind: 'text' },
          {
            name: 'status',
            label: 'Status',
            kind: 'select',
            options: REVIEW_STATUSES.map((s) => ({ value: s, label: STATUS_TEXT[s] })),
          },
          {
            name: 'type',
            label: 'Type',
            kind: 'select',
            options: REVIEW_SUBJECT_TYPES.map((t) => ({
              value: t,
              label: REVIEW_SUBJECT_LABEL[t],
            })),
          },
          {
            name: 'verification',
            label: 'Verification',
            kind: 'select',
            options: REVIEW_VERIFICATIONS.map((v) => ({
              value: v,
              label: REVIEW_VERIFICATION_LABEL[v],
            })),
          },
          {
            name: 'reported',
            label: 'Reports',
            kind: 'select',
            options: [
              { value: 'true', label: 'Has open reports' },
              { value: 'false', label: 'No open reports' },
            ],
          },
          {
            name: 'rating',
            label: 'Rating',
            kind: 'select',
            options: [5, 4, 3, 2, 1].map((n) => ({ value: String(n), label: `${n} stars` })),
          },
          {
            name: 'sort',
            label: 'Order',
            kind: 'select',
            options: [
              { value: 'oldest', label: 'Waiting longest' },
              { value: 'newest', label: 'Newest' },
              { value: 'reports', label: 'Most reports' },
            ],
          },
        ]}
      />
      <QueryView query={query} label="reviews">
        {(data) =>
          data.items.length === 0 ? (
            <EmptyRows what="reviews" />
          ) : (
            <>
              <Table
                label="Reviews"
                head={['Review', 'Place', 'Rating', 'Status', 'Reports', 'Written']}
              >
                {data.items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={ADMIN_PATHS.review(r.id)} className={link}>
                        {r.title}
                      </Link>
                      <span className="block text-caption text-ink-secondary">
                        {r.author} · {REVIEW_VERIFICATION_LABEL[r.verification]}
                      </span>
                    </td>
                    <td>
                      {r.subjectName}
                      <span className="block text-caption text-ink-secondary">
                        {REVIEW_SUBJECT_LABEL[r.subject.type]}
                      </span>
                    </td>
                    <td>
                      <Stars rating={r.rating} />
                    </td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="numeric">
                      {r.openReports > 0 ? (
                        <Badge size="sm" tone="danger">
                          {r.openReports} open
                        </Badge>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="whitespace-nowrap">{formatUtc(r.createdAt)}</td>
                  </tr>
                ))}
              </Table>
              <Pager pagination={data.pagination} label="Reviews" />
            </>
          )
        }
      </QueryView>
    </AdminPage>
  );
}

// ─── One review ──────────────────────────────────────────────────────────

const ACTION_LABEL: Record<ModerationAction, string> = {
  publish: 'Publish',
  reject: 'Reject',
  flag: 'Flag for checking',
  remove: 'Remove',
};
const ACTION_HINT: Record<ModerationAction, string> = {
  publish: 'Visible to everyone and counted in the rating. The author is notified.',
  reject: 'Not published. The author sees your reason and can edit and resend it.',
  flag: 'Hidden while it’s checked. The author isn’t notified.',
  remove:
    'Taken down for good (a policy violation). The author sees your reason. Only administrators can remove.',
};

export function AdminReviewRoute() {
  const { id = '' } = useParams();
  const query = useQuery({
    queryKey: adminKeys.view('review', id),
    queryFn: ({ signal }) => adminReview(id, signal),
  });
  return (
    <AdminPage
      title={query.data?.title ?? 'Review'}
      back={{ to: ADMIN_PATHS.reviewQueue, label: 'Review queue' }}
    >
      <QueryView query={query} label="this review" notFound="There is no review with that id.">
        {(r) => <ReviewWorkspace review={r} />}
      </QueryView>
    </AdminPage>
  );
}

function ReviewWorkspace({ review: r }: { review: AdminReview }) {
  const canModerate = useCan('admin.reviews.moderate');
  const queryClient = useQueryClient();
  const [action, setAction] = useState<ModerationAction | null>(null);
  const [reason, setReason] = useState('');
  const [dismissReason, setDismissReason] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const afterChange = (next: AdminReview, message: string) => {
    queryClient.setQueryData(adminKeys.view('review', r.id), next);
    void queryClient.invalidateQueries({ queryKey: adminKeys.view('reviews') });
    void queryClient.invalidateQueries({ queryKey: adminKeys.view('review-metrics') });
    setAction(null);
    setReason('');
    setDismissReason('');
    setDone(message);
  };
  const moderate = useMutation({
    mutationFn: (a: ModerationAction) =>
      adminModerateReview(r.id, { action: a, reason: reason.trim() || null, revision: r.revision }),
    onSuccess: (next, a) =>
      afterChange(
        next,
        `${ACTION_LABEL[a]}: done. Status is now ${STATUS_TEXT[next.status].toLowerCase()}.`,
      ),
  });
  const dismiss = useMutation({
    mutationFn: () =>
      adminDismissReports(r.id, { reason: dismissReason.trim(), revision: r.revision }),
    onSuccess: (next) => afterChange(next, 'Reports dismissed. The review stays as it is.'),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (action) moderate.mutate(action);
  };
  const aspects = Object.entries(r.aspects) as [ReviewAspect, number][];

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-w-0 flex-col gap-6">
        {done ? (
          <Alert tone="success" title="Saved">
            {done}
          </Alert>
        ) : null}
        <Section title="Review">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={r.status} />
              <Badge size="sm" tone="neutral">
                {REVIEW_VERIFICATION_LABEL[r.verification]}
              </Badge>
              <Stars rating={r.rating} />
            </div>
            <p className="text-title">{r.title}</p>
            <p className="whitespace-pre-line break-words">{r.body}</p>
            {aspects.length > 0 ? (
              <p className="text-body-sm text-ink-secondary">
                {aspects.map(([a, n]) => `${REVIEW_ASPECT_LABEL[a]} ${n}/5`).join(' · ')}
              </p>
            ) : null}
            {r.moderationNote ? (
              <p className="text-body-sm text-ink-secondary">
                Latest moderation note: “{r.moderationNote}”
              </p>
            ) : null}
          </div>
        </Section>
        {r.reports.length > 0 ? (
          <Section title="Reports" description="Reporters are never shown, here or anywhere else.">
            <Table label="Reports" head={['Reason', 'Details', 'Status', 'Sent']}>
              {r.reports.map((p) => (
                <tr key={p.id}>
                  <td>{REPORT_REASON_LABEL[p.reason]}</td>
                  <td className="whitespace-pre-line">{p.details ?? '—'}</td>
                  <td>{humanize(p.status)}</td>
                  <td className="whitespace-nowrap">{formatUtc(p.createdAt)}</td>
                </tr>
              ))}
            </Table>
            {canModerate && r.allowed.dismissReports ? (
              <form
                className="mt-4 flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  dismiss.mutate();
                }}
              >
                <Field
                  label="Reason for dismissing"
                  hint="At least 5 characters. The review stays as it is."
                >
                  <Input value={dismissReason} onChange={(e) => setDismissReason(e.target.value)} />
                </Field>
                {dismiss.isError ? (
                  <Alert tone="danger" title="Not dismissed">
                    {errorText(dismiss.error)}
                  </Alert>
                ) : null}
                <Button
                  type="submit"
                  variant="secondary"
                  size="sm"
                  className="self-start"
                  loading={dismiss.isPending}
                  disabled={dismissReason.trim().length < 5}
                >
                  Dismiss open reports
                </Button>
              </form>
            ) : null}
          </Section>
        ) : null}
        {r.revisions.length > 1 ? (
          <Section title="Versions" description="Every version the author wrote, oldest first.">
            <ol className="flex flex-col gap-4">
              {r.revisions.map((v) => (
                <li key={v.revision} className="rounded-lg border border-line p-3">
                  <p className="text-caption text-ink-secondary">
                    Version {v.revision} · {formatUtc(v.createdAt)} · {v.rating} stars
                  </p>
                  <p className="font-semibold">{v.title}</p>
                  <p className="whitespace-pre-line text-body-sm">{v.body}</p>
                </li>
              ))}
            </ol>
          </Section>
        ) : null}
        <Section title="History">
          <ol aria-label="Review history" className="flex flex-col gap-2 text-body-sm">
            {r.history.map((h, i) => (
              <li key={i} className="flex flex-wrap gap-x-2">
                <time dateTime={h.at} className="text-ink-secondary">
                  {formatUtc(h.at)}
                </time>
                <span className="font-medium">{h.actor.name}</span>
                <span>
                  {humanize(h.event)}
                  {h.from || h.to
                    ? `: ${h.from ? STATUS_TEXT[h.from] : '—'} → ${h.to ? STATUS_TEXT[h.to] : '—'}`
                    : ''}
                </span>
                {h.reason ? <span className="text-ink-secondary">“{h.reason}”</span> : null}
              </li>
            ))}
          </ol>
        </Section>
      </div>
      <div className="flex flex-col gap-6">
        <Section title="Details">
          <DetailList
            items={[
              ['Place', `${r.subjectName} (${REVIEW_SUBJECT_LABEL[r.subject.type]})`],
              ['Author', r.author],
              [
                'Booking',
                r.bookingReference ? (
                  <Link
                    to={ADMIN_PATHS.booking(r.bookingReference)}
                    className={`${link} font-mono`}
                  >
                    {r.bookingReference}
                  </Link>
                ) : (
                  'None (destination feedback)'
                ),
              ],
              ...(r.bookingStatus
                ? [['Booking status now', humanize(r.bookingStatus)] as [string, string]]
                : []),
              ['Written', formatUtc(r.createdAt)],
              ['Published', r.publishedAt ? formatUtc(r.publishedAt) : 'No'],
              ['Helpful votes', String(r.helpful)],
            ]}
          />
        </Section>
        <Section title="Decision">
          {r.allowed.ownReview ? (
            <Note>This is your own review, so someone else has to moderate it.</Note>
          ) : !canModerate ? (
            <Note>Moderating reviews needs moderation access.</Note>
          ) : r.allowed.actions.length === 0 ? (
            <Note>No decisions are possible: a removed review is final.</Note>
          ) : (
            <form className="flex flex-col gap-3" onSubmit={submit}>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-label">Action</legend>
                {r.allowed.actions.map((a) => (
                  <label key={a} className="flex items-start gap-2 text-body-sm">
                    <input
                      type="radio"
                      name="moderation-action"
                      value={a}
                      checked={action === a}
                      onChange={() => setAction(a)}
                      className="mt-1"
                    />
                    <span>
                      <span className="font-semibold">{ACTION_LABEL[a]}</span>
                      <span className="block text-caption text-ink-secondary">
                        {ACTION_HINT[a]}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {action && action !== 'publish' ? (
                <Field
                  label="Reason"
                  hint={
                    action === 'flag'
                      ? 'At least 5 characters. Kept with the review’s history.'
                      : 'At least 5 characters. The author sees it.'
                  }
                >
                  <Input
                    value={reason}
                    maxLength={300}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </Field>
              ) : null}
              {r.openReports > 0 && action ? (
                <p className="text-caption text-ink-secondary">
                  Its {r.openReports} open {r.openReports === 1 ? 'report is' : 'reports are'}{' '}
                  closed with this decision.
                </p>
              ) : null}
              {moderate.isError ? (
                <Alert tone="danger" title="Not saved">
                  {errorText(moderate.error)}
                </Alert>
              ) : null}
              <Button
                type="submit"
                variant={action === 'remove' || action === 'reject' ? 'destructive' : 'primary'}
                loading={moderate.isPending}
                disabled={!action || (action !== 'publish' && reason.trim().length < 5)}
                className="self-start"
              >
                {action ? ACTION_LABEL[action] : 'Choose an action'}
              </Button>
              <p className="text-caption text-ink-secondary">
                Decide on what it says, not whether the rating is low. Reviews aren’t edited by
                Wayora.
              </p>
            </form>
          )}
        </Section>
      </div>
    </div>
  );
}
