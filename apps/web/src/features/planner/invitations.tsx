import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarRange, Check, MailOpen, MapPin, RotateCw, SearchX, X } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { tripInvitationIdSchema, type ReceivedInvitation } from '@wayora/contracts';
import {
  Alert,
  Badge,
  Breadcrumbs,
  Button,
  Container,
  EmptyState,
  ErrorState,
  Skeleton,
  useToast,
} from '@wayora/ui';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { ApiClientError } from '../../lib/api-client';
import {
  getReceivedInvitation,
  listReceivedInvitations,
  respondToInvitation,
} from '../../services/planner';
import { notificationKeys } from '../notifications/keys';
import { formatDateRange } from './format';
import { plannerKeys } from './keys';
import { ROLE_LABEL } from './members';
import { PLANS_PATH, planPath } from './paths';

/*
 * Invitations addressed to the signed-in user (docs/planner.md#invitations):
 * a panel on /plans and a page per invitation (/plans/invitations/:id, the
 * link the owner may share). Only the invited account, signed in, can see or
 * answer one; for anyone else the API says it doesn't exist.
 */

const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const STATUS: Record<ReceivedInvitation['status'], string> = {
  pending: 'Waiting for your answer',
  accepted: 'You accepted this invitation',
  declined: 'You declined this invitation',
  revoked: 'The owner withdrew this invitation',
  expired: 'This invitation has expired',
};

function useRespond() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (vars: { invitation: ReceivedInvitation; answer: 'accept' | 'decline' }) =>
      respondToInvitation(vars.invitation.id, vars.answer),
    onSuccess: (result, vars) => {
      queryClient.setQueryData(plannerKeys.invitation(vars.invitation.id), result.invitation);
      void queryClient.invalidateQueries({ queryKey: plannerKeys.invitations });
      void queryClient.invalidateQueries({ queryKey: plannerKeys.lists });
      void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
      if (result.tripId) {
        toast({ tone: 'success', title: `You joined “${vars.invitation.trip.title}”` });
        void navigate(planPath(result.tripId));
      } else {
        toast({ tone: 'success', title: 'Invitation declined' });
      }
    },
    onError: (error, vars) => {
      void queryClient.invalidateQueries({ queryKey: plannerKeys.invitation(vars.invitation.id) });
      void queryClient.invalidateQueries({ queryKey: plannerKeys.invitations });
      toast({
        tone: 'danger',
        title: 'That didn’t work',
        description:
          error instanceof ApiClientError && error.code !== 'NETWORK_ERROR'
            ? error.message
            : 'Check your connection and try again.',
      });
    },
  });
}

function InvitationSummary({ invitation }: { invitation: ReceivedInvitation }) {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="text-title break-words">{invitation.trip.title}</span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm text-ink-secondary">
        <span className="flex items-center gap-1">
          <MapPin className="size-3.5" aria-hidden="true" />
          {invitation.trip.destinationName}
        </span>
        <span className="flex items-center gap-1">
          <CalendarRange className="size-3.5" aria-hidden="true" />
          {formatDateRange(invitation.trip.startDate, invitation.trip.endDate)}
        </span>
      </span>
      <span className="text-body-sm text-ink-secondary">
        {invitation.invitedBy?.name ?? 'Someone'} invited you as{' '}
        {ROLE_LABEL[invitation.role].toLowerCase()}
        {invitation.status === 'pending'
          ? ` · open until ${dateFormat.format(new Date(invitation.expiresAt))}`
          : ''}
      </span>
    </span>
  );
}

function Answer({ invitation }: { invitation: ReceivedInvitation }) {
  const respond = useRespond();
  const busy = respond.isPending;
  return (
    <span className="flex flex-wrap gap-2">
      <Button
        size="sm"
        loading={busy && respond.variables?.answer === 'accept'}
        disabled={busy}
        onClick={() => respond.mutate({ invitation, answer: 'accept' })}
      >
        <Check aria-hidden="true" />
        Accept
        <span className="sr-only">: {invitation.trip.title}</span>
      </Button>
      <Button
        size="sm"
        variant="secondary"
        loading={busy && respond.variables?.answer === 'decline'}
        disabled={busy}
        onClick={() => respond.mutate({ invitation, answer: 'decline' })}
      >
        <X aria-hidden="true" />
        Decline
        <span className="sr-only">: {invitation.trip.title}</span>
      </Button>
    </span>
  );
}

/** Open invitations, shown above the plan list (nothing when there are none). */
export function InvitationsPanel() {
  const query = useQuery({
    queryKey: plannerKeys.invitations,
    queryFn: ({ signal }) => listReceivedInvitations(signal),
  });
  if (!query.data || query.data.items.length === 0) return null;
  return (
    <section
      aria-labelledby="received-invitations-heading"
      className="flex flex-col gap-3 rounded-xl border border-brand-200 bg-brand-soft/40 p-4 sm:p-5"
    >
      <h2 id="received-invitations-heading" className="flex items-center gap-2 text-title">
        <MailOpen className="size-5 text-brand" aria-hidden="true" />
        {query.data.items.length === 1 ? 'An invitation' : `${query.data.items.length} invitations`}
      </h2>
      <ul className="flex flex-col gap-3">
        {query.data.items.map((invitation) => (
          <li
            key={invitation.id}
            className="flex flex-col gap-3 rounded-lg bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <InvitationSummary invitation={invitation} />
            <Answer invitation={invitation} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** /plans/invitations/:invitationId */
export function InvitationRoute() {
  const { invitationId = '' } = useParams();
  const valid = tripInvitationIdSchema.safeParse(invitationId).success;
  const query = useQuery({
    queryKey: plannerKeys.invitation(invitationId),
    queryFn: ({ signal }) => getReceivedInvitation(invitationId, signal),
    enabled: valid,
    retry: false,
  });
  useDocumentTitle('Plan invitation');

  let body;
  if (
    !valid ||
    (query.isError && query.error instanceof ApiClientError && query.error.status === 404)
  ) {
    body = (
      <div className="rounded-xl border border-dashed border-line-strong bg-card">
        <EmptyState
          size="page"
          titleAs="h1"
          icon={<SearchX />}
          title="We couldn't find that invitation"
          description="Invitations work only for the account they were sent to. Check that you’re signed in to the right account."
          action={
            <Button asChild>
              <Link to={PLANS_PATH}>Go to the trip planner</Link>
            </Button>
          }
        />
      </div>
    );
  } else if (query.isPending) {
    body = (
      <div role="status" aria-label="Loading the invitation" className="flex flex-col gap-3">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
    );
  } else if (query.isError) {
    body = (
      <>
        <h1 className="sr-only">Plan invitation</h1>
        <ErrorState
          title="We couldn't load this invitation"
          description="Check your connection, then try again."
          action={
            <Button
              variant="secondary"
              onClick={() => void query.refetch()}
              loading={query.isFetching}
            >
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          }
        />
      </>
    );
  } else {
    const invitation = query.data;
    body = (
      <div className="flex flex-col gap-5">
        <h1 className="text-heading-1">You’re invited to plan a trip</h1>
        <div className="flex flex-col gap-4 rounded-xl border border-line bg-card p-5 shadow-xs sm:p-7">
          <span className="flex flex-wrap items-center gap-2">
            <Badge size="sm" tone={invitation.status === 'pending' ? 'warning' : 'neutral'}>
              {STATUS[invitation.status]}
            </Badge>
          </span>
          <InvitationSummary invitation={invitation} />
          <p className="text-body-sm text-ink-secondary">
            {invitation.role === 'editor'
              ? 'As an editor you can change the itinerary and the plan’s details.'
              : 'As a viewer you can see the plan but not change it.'}{' '}
            Other members will see your name, not your email address. A plan isn’t a booking:
            nothing is reserved or paid for.
          </p>
          {invitation.status === 'pending' ? (
            <Answer invitation={invitation} />
          ) : invitation.status === 'accepted' ? (
            <Button asChild className="self-start">
              <Link to={planPath(invitation.trip.id)}>Open the plan</Link>
            </Button>
          ) : (
            <Alert tone="info" role="none">
              {invitation.status === 'expired'
                ? 'Ask the plan’s owner to invite you again.'
                : 'There’s nothing more to do here.'}
            </Alert>
          )}
        </div>
      </div>
    );
  }

  return (
    <Container size="narrow" className="py-section-sm">
      <div className="flex flex-col gap-6">
        <Breadcrumbs
          items={[
            { label: 'Home', link: <Link to="/" /> },
            { label: 'Trip planner', link: <Link to={PLANS_PATH} /> },
            { label: 'Invitation' },
          ]}
        />
        {body}
      </div>
    </Container>
  );
}
