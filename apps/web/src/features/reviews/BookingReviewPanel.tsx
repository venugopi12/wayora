import { useQuery } from '@tanstack/react-query';
import { PenLine } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@wayora/ui';
import { getBookingReviewState } from '../../services/reviews';
import { Panel } from '../account/AccountShell';
import { formatDay } from './components';
import { reviewKeys } from './keys';
import { MY_REVIEWS_PATH, editReviewPath, writeReviewPath } from './paths';

/**
 * On a hotel or package booking's page: whether it can be reviewed, and a
 * way to do it. The server decides eligibility; nothing is assumed here.
 * Shows nothing for bookings that can never be reviewed.
 */
export function BookingReviewPanel({ reference }: { reference: string }) {
  const state = useQuery({
    queryKey: reviewKeys.booking(reference),
    queryFn: ({ signal }) => getBookingReviewState(reference, signal),
    retry: false,
  });
  const s = state.data;
  if (!s || (s.state === 'not_eligible' && !s.subject)) return null;
  return (
    <Panel title="Your review" description={s.subjectName ?? undefined}>
      {s.state === 'eligible' ? (
        <div className="flex flex-col gap-3">
          <p className="text-body-sm text-ink-secondary">
            How was it? Your review helps other travellers.
            {s.verification === 'demo_booking' ? ' It will be labelled “Demo booking”.' : ''}
          </p>
          <Button asChild size="sm" className="self-start">
            <Link to={writeReviewPath({ booking: reference })}>
              <PenLine aria-hidden="true" />
              Write a review
            </Link>
          </Button>
        </div>
      ) : s.state === 'reviewed' && s.reviewId ? (
        <p className="text-body-sm text-ink-secondary">
          You’ve reviewed this booking.{' '}
          <Link
            to={editReviewPath(s.reviewId)}
            className="font-semibold text-brand-ink hover:underline"
          >
            Edit it
          </Link>{' '}
          or see{' '}
          <Link to={MY_REVIEWS_PATH} className="font-semibold text-brand-ink hover:underline">
            your reviews
          </Link>
          .
        </p>
      ) : (
        <p className="text-body-sm text-ink-secondary">
          {s.reason}
          {s.eligibleFrom ? ` From ${formatDay(`${s.eligibleFrom}T00:00:00Z`)}.` : ''}
        </p>
      )}
    </Panel>
  );
}
