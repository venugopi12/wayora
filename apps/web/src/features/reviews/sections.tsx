import { useQuery } from '@tanstack/react-query';
import { PenLine } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { reviewSubjectOf, type SearchResult } from '@wayora/contracts';
import { Button } from '@wayora/ui';
import { getDestinationReviewState } from '../../services/reviews';
import { useAuth } from '../auth/AuthProvider';
import { SIGN_IN_PATH } from '../navigation/config';
import { ReviewsSection } from './components';
import { reviewKeys } from './keys';
import { editReviewPath, writeReviewPath } from './paths';

/*
 * Reviews on public pages (docs/reviews.md#web): a hotel's or package's
 * offer page, and destination pages. Each says what kind of reviews they are.
 */

/** On an offer page: the property's or package's reviews, when it has a reliable identity. */
export function OfferReviews({ result }: { result: SearchResult }) {
  const subject = reviewSubjectOf(result);
  if (!subject) return null;
  return (
    <ReviewsSection
      subject={subject}
      title={subject.type === 'hotel' ? 'Guest reviews' : 'Traveller reviews'}
      note="Written by Wayora customers after a completed booking here, and checked before publishing. Every booking today is a demo, so these are labelled “Demo booking”."
    />
  );
}

/** On a destination page: traveller feedback (not verified), and a way to add yours. */
export function DestinationReviews({ slug, name }: { slug: string; name: string }) {
  const { status } = useAuth();
  const location = useLocation();
  const mine = useQuery({
    queryKey: reviewKeys.destination(slug),
    queryFn: ({ signal }) => getDestinationReviewState(slug, signal),
    enabled: status === 'authenticated',
    retry: false,
  });
  const action =
    status === 'authenticated' ? (
      mine.data?.reviewId ? (
        <Button asChild variant="secondary" size="sm">
          <Link to={editReviewPath(mine.data.reviewId)}>Edit your feedback</Link>
        </Button>
      ) : (
        <Button asChild variant="secondary" size="sm">
          <Link to={writeReviewPath({ destination: slug })}>
            <PenLine aria-hidden="true" />
            Share your feedback
          </Link>
        </Button>
      )
    ) : (
      <Button asChild variant="secondary" size="sm">
        <Link to={`${SIGN_IN_PATH}?redirect=${encodeURIComponent(location.pathname)}`}>
          Sign in to share feedback
        </Link>
      </Button>
    );
  return (
    <ReviewsSection
      subject={{ type: 'destination', key: slug }}
      title={`Traveller feedback on ${name}`}
      action={action}
      note="From signed-in Wayora customers, checked before publishing. It isn’t tied to a booking, so it’s marked “Not verified”."
    />
  );
}
