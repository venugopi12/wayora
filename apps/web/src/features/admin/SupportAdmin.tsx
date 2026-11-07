import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Lock, Sparkles, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import {
  SUPPORT_CATEGORIES,
  SUPPORT_CATEGORY_LABEL,
  SUPPORT_MESSAGE_MAX,
  SUPPORT_PRIORITIES,
  SUPPORT_PRIORITY_LABEL,
  SUPPORT_STATUSES,
  SUPPORT_STATUS_STAFF_LABEL,
  SUPPORT_TARGET_HOURS,
  supportReferenceSchema,
  type AdminSupportMessage,
  type AdminSupportTicket,
  type AdminSupportTicketSummary,
  type SupportAiSuggestion,
  type SupportBookingContext,
  type SupportPriority,
  type SupportStatus,
} from '@wayora/contracts';
import { Alert, Badge, Button, Checkbox, Field, Input, Select, Textarea, cn } from '@wayora/ui';
import { ApiClientError } from '../../lib/api-client';
import {
  adminSupportAi,
  adminSupportAssign,
  adminSupportEscalate,
  adminSupportEventsUrl,
  adminSupportMarkRead,
  adminSupportMessages,
  adminSupportMetrics,
  adminSupportPriority,
  adminSupportReply,
  adminSupportStaff,
  adminSupportStatus,
  adminSupportTicket,
  adminSupportTickets,
} from '../../services/support';
import { PriorityBadge, TicketStatusBadge, formatMoment, newClientKey } from '../support/format';
import { useTicketLiveUpdates } from '../support/live';
import { useAuth } from '../auth/AuthProvider';
import { useCan } from './AdminLayout';
import { formatPercent, humanize } from './format';
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
  RangePicker,
  Section,
  Stat,
  StatGrid,
  Table,
  useFilters,
  useRange,
} from './ui';

/*
 * Support workspace (Phase 27, docs/support.md#agent-workspace). Reading needs
 * admin.support.read; replying, notes and status need admin.support.manage;
 * assigning others and escalated tickets need admin.support.supervise. The
 * page only offers what the server's `allowed` says; the API checks again.
 */

const link = 'font-medium text-brand-ink underline-offset-2 hover:underline';
const mono = 'font-mono text-caption';
const errorText = (e: unknown) =>
  e instanceof ApiClientError ? e.message : 'Something went wrong. Try again.';

const minutes = (m: number | null) =>
  m === null
    ? '—'
    : m < 60
      ? `${Math.round(m)} min`
      : m < 48 * 60
        ? `${(m / 60).toFixed(1)} h`
        : `${(m / 1440).toFixed(1)} days`;

/** History values: status and priority codes as their labels; staff names as they are. */
function historyValue(value: string): string {
  const key = value.toLowerCase();
  if ((SUPPORT_STATUSES as readonly string[]).includes(key))
    return SUPPORT_STATUS_STAFF_LABEL[key as (typeof SUPPORT_STATUSES)[number]];
  if ((SUPPORT_PRIORITIES as readonly string[]).includes(key))
    return SUPPORT_PRIORITY_LABEL[key as (typeof SUPPORT_PRIORITIES)[number]];
  return value;
}

function TargetCell({
  t,
  label,
}: {
  t: AdminSupportTicketSummary['firstResponse'];
  label: string;
}) {
  const tone = { met: 'success', missed: 'danger', overdue: 'danger', pending: 'neutral' } as const;
  return (
    <span className="flex flex-col gap-0.5">
      <Badge size="sm" tone={tone[t.state]}>
        {t.state === 'pending' ? `Due ${formatMoment(t.dueAt)}` : `${label} ${t.state}`}
      </Badge>
    </span>
  );
}

// ─── Dashboard ───────────────────────────────────────────────────────────

/** /admin/support */
export function SupportDashboardRoute() {
  const range = useRange();
  const metrics = useQuery({
    queryKey: adminKeys.view('support-metrics', range),
    queryFn: ({ signal }) => adminSupportMetrics(range, signal),
  });
  return (
    <AdminPage
      title="Support"
      description="Customer support requests: what’s waiting, how quickly support responds, and who is working on what."
      actions={<RangePicker />}
    >
      <div className="flex flex-wrap gap-3 text-body-sm">
        <Link to={`${ADMIN_PATHS.supportQueue}?view=mine&status=active`} className={link}>
          My tickets
        </Link>
        <Link to={`${ADMIN_PATHS.supportQueue}?view=unassigned`} className={link}>
          Unassigned
        </Link>
        <Link to={`${ADMIN_PATHS.supportQueue}?view=escalated`} className={link}>
          Escalated
        </Link>
        <Link to={`${ADMIN_PATHS.supportQueue}?overdue=true`} className={link}>
          Overdue
        </Link>
        <Link to={ADMIN_PATHS.supportQueue} className={link}>
          All tickets
        </Link>
      </div>
      <QueryView query={metrics} label="support metrics">
        {(m) => (
          <>
            <Section title="Right now">
              <StatGrid>
                <Stat label="Open (not started)" value={String(m.open)} />
                <Stat label="In progress" value={String(m.inProgress)} />
                <Stat label="Waiting (customer or provider)" value={String(m.pending)} />
                <Stat label="Unassigned" value={String(m.unassigned)} />
                <Stat label="Escalated" value={String(m.escalated)} />
                <Stat
                  label="Overdue"
                  value={String(m.overdue)}
                  hint="Past a response or resolution target"
                />
              </StatGrid>
            </Section>
            <Section
              title={`In the last ${range === '24h' ? '24 hours' : range === '7d' ? '7 days' : '30 days'}`}
            >
              <StatGrid>
                <Stat label="Tickets opened" value={String(m.created)} />
                <Stat label="Tickets resolved" value={String(m.resolved)} />
                <Stat
                  label="First response (median)"
                  value={minutes(m.firstResponse.medianMinutes)}
                  hint={
                    m.firstResponse.withinTarget === null
                      ? 'No responses yet'
                      : `${formatPercent(m.firstResponse.withinTarget)} within target · ${m.firstResponse.count} measured`
                  }
                />
                <Stat
                  label="Resolution (median)"
                  value={minutes(m.resolution.medianMinutes)}
                  hint={
                    m.resolution.withinTarget === null
                      ? 'Nothing resolved yet'
                      : `${formatPercent(m.resolution.withinTarget)} within target · ${m.resolution.count} measured`
                  }
                />
              </StatGrid>
              <Note>
                First response: from opening to the first public reply by a person on the support
                team (Wayora’s automatic acknowledgement doesn’t count), for tickets opened in the
                range. Resolution: from opening to the latest time it was marked resolved, for
                tickets resolved in the range. Targets are calendar hours, 24/7:{' '}
                {SUPPORT_PRIORITIES.map(
                  (p) =>
                    `${SUPPORT_PRIORITY_LABEL[p].toLowerCase()} ${SUPPORT_TARGET_HOURS[p].firstResponse} h / ${SUPPORT_TARGET_HOURS[p].resolution} h`,
                ).join(', ')}{' '}
                (first response / resolution).
              </Note>
            </Section>
            <div className="grid gap-6 lg:grid-cols-2">
              <Section title="Active by topic">
                {m.byCategory.length === 0 ? (
                  <p className="text-body-sm text-ink-secondary">No active tickets.</p>
                ) : (
                  <BarList
                    label="Active tickets by topic"
                    items={Object.fromEntries(m.byCategory.map((c) => [c.category, c.active]))}
                    format={(k) => SUPPORT_CATEGORY_LABEL[k as keyof typeof SUPPORT_CATEGORY_LABEL]}
                  />
                )}
              </Section>
              <Section title="Active by priority">
                {m.byPriority.length === 0 ? (
                  <p className="text-body-sm text-ink-secondary">No active tickets.</p>
                ) : (
                  <BarList
                    label="Active tickets by priority"
                    items={Object.fromEntries(m.byPriority.map((c) => [c.priority, c.active]))}
                    format={(k) => SUPPORT_PRIORITY_LABEL[k as SupportPriority]}
                  />
                )}
              </Section>
            </div>
            <Section title="Workload">
              {m.workload.length === 0 ? (
                <p className="text-body-sm text-ink-secondary">No tickets are assigned.</p>
              ) : (
                <Table label="Workload" head={['Person', 'Role', 'Active', 'Overdue']}>
                  {m.workload.map((w) => (
                    <tr key={w.staff.id}>
                      <td>{w.staff.name}</td>
                      <td>{humanize(w.staff.role)}</td>
                      <td className="numeric">{w.active}</td>
                      <td className="numeric">{w.overdue}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Section>
          </>
        )}
      </QueryView>
    </AdminPage>
  );
}

// ─── Queue ───────────────────────────────────────────────────────────────

/** /admin/support/tickets */
export function SupportQueueRoute() {
  const canSearchCustomers = useCan('admin.users.read');
  const { values, page } = useFilters([
    'view',
    'status',
    'priority',
    'category',
    'overdue',
    'q',
    'sort',
  ]);
  const query = useQuery({
    queryKey: adminKeys.view('support-queue', values, page),
    queryFn: ({ signal }) => adminSupportTickets({ ...values, page } as never, signal),
    placeholderData: (previous) => previous,
  });
  return (
    <AdminPage
      title="Support queue"
      back={{ to: ADMIN_PATHS.support, label: 'Support' }}
      description="Every support request, filtered and paged on the server."
    >
      <FilterBar
        label="Filter tickets"
        specs={[
          {
            name: 'q',
            label: canSearchCustomers
              ? 'Reference, booking, subject or customer email'
              : 'Reference, booking or subject',
            kind: 'text',
          },
          {
            name: 'view',
            label: 'Queue',
            kind: 'select',
            options: [
              { value: 'mine', label: 'Assigned to me' },
              { value: 'unassigned', label: 'Unassigned' },
              { value: 'escalated', label: 'Escalated' },
            ],
          },
          {
            name: 'status',
            label: 'Status',
            kind: 'select',
            options: [
              { value: 'active', label: 'Any active' },
              ...SUPPORT_STATUSES.map((s) => ({ value: s, label: SUPPORT_STATUS_STAFF_LABEL[s] })),
            ],
          },
          {
            name: 'priority',
            label: 'Priority',
            kind: 'select',
            options: SUPPORT_PRIORITIES.map((p) => ({
              value: p,
              label: SUPPORT_PRIORITY_LABEL[p],
            })),
          },
          {
            name: 'category',
            label: 'Topic',
            kind: 'select',
            options: SUPPORT_CATEGORIES.map((c) => ({
              value: c,
              label: SUPPORT_CATEGORY_LABEL[c],
            })),
          },
          {
            name: 'overdue',
            label: 'Overdue',
            kind: 'select',
            options: [{ value: 'true', label: 'Overdue only' }],
          },
          {
            name: 'sort',
            label: 'Order',
            kind: 'select',
            options: [
              { value: 'created', label: 'Newest first' },
              { value: 'due', label: 'Resolution due soonest' },
            ],
          },
        ]}
      />
      <QueryView query={query} label="tickets">
        {(data) =>
          data.items.length === 0 ? (
            <EmptyRows what="tickets" />
          ) : (
            <>
              <Table
                label="Tickets"
                head={['Ticket', 'Status', 'Priority', 'Assignee', 'First response', 'Updated']}
              >
                {data.items.map((t) => (
                  <tr key={t.reference}>
                    <td className="max-w-80">
                      <Link to={ADMIN_PATHS.supportTicket(t.reference)} className={link}>
                        {t.subject}
                      </Link>
                      <span className="block text-caption text-ink-secondary">
                        <span className={mono}>{t.reference}</span> · {t.customerName} ·{' '}
                        {SUPPORT_CATEGORY_LABEL[t.category]}
                      </span>
                      <span className="mt-1 flex flex-wrap gap-1">
                        {t.escalated ? (
                          <Badge size="sm" tone="danger">
                            Escalated
                          </Badge>
                        ) : null}
                        {t.awaitingReply ? (
                          <Badge size="sm" tone="warning">
                            Customer waiting
                          </Badge>
                        ) : null}
                      </span>
                    </td>
                    <td>
                      <TicketStatusBadge status={t.status} staff />
                    </td>
                    <td>
                      <Badge
                        size="sm"
                        tone={
                          t.priority === 'urgent'
                            ? 'danger'
                            : t.priority === 'high'
                              ? 'warning'
                              : 'neutral'
                        }
                      >
                        {SUPPORT_PRIORITY_LABEL[t.priority]}
                      </Badge>
                    </td>
                    <td>
                      {t.assignee?.name ?? <span className="text-ink-secondary">Unassigned</span>}
                    </td>
                    <td>
                      <TargetCell t={t.firstResponse} label="Response" />
                    </td>
                    <td className="whitespace-nowrap">{formatMoment(t.updatedAt)}</td>
                  </tr>
                ))}
              </Table>
              <Pager pagination={data.pagination} label="Tickets" />
            </>
          )
        }
      </QueryView>
    </AdminPage>
  );
}

// ─── Workspace ───────────────────────────────────────────────────────────

function BookingContext({ title, b }: { title: string; b: SupportBookingContext }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-label text-ink">{title}</h3>
      <DetailList
        items={[
          [
            'Booking',
            <Link to={ADMIN_PATHS.booking(b.reference)} className={cn(link, mono)}>
              {b.reference}
            </Link>,
          ],
          ['Service', `${humanize(b.category)}${b.demo ? ' (demo)' : ''}`],
          ['Status', humanize(b.status)],
          ['Payment', humanize(b.paymentState)],
          ['Refund', humanize(b.refundState)],
          ...(b.reservationState
            ? [['Reservation', humanize(b.reservationState)] as [string, string]]
            : []),
        ]}
      />
    </div>
  );
}

function Message({ m }: { m: AdminSupportMessage }) {
  return (
    <li
      className={cn(
        'flex flex-col gap-1 rounded-lg border p-3',
        m.internal
          ? 'border-warning/40 bg-warning-soft'
          : m.author === 'customer'
            ? 'border-line bg-card'
            : m.author === 'system'
              ? 'border-dashed border-line-strong bg-sunken'
              : 'border-brand-200 bg-brand-soft/50',
      )}
    >
      <span className="flex flex-wrap items-center gap-2 text-caption text-ink-secondary">
        <span className="font-semibold text-ink">{m.authorName}</span>
        {m.internal ? (
          <Badge size="sm" tone="warning" icon={<Lock />}>
            Internal note: staff only
          </Badge>
        ) : null}
        {m.author === 'system' ? <span>automatic message</span> : null}
        {m.aiAssisted ? (
          <Badge size="sm" tone="neutral" icon={<Bot />}>
            From an AI draft, reviewed
          </Badge>
        ) : null}
        <time dateTime={m.createdAt}>{formatMoment(m.createdAt)}</time>
        {m.readByCustomer ? <span>· read by the customer</span> : null}
      </span>
      <p className="text-body-sm whitespace-pre-wrap break-words text-ink">{m.body}</p>
    </li>
  );
}

/** /admin/support/tickets/:reference */
export function SupportWorkspaceRoute() {
  const parsed = supportReferenceSchema.safeParse(useParams().reference ?? '');
  const reference = parsed.success ? parsed.data : '';
  const ticket = useQuery({
    queryKey: adminKeys.view('support-ticket', reference),
    queryFn: ({ signal }) => adminSupportTicket(reference, signal),
    enabled: parsed.success,
  });
  return (
    <AdminPage
      title={ticket.data?.subject ?? 'Support ticket'}
      back={{ to: ADMIN_PATHS.supportQueue, label: 'Support queue' }}
    >
      {!parsed.success ? (
        <Alert tone="warning" title="Not a ticket reference">
          References look like WYS-7KQ2-M9XD.
        </Alert>
      ) : (
        <QueryView
          query={ticket}
          label="this ticket"
          notFound="There is no ticket with that reference."
        >
          {(t) => <Workspace ticket={t} />}
        </QueryView>
      )}
    </AdminPage>
  );
}

function Workspace({ ticket }: { ticket: AdminSupportTicket }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const ticketKey = adminKeys.view('support-ticket', ticket.reference);
  const messagesKey = adminKeys.view('support-messages', ticket.reference);
  const live = useTicketLiveUpdates(
    adminSupportEventsUrl(ticket.reference),
    ticket.revision,
    ticket.status !== 'closed',
    [ticketKey, messagesKey],
  );
  const messages = useQuery({
    queryKey: messagesKey,
    queryFn: ({ signal }) => adminSupportMessages(ticket.reference, { limit: 50 }, signal),
  });
  const [older, setOlder] = useState<AdminSupportMessage[]>([]);
  const [olderBefore, setOlderBefore] = useState<number | null | undefined>(undefined);
  const nextBefore = olderBefore === undefined ? (messages.data?.nextBefore ?? null) : olderBefore;
  const items = useMemo(() => {
    const bySeq = new Map<number, AdminSupportMessage>();
    for (const m of [...older, ...(messages.data?.items ?? [])]) bySeq.set(m.seq, m);
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }, [older, messages.data]);
  const loadOlder = async () => {
    if (nextBefore === null) return;
    const page = await adminSupportMessages(ticket.reference, { before: nextBefore, limit: 50 });
    setOlder((o) => [...page.items, ...o]);
    setOlderBefore(page.nextBefore);
  };

  // Staff have seen everything shown here.
  const marked = useRef(0);
  useEffect(() => {
    if (messages.isSuccess && marked.current < ticket.revision) {
      marked.current = ticket.revision;
      void adminSupportMarkRead(ticket.reference, ticket.revision).catch(() => undefined);
    }
  }, [messages.isSuccess, ticket.revision, ticket.reference]);

  const apply = (t: AdminSupportTicket) => {
    queryClient.setQueryData(ticketKey, t);
    void queryClient.invalidateQueries({ queryKey: messagesKey });
    void queryClient.invalidateQueries({ queryKey: adminKeys.view('support-queue') });
    void queryClient.invalidateQueries({ queryKey: adminKeys.view('support-metrics') });
  };
  const onStale = (e: unknown) => {
    if (e instanceof ApiClientError && e.status === 409)
      void queryClient.invalidateQueries({ queryKey: ticketKey });
  };

  // Composer
  const [mode, setMode] = useState<'reply' | 'note'>(ticket.allowed.reply ? 'reply' : 'note');
  const [body, setBody] = useState('');
  const [requestInfo, setRequestInfo] = useState(false);
  const [fromAi, setFromAi] = useState(false);
  const [key, setKey] = useState(newClientKey);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const send = useMutation({
    mutationFn: () =>
      adminSupportReply(ticket.reference, {
        body,
        clientKey: key,
        internal: mode === 'note',
        requestInfo: mode === 'reply' && requestInfo,
        aiAssisted: mode === 'reply' && fromAi,
      }),
    onSuccess: (t) => {
      apply(t);
      setBody('');
      setRequestInfo(false);
      setFromAi(false);
      setKey(newClientKey());
      setAnnouncement(mode === 'note' ? 'Internal note added.' : 'Reply sent to the customer.');
    },
    onError: (e) => setComposeError(errorText(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setComposeError(null);
    if (!body.trim()) return setComposeError('Write something first.');
    if (!send.isPending) send.mutate();
  };

  // AI
  const [suggestion, setSuggestion] = useState<SupportAiSuggestion | null>(null);
  const ai = useMutation({
    mutationFn: (kind: 'draft' | 'summary') => adminSupportAi(ticket.reference, kind),
    onSuccess: setSuggestion,
  });

  // Actions
  const [nextStatus, setNextStatus] = useState<SupportStatus | ''>('');
  const [statusReason, setStatusReason] = useState('');
  const status = useMutation({
    mutationFn: () =>
      adminSupportStatus(ticket.reference, {
        status: nextStatus as SupportStatus,
        ...(statusReason.trim() ? { reason: statusReason.trim() } : {}),
        revision: ticket.revision,
      }),
    onSuccess: (t) => {
      apply(t);
      setNextStatus('');
      setStatusReason('');
      setAnnouncement(`Status changed to ${SUPPORT_STATUS_STAFF_LABEL[t.status].toLowerCase()}.`);
    },
    onError: onStale,
  });
  const staffList = useQuery({
    queryKey: adminKeys.view('support-staff'),
    queryFn: ({ signal }) => adminSupportStaff(signal),
    enabled: ticket.allowed.assignOthers,
  });
  const [assignTo, setAssignTo] = useState('');
  const assign = useMutation({
    mutationFn: (assigneeId: string | null) =>
      adminSupportAssign(ticket.reference, { assigneeId, revision: ticket.revision }),
    onSuccess: (t) => {
      apply(t);
      setAssignTo('');
      setAnnouncement(t.assignee ? `Assigned to ${t.assignee.name}.` : 'Unassigned.');
    },
    onError: onStale,
  });
  const [escalateReason, setEscalateReason] = useState('');
  const escalate = useMutation({
    mutationFn: (to: boolean) =>
      adminSupportEscalate(ticket.reference, {
        escalate: to,
        reason: escalateReason.trim(),
        revision: ticket.revision,
      }),
    onSuccess: (t) => {
      apply(t);
      setEscalateReason('');
      setAnnouncement(t.escalated ? 'Escalated to administrators.' : 'No longer escalated.');
    },
    onError: onStale,
  });
  const [priority, setPriority] = useState<SupportPriority>(ticket.priority);
  const [priorityReason, setPriorityReason] = useState('');
  const changePriority = useMutation({
    mutationFn: () =>
      adminSupportPriority(ticket.reference, {
        priority,
        reason: priorityReason.trim(),
        revision: ticket.revision,
      }),
    onSuccess: (t) => {
      apply(t);
      setPriorityReason('');
      setAnnouncement(`Priority set to ${SUPPORT_PRIORITY_LABEL[t.priority].toLowerCase()}.`);
    },
    onError: onStale,
  });
  const a = ticket.allowed;

  return (
    <div className="flex flex-col gap-6">
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span className={mono}>{ticket.reference}</span>
        <TicketStatusBadge status={ticket.status} staff />
        <PriorityBadge priority={ticket.priority} />
        <Badge size="sm" tone="neutral">
          {SUPPORT_CATEGORY_LABEL[ticket.category]}
        </Badge>
        {ticket.escalated ? (
          <Badge size="sm" tone="danger">
            Escalated
          </Badge>
        ) : null}
        <span className="text-caption text-ink-secondary">
          {live === 'live'
            ? 'Live: changes appear as they happen.'
            : live === 'polling'
              ? 'Checking every 30 seconds.'
              : ''}
        </span>
      </div>
      {ticket.escalated && !a.reply && a.note ? (
        <Alert tone="warning" title="Escalated to administrators">
          An administrator replies to and changes this ticket. You can still add internal notes.
        </Alert>
      ) : null}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <Section
            title="Conversation"
            description="Internal notes are highlighted and never shown to the customer."
          >
            {nextBefore !== null ? (
              <Button variant="ghost" size="sm" className="mb-3" onClick={() => void loadOlder()}>
                Load earlier messages
              </Button>
            ) : null}
            <QueryView query={messages} label="messages">
              {() => (
                <ol aria-label="Messages" className="flex flex-col gap-3">
                  {items.map((m) => (
                    <Message key={m.seq} m={m} />
                  ))}
                </ol>
              )}
            </QueryView>
          </Section>

          {a.reply || a.note ? (
            <Section title={mode === 'note' ? 'Add an internal note' : 'Reply to the customer'}>
              <form noValidate onSubmit={submit} className="flex flex-col gap-3">
                <div role="radiogroup" aria-label="Message type" className="flex gap-1">
                  {(['reply', 'note'] as const)
                    .filter((m) => (m === 'reply' ? a.reply : a.note))
                    .map((m) => (
                      <button
                        key={m}
                        type="button"
                        role="radio"
                        aria-checked={mode === m}
                        onClick={() => setMode(m)}
                        className="min-h-10 rounded-md px-3 text-body-sm text-ink-secondary aria-checked:bg-brand-soft aria-checked:font-semibold aria-checked:text-brand-ink"
                      >
                        {m === 'reply' ? 'Reply' : 'Internal note'}
                      </button>
                    ))}
                </div>
                <Field
                  label={mode === 'note' ? 'Note (staff only)' : 'Reply'}
                  error={composeError ?? undefined}
                  hint={
                    mode === 'note'
                      ? 'Only staff see notes.'
                      : 'The customer sees this, with your first name. Don’t promise refunds, compensation or changes.'
                  }
                >
                  <Textarea
                    rows={6}
                    value={body}
                    maxLength={SUPPORT_MESSAGE_MAX}
                    onChange={(e) => setBody(e.target.value)}
                    className={mode === 'note' ? 'bg-warning-soft' : undefined}
                  />
                </Field>
                {mode === 'reply' ? (
                  <Checkbox
                    label="Ask the customer for more information (status: waiting for customer)"
                    checked={requestInfo}
                    onChange={(e) => setRequestInfo(e.target.checked)}
                  />
                ) : null}
                {fromAi && mode === 'reply' ? (
                  <p className="flex items-center gap-1.5 text-caption text-ink-secondary">
                    <Bot className="size-4" aria-hidden="true" />
                    Started from an AI draft: recorded with the reply (staff only). You’re sending
                    it as yours.
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" loading={send.isPending}>
                    {mode === 'note' ? 'Add note' : 'Send reply'}
                  </Button>
                  {a.ai ? (
                    <>
                      <Button
                        type="button"
                        variant="secondary"
                        loading={ai.isPending && ai.variables === 'draft'}
                        onClick={() => ai.mutate('draft')}
                      >
                        <Sparkles aria-hidden="true" />
                        Suggest a reply
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        loading={ai.isPending && ai.variables === 'summary'}
                        onClick={() => ai.mutate('summary')}
                      >
                        Summarise
                      </Button>
                    </>
                  ) : null}
                </div>
              </form>
              {ai.isError ? (
                <Alert tone="warning" title="No suggestion" className="mt-3">
                  {errorText(ai.error)}
                </Alert>
              ) : null}
              {suggestion ? (
                <section
                  aria-label={suggestion.kind === 'draft' ? 'Suggested reply' : 'Ticket summary'}
                  className="mt-4 flex flex-col gap-3 rounded-lg border border-dashed border-brand-300 bg-brand-soft/40 p-4"
                >
                  <p className="flex flex-wrap items-center gap-2 text-caption text-ink-secondary">
                    <Badge size="sm" tone="brand" icon={<Bot />}>
                      {suggestion.simulated ? 'Template (not AI)' : 'AI-generated'}
                    </Badge>
                    {suggestion.source} ·{' '}
                    {suggestion.kind === 'draft'
                      ? 'review and edit before sending; nothing has been sent'
                      : 'for staff only'}
                  </p>
                  {suggestion.warnings.length ? (
                    <ul aria-label="Check before using" className="flex flex-col gap-1">
                      {suggestion.warnings.map((w) => (
                        <li
                          key={w}
                          className="flex items-start gap-1.5 text-body-sm text-warning-ink"
                        >
                          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                          {w}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="text-body-sm whitespace-pre-wrap text-ink">{suggestion.text}</p>
                  {suggestion.articles.length ? (
                    <p className="text-caption text-ink-secondary">
                      Based on: {suggestion.articles.map((x) => x.title).join('; ')}
                    </p>
                  ) : null}
                  <div className="flex gap-2">
                    {suggestion.kind === 'draft' && a.reply ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setMode('reply');
                          setBody(suggestion.text);
                          setFromAi(true);
                          setSuggestion(null);
                        }}
                      >
                        Edit in the reply box
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" onClick={() => setSuggestion(null)}>
                      Dismiss
                    </Button>
                  </div>
                </section>
              ) : null}
            </Section>
          ) : null}

          <Section title="History">
            <ol aria-label="Ticket history" className="flex flex-col gap-2 text-body-sm">
              {ticket.history.map((h) => (
                <li key={h.seq} className="flex flex-wrap gap-x-2">
                  <time dateTime={h.at} className="text-ink-secondary">
                    {formatMoment(h.at)}
                  </time>
                  <span className="font-medium">{h.actor.name}</span>
                  <span>
                    {humanize(h.type)}
                    {h.from || h.to
                      ? `: ${h.from ? historyValue(h.from) : '—'} → ${h.to ? historyValue(h.to) : '—'}`
                      : ''}
                  </span>
                  {h.reason ? <span className="text-ink-secondary">“{h.reason}”</span> : null}
                  {h.internal ? (
                    <Badge size="sm" tone="neutral">
                      staff only
                    </Badge>
                  ) : null}
                </li>
              ))}
            </ol>
          </Section>
        </div>

        <aside aria-label="Ticket details and actions" className="flex flex-col gap-6">
          <Section title="Details">
            <DetailList
              items={[
                [
                  'Customer',
                  ticket.customer.email
                    ? `${ticket.customer.name} (${ticket.customer.email})`
                    : ticket.customer.name,
                ],
                ['Opened', formatMoment(ticket.createdAt)],
                [
                  'Assignee',
                  ticket.assignee
                    ? `${ticket.assignee.name} (${ticket.assignee.role})`
                    : 'Unassigned',
                ],
                ['First response', <TargetCell t={ticket.firstResponse} label="Response" />],
                ['Resolution', <TargetCell t={ticket.resolution} label="Resolution" />],
                ['Reopened', String(ticket.reopenCount)],
              ]}
            />
          </Section>

          {a.status.length ? (
            <Section title="Status">
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (nextStatus) status.mutate();
                }}
              >
                <Field label="Change to">
                  <Select
                    value={nextStatus}
                    onChange={(e) => setNextStatus(e.target.value as SupportStatus)}
                    options={[
                      { value: '', label: 'Choose a status' },
                      ...a.status.map((s) => ({ value: s, label: SUPPORT_STATUS_STAFF_LABEL[s] })),
                    ]}
                  />
                </Field>
                <Field label="Note for the history (optional)">
                  <Input
                    value={statusReason}
                    maxLength={300}
                    onChange={(e) => setStatusReason(e.target.value)}
                  />
                </Field>
                {status.isError ? (
                  <Alert tone="danger" title="Not changed">
                    {errorText(status.error)}
                  </Alert>
                ) : null}
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  disabled={!nextStatus}
                  loading={status.isPending}
                  className="self-start"
                >
                  Update status
                </Button>
              </form>
            </Section>
          ) : null}

          {a.assignSelf || a.unassign || a.assignOthers ? (
            <Section title="Assignment">
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  {a.assignSelf ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={assign.isPending && assign.variables === user?.id}
                      onClick={() => user && assign.mutate(user.id)}
                    >
                      Assign to me
                    </Button>
                  ) : null}
                  {a.unassign ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={assign.isPending && assign.variables === null}
                      onClick={() => assign.mutate(null)}
                    >
                      Unassign
                    </Button>
                  ) : null}
                </div>
                {a.assignOthers ? (
                  <form
                    className="flex flex-col gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (assignTo) assign.mutate(assignTo);
                    }}
                  >
                    <Field
                      label="Assign to"
                      hint={ticket.escalated ? 'Escalated: administrators only.' : undefined}
                    >
                      <Select
                        value={assignTo}
                        onChange={(e) => setAssignTo(e.target.value)}
                        options={[
                          {
                            value: '',
                            label: staffList.isPending ? 'Loading…' : 'Choose a person',
                          },
                          ...(staffList.data ?? [])
                            .filter((s) => !ticket.escalated || s.role === 'admin')
                            .map((s) => ({ value: s.id, label: `${s.name} (${s.role})` })),
                        ]}
                      />
                    </Field>
                    <Button
                      type="submit"
                      size="sm"
                      variant="secondary"
                      disabled={!assignTo}
                      className="self-start"
                    >
                      Assign
                    </Button>
                  </form>
                ) : null}
                {assign.isError ? (
                  <Alert tone="danger" title="Not assigned">
                    {errorText(assign.error)}
                  </Alert>
                ) : null}
              </div>
            </Section>
          ) : null}

          {a.changePriority ? (
            <Section title="Priority">
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  changePriority.mutate();
                }}
              >
                <Field
                  label="Priority"
                  hint="Response targets are recalculated from when the ticket opened."
                >
                  <Select
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as SupportPriority)}
                    options={SUPPORT_PRIORITIES.map((p) => ({
                      value: p,
                      label: SUPPORT_PRIORITY_LABEL[p],
                    }))}
                  />
                </Field>
                <Field label="Reason" hint="At least 5 characters.">
                  <Input
                    value={priorityReason}
                    maxLength={300}
                    onChange={(e) => setPriorityReason(e.target.value)}
                  />
                </Field>
                {changePriority.isError ? (
                  <Alert tone="danger" title="Not changed">
                    {errorText(changePriority.error)}
                  </Alert>
                ) : null}
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  disabled={priority === ticket.priority}
                  loading={changePriority.isPending}
                  className="self-start"
                >
                  Change priority
                </Button>
              </form>
            </Section>
          ) : null}

          {a.escalate || a.deEscalate ? (
            <Section title={a.escalate ? 'Escalate' : 'Escalation'}>
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  escalate.mutate(a.escalate);
                }}
              >
                <Field
                  label="Reason"
                  hint={
                    a.escalate
                      ? 'Hands the ticket to administrators, who are notified. At least 5 characters.'
                      : 'At least 5 characters.'
                  }
                >
                  <Input
                    value={escalateReason}
                    maxLength={300}
                    onChange={(e) => setEscalateReason(e.target.value)}
                  />
                </Field>
                {escalate.isError ? (
                  <Alert tone="danger" title="Not changed">
                    {errorText(escalate.error)}
                  </Alert>
                ) : null}
                <Button
                  type="submit"
                  size="sm"
                  variant={a.escalate ? 'destructive' : 'secondary'}
                  loading={escalate.isPending}
                  className="self-start"
                >
                  {a.escalate ? 'Escalate to administrators' : 'De-escalate'}
                </Button>
              </form>
            </Section>
          ) : null}

          {ticket.bookingAtOpen || ticket.bookingNow ? (
            <Section title="Booking">
              <div className="flex flex-col gap-4">
                {ticket.bookingNow ? <BookingContext title="Now" b={ticket.bookingNow} /> : null}
                {ticket.bookingAtOpen ? (
                  <BookingContext title="When the ticket opened" b={ticket.bookingAtOpen} />
                ) : null}
              </div>
            </Section>
          ) : null}
          {!a.reply && !a.note ? <Note>This ticket is read-only for you.</Note> : null}
        </aside>
      </div>
    </div>
  );
}
