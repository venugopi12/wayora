import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, LogOut, RotateCw, Send, Trash2, UserPlus, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import {
  createTripInvitationSchema,
  type MemberRole,
  type PlannedTrip,
  type SentInvitation,
  type TripMember,
  type TripMembers,
} from '@wayora/contracts';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Dialog,
  DialogContent,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  Skeleton,
  useToast,
} from '@wayora/ui';
import { ApiClientError } from '../../lib/api-client';
import {
  changeMemberRole,
  getTripMembers,
  inviteToTrip,
  removeMember,
  revokeInvitation,
} from '../../services/planner';
import { plannerKeys } from './keys';
import { PLANS_PATH, invitationPath } from './paths';

/*
 * Members of a plan (docs/planner.md#collaboration): who can see and edit it,
 * and — for the owner — inviting people, changing roles, removing members and
 * revoking invitations. Members see names only, never email addresses; the
 * owner sees invitees' addresses masked. The API enforces every rule; the
 * controls here only reflect them.
 */

export const ROLE_LABEL: Record<'owner' | MemberRole, string> = {
  owner: 'Owner',
  editor: 'Editor',
  viewer: 'Viewer',
};
const ROLE_HINT: Record<MemberRole, string> = {
  editor: 'Can change the itinerary and the plan’s details',
  viewer: 'Can see the plan, but not change it',
};

const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const errorText = (error: unknown) =>
  error instanceof ApiClientError && error.code !== 'NETWORK_ERROR'
    ? error.message
    : 'Check your connection and try again.';

/** Small stacked avatars for the plan header. */
export function MemberAvatars({ members }: { members: TripMembers | undefined }) {
  if (!members) return null;
  const people = [members.owner, ...members.members];
  const shown = people.slice(0, 4);
  return (
    <span className="flex items-center" aria-hidden="true">
      {shown.map((p, i) => (
        <Avatar key={`${p.name}-${i}`} name={p.name} size="sm" className={i > 0 ? '-ml-2' : ''} />
      ))}
      {people.length > shown.length ? (
        <span className="-ml-2 grid size-8 place-items-center rounded-full bg-sunken text-caption font-semibold text-ink-secondary ring-2 ring-card">
          +{people.length - shown.length}
        </span>
      ) : null}
    </span>
  );
}

export function MembersDialog({
  trip,
  open,
  onOpenChange,
}: {
  trip: PlannedTrip;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const query = useQuery({
    queryKey: plannerKeys.members(trip.id),
    queryFn: ({ signal }) => getTripMembers(trip.id, signal),
    enabled: open,
  });
  const manage = trip.access.canManage;

  let body;
  if (query.isPending) {
    body = (
      <div role="status" aria-label="Loading members" className="flex flex-col gap-3">
        <Skeleton className="h-12 rounded-lg" />
        <Skeleton className="h-12 rounded-lg" />
      </div>
    );
  } else if (query.isError) {
    body = (
      <ErrorState
        title="We couldn't load the members"
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
    );
  } else {
    body = <MembersBody trip={trip} members={query.data} />;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        title={manage ? 'Share this plan' : 'People on this plan'}
        description={
          manage
            ? 'Invite people with a Wayora account. Editors can change the plan; viewers can only look. Only you can invite, change roles or remove people.'
            : 'Everyone who can see this plan. Only its owner can invite people or change roles.'
        }
      >
        {body}
      </DialogContent>
    </Dialog>
  );
}

function MembersBody({ trip, members }: { trip: PlannedTrip; members: TripMembers }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const manage = members.access.canManage;
  const [confirm, setConfirm] = useState<
    | { kind: 'remove'; member: TripMember }
    | { kind: 'leave'; member: TripMember }
    | { kind: 'revoke'; invitation: SentInvitation }
    | null
  >(null);

  const refresh = (next?: TripMembers) => {
    if (next) queryClient.setQueryData(plannerKeys.members(trip.id), next);
    else void queryClient.invalidateQueries({ queryKey: plannerKeys.members(trip.id) });
    void queryClient.invalidateQueries({ queryKey: plannerKeys.detail(trip.id) });
    void queryClient.invalidateQueries({ queryKey: plannerKeys.activity(trip.id) });
  };

  const role = useMutation({
    mutationFn: (vars: { member: TripMember; role: MemberRole }) =>
      changeMemberRole(trip.id, vars.member.id, vars.role),
    onSuccess: (next, vars) => {
      refresh(next);
      toast({
        tone: 'success',
        title: `${vars.member.name} is now ${ROLE_LABEL[vars.role].toLowerCase()}`,
      });
    },
    onError: (error) =>
      toast({ tone: 'danger', title: 'Role not changed', description: errorText(error) }),
  });
  const remove = useMutation({
    mutationFn: (member: TripMember) => removeMember(trip.id, member.id),
    onSuccess: (_void, member) => {
      setConfirm(null);
      if (member.isYou) {
        // Left the plan: it's no longer ours to show.
        toast({ tone: 'success', title: `You left “${trip.title}”` });
        queryClient.removeQueries({ queryKey: plannerKeys.members(trip.id) });
        void queryClient.invalidateQueries({ queryKey: plannerKeys.lists });
        void navigate(PLANS_PATH, { replace: true });
        return;
      }
      refresh();
      toast({ tone: 'success', title: `${member.name} was removed from the plan` });
    },
    onError: (error) => {
      setConfirm(null);
      toast({ tone: 'danger', title: 'Not removed', description: errorText(error) });
    },
  });
  const revoke = useMutation({
    mutationFn: (invitation: SentInvitation) => revokeInvitation(trip.id, invitation.id),
    onSuccess: (_i, invitation) => {
      setConfirm(null);
      refresh();
      toast({ tone: 'success', title: `Invitation to ${invitation.invitee.name} withdrawn` });
    },
    onError: (error) => {
      setConfirm(null);
      refresh();
      toast({ tone: 'danger', title: 'Not withdrawn', description: errorText(error) });
    },
  });

  return (
    <div className="flex flex-col gap-6 pb-2">
      <section aria-labelledby="members-heading" className="flex flex-col gap-2">
        <h3 id="members-heading" className="text-title">
          Members{' '}
          <span className="text-body-sm font-normal text-ink-secondary">
            ({members.members.length + 1})
          </span>
        </h3>
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
          <li className="flex flex-wrap items-center gap-3 p-3">
            <Avatar name={members.owner.name} size="sm" decorative />
            <span className="min-w-0 flex-1 text-body text-ink">
              {members.owner.name}
              {members.owner.isYou ? <span className="text-ink-secondary"> (you)</span> : null}
            </span>
            <Badge size="sm" tone="brand">
              Owner
            </Badge>
          </li>
          {members.members.map((member) => (
            <li key={member.id} className="flex flex-wrap items-center gap-3 p-3">
              <Avatar name={member.name} size="sm" decorative />
              <span className="min-w-0 flex-1 text-body text-ink">
                {member.name}
                {member.isYou ? <span className="text-ink-secondary"> (you)</span> : null}
              </span>
              {manage ? (
                <span className="flex flex-wrap items-center gap-2">
                  <Select
                    aria-label={`Role for ${member.name}`}
                    value={member.role}
                    disabled={role.isPending}
                    onChange={(e) => role.mutate({ member, role: e.target.value as MemberRole })}
                    options={[
                      { value: 'editor', label: 'Editor' },
                      { value: 'viewer', label: 'Viewer' },
                    ]}
                    className="w-32"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${member.name}`}
                    onClick={() => setConfirm({ kind: 'remove', member })}
                  >
                    <Trash2 aria-hidden="true" />
                    Remove
                  </Button>
                </span>
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  <Badge size="sm" tone="neutral">
                    {ROLE_LABEL[member.role]}
                  </Badge>
                  {member.isYou ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirm({ kind: 'leave', member })}
                    >
                      <LogOut aria-hidden="true" />
                      Leave plan
                    </Button>
                  ) : null}
                </span>
              )}
            </li>
          ))}
        </ul>
        {members.members.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title="Just you so far"
            description={manage ? 'Invite someone below to plan together.' : undefined}
          />
        ) : null}
      </section>

      {manage ? (
        <>
          <section aria-labelledby="invitations-heading" className="flex flex-col gap-2">
            <h3 id="invitations-heading" className="text-title">
              Open invitations
            </h3>
            {members.invitations.length === 0 ? (
              <p className="text-body-sm text-ink-secondary">No open invitations.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
                {members.invitations.map((invitation) => (
                  <li key={invitation.id} className="flex flex-wrap items-center gap-3 p-3">
                    <Avatar name={invitation.invitee.name} size="sm" decorative />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-body text-ink">{invitation.invitee.name}</span>
                      <span className="text-caption text-ink-secondary">
                        {invitation.invitee.emailMasked} · {ROLE_LABEL[invitation.role]} · open
                        until {dateFormat.format(new Date(invitation.expiresAt))}
                      </span>
                    </span>
                    <Badge size="sm" tone="warning">
                      Invited
                    </Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Withdraw the invitation to ${invitation.invitee.name}`}
                      onClick={() => setConfirm({ kind: 'revoke', invitation })}
                    >
                      Withdraw
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <InviteForm trip={trip} members={members} onInvited={() => refresh()} />
        </>
      ) : null}

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        {confirm ? (
          <DialogContent
            size="sm"
            title={
              confirm.kind === 'remove'
                ? `Remove ${confirm.member.name}?`
                : confirm.kind === 'leave'
                  ? 'Leave this plan?'
                  : `Withdraw the invitation to ${confirm.invitation.invitee.name}?`
            }
            description={
              confirm.kind === 'remove'
                ? 'They’ll lose access to this plan straight away. Their activities stay in the plan.'
                : confirm.kind === 'leave'
                  ? 'You’ll lose access to this plan straight away. The owner can invite you again.'
                  : 'They won’t be able to accept it. You can invite them again later.'
            }
            footer={
              <>
                <Button variant="secondary" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  loading={remove.isPending || revoke.isPending}
                  disabled={remove.isPending || revoke.isPending}
                  onClick={() =>
                    confirm.kind === 'revoke'
                      ? revoke.mutate(confirm.invitation)
                      : remove.mutate(confirm.member)
                  }
                >
                  {confirm.kind === 'remove'
                    ? 'Remove'
                    : confirm.kind === 'leave'
                      ? 'Leave plan'
                      : 'Withdraw'}
                </Button>
              </>
            }
          />
        ) : null}
      </Dialog>
    </div>
  );
}

function InviteForm({
  trip,
  members,
  onInvited,
}: {
  trip: PlannedTrip;
  members: TripMembers;
  onInvited: () => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('editor');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<SentInvitation | null>(null);
  const [copied, setCopied] = useState(false);
  const full = members.limits.used >= members.limits.maxMembers;
  const invite = useMutation({
    mutationFn: () => inviteToTrip(trip.id, { email, role }),
    onSuccess: (invitation) => {
      setSent(invitation);
      setEmail('');
      setCopied(false);
      onInvited();
    },
    onError: (e) => {
      setError(
        e instanceof ApiClientError && e.code === 'VALIDATION_FAILED'
          ? (e.details.find((d) => d.path === 'body.email')?.message ?? e.message)
          : errorText(e),
      );
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSent(null);
    const parsed = createTripInvitationSchema.safeParse({ email, role });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a valid email address.');
      return;
    }
    invite.mutate();
  };

  const link = sent ? `${window.location.origin}${invitationPath(sent.id)}` : '';

  return (
    <section aria-labelledby="invite-heading" className="flex flex-col gap-3">
      <h3 id="invite-heading" className="flex items-center gap-2 text-title">
        <UserPlus className="size-5" aria-hidden="true" />
        Invite someone
      </h3>
      {full ? (
        <Alert tone="info">
          This plan has {members.limits.maxMembers} members and invitations, the most it can have.
        </Alert>
      ) : (
        <form noValidate onSubmit={submit} className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <Field
              label="Their email address"
              hint="They need a Wayora account with this address."
              error={error ?? undefined}
            >
              <Input
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Role" hint={ROLE_HINT[role]}>
              <Select
                value={role}
                onChange={(e) => setRole(e.target.value as MemberRole)}
                options={[
                  { value: 'editor', label: 'Editor' },
                  { value: 'viewer', label: 'Viewer' },
                ]}
              />
            </Field>
          </div>
          <Button
            type="submit"
            className="self-start"
            loading={invite.isPending}
            disabled={invite.isPending}
          >
            <Send aria-hidden="true" />
            Send invitation
          </Button>
        </form>
      )}
      {sent ? (
        <Alert tone="success" title={`Invitation sent to ${sent.invitee.name} in Wayora`}>
          <p>
            They’ll see it in their notifications and under Trip planner. No email is sent. You can
            also share this link with them — it only works when they’re signed in to their own
            account:
          </p>
          <span className="mt-2 flex flex-wrap items-center gap-2">
            <code className="max-w-full rounded bg-card px-2 py-1 text-caption break-all text-ink">
              {link}
            </code>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(link).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied ? 'Copied' : 'Copy link'}
            </Button>
          </span>
        </Alert>
      ) : null}
    </section>
  );
}
