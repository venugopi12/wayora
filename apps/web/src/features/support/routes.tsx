import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCheck,
  ChevronLeft,
  LifeBuoy,
  MessageSquarePlus,
  Plus,
  RotateCw,
  Send,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  SUPPORT_CATEGORIES,
  SUPPORT_CATEGORY_LABEL,
  SUPPORT_MESSAGE_MAX,
  helpArticle,
  suggestHelp,
  supportCategorySchema,
  supportReferenceSchema,
  type BookingSummary,
  type SupportCategory,
  type SupportMessage,
  type SupportTicket,
  type SupportTicketSummary,
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
  Input,
  Radio,
  RadioGroup,
  Select,
  Skeleton,
  Textarea,
  cn,
} from '@wayora/ui';
import { transitions } from '@wayora/ui/motion';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { ApiClientError } from '../../lib/api-client';
import { listBookings } from '../../services/bookings';
import {
  closeSupportTicket,
  createSupportTicket,
  getSupportMessages,
  getSupportTicket,
  getSupportTickets,
  markSupportRead,
  sendSupportMessage,
  supportEventsUrl,
} from '../../services/support';
import { AccountShell, Panel } from '../account/AccountShell';
import { tripPath } from '../bookings/paths';
import { HelpSuggestions } from '../help/routes';
import { notificationKeys } from '../notifications/keys';
import { PriorityBadge, TicketStatusBadge, formatMoment, newClientKey } from './format';
import { supportKeys } from './keys';
import { useTicketLiveUpdates } from './live';
import { HELP_PATH, NEW_TICKET_PATH, SUPPORT_PATH, newTicketPath, ticketPath } from './paths';

/*
 * Customer support (Phase 27, docs/support.md#web): your tickets, a new
 * request, and a ticket's conversation. The server owns everything: owner,
 * status, booking context, who replied. Internal notes never reach these pages
 * (the customer API doesn't have them).
 */

const linkClass = 'font-semibold text-brand-ink underline-offset-4 hover:underline';
const messageOf = (e: unknown) =>
  e instanceof ApiClientError
    ? e.message
    : 'Something went wrong. Check your connection and try again.';
const fieldErrors = (e: unknown): Record<string, string> =>
  e instanceof ApiClientError
    ? Object.fromEntries(
        e.details.flatMap((d) => (d.path ? [[d.path.split('.')[0]!, d.message]] : [])),
      )
    : {};

// ─── List ────────────────────────────────────────────────────────────────

const VIEWS = [
  { value: 'active', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
] as const;

function TicketRow({ ticket }: { ticket: SupportTicketSummary }) {
  return (
    <Link
      to={ticketPath(ticket.reference)}
      className="flex flex-col gap-2 rounded-xl border border-line bg-card p-4 shadow-xs hover:border-brand-300 sm:flex-row sm:items-center sm:justify-between"
    >
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <TicketStatusBadge status={ticket.status} />
          {ticket.unread > 0 ? (
            <Badge size="sm" tone="brand" dot>
              {ticket.unread} new {ticket.unread === 1 ? 'reply' : 'replies'}
            </Badge>
          ) : null}
        </span>
        <span className="truncate text-body font-semibold text-ink">{ticket.subject}</span>
        <span className="text-caption text-ink-secondary">
          <span className="font-mono">{ticket.reference}</span> ·{' '}
          {SUPPORT_CATEGORY_LABEL[ticket.category]}
          {ticket.bookingReference ? (
            <>
              {' '}
              · booking <span className="font-mono">{ticket.bookingReference}</span>
            </>
          ) : null}
        </span>
      </span>
      <span className="shrink-0 text-caption text-ink-secondary">
        Updated {formatMoment(ticket.updatedAt)}
      </span>
    </Link>
  );
}

/** /support */

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
export function SupportTicketsRoute() {
  useDocumentTitle('Support');
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.find((v) => v.value === params.get('view'))?.value ?? 'active') as
    'active' | 'closed' | 'all';
  const page = Math.max(1, Math.min(1000, Number(params.get('page')) || 1));
  const tickets = useQuery({
    queryKey: supportKeys.list({ view, page }),
    queryFn: ({ signal }) => getSupportTickets({ view, page, pageSize: 10 }, signal),
    placeholderData: (previous) => previous,
  });
  return (
    <AccountShell
      title="Support"
      description="Your requests to Wayora support, and the conversation on each."
      actions={
        <Link
          to={NEW_TICKET_PATH}
          className="inline-flex min-h-11 items-center gap-2 rounded-md bg-brand px-4 text-label text-white hover:bg-brand-600"
        >
          <Plus className="size-4" aria-hidden="true" />
          New request
        </Link>
      }
    >
      <nav aria-label="Ticket views" className="flex gap-1 border-b border-line">
        {VIEWS.map((v) => (
          <button
            key={v.value}
            type="button"
            aria-current={v.value === view ? 'page' : undefined}
            onClick={() => setParams(v.value === 'active' ? {} : { view: v.value })}
            className="-mb-px min-h-11 border-b-2 border-transparent px-3 text-body-sm text-ink-secondary hover:text-ink aria-[current=page]:border-brand aria-[current=page]:font-semibold aria-[current=page]:text-brand-ink"
          >
            {v.label}
          </button>
        ))}
      </nav>
      {tickets.isPending ? (
        <div role="status" aria-label="Loading your tickets" className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : tickets.isError ? (
        <ErrorState
          title="We couldn’t load your tickets"
          description={messageOf(tickets.error)}
          action={
            <Button variant="secondary" onClick={() => void tickets.refetch()}>
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          }
        />
      ) : tickets.data.items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong bg-card">
          <EmptyState
            size="page"
            icon={<LifeBuoy />}
            title={
              view === 'closed'
                ? 'No closed requests'
                : view === 'all'
                  ? 'No requests yet'
                  : 'No open requests'
            }
            description="The Help Center answers most questions straight away. If it doesn’t, open a request and support will reply here."
            action={
              <span className="flex flex-wrap justify-center gap-4">
                <Link to={HELP_PATH} className={linkClass}>
                  Search the Help Center
                </Link>
                <Link to={NEW_TICKET_PATH} className={linkClass}>
                  New request
                </Link>
              </span>
            }
          />
        </div>
      ) : (
        <>
          <ul aria-label="Your support requests" className="flex flex-col gap-3">
            {tickets.data.items.map((t) => (
              <li key={t.reference}>
                <TicketRow ticket={t} />
              </li>
            ))}
          </ul>
          {tickets.data.pagination.totalPages > 1 ? (
            <nav aria-label="Pages" className="flex items-center justify-between gap-3">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() =>
                  setParams({ ...(view !== 'active' ? { view } : {}), page: String(page - 1) })
                }
              >
                Previous
              </Button>
              <span className="text-body-sm text-ink-secondary">
                Page {page} of {tickets.data.pagination.totalPages}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= tickets.data.pagination.totalPages}
                onClick={() =>
                  setParams({ ...(view !== 'active' ? { view } : {}), page: String(page + 1) })
                }
              >
                Next
              </Button>
            </nav>
          ) : null}
        </>
      )}
    </AccountShell>
  );
}

// ─── New request ─────────────────────────────────────────────────────────

async function myBookings(signal?: AbortSignal): Promise<BookingSummary[]> {
  const views = ['upcoming', 'past', 'cancelled'] as const;
  const pages = await Promise.all(
    views.map((view) => listBookings({ view, page: 1, pageSize: 50 }, signal)),
  );
  return pages.flatMap((p) => p.items);
}

/** /support/new?booking=&category=&article= */
export function NewTicketRoute() {
  useDocumentTitle('New support request');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fromArticle = helpArticle(params.get('article') ?? '');
  const initialCategory =
    supportCategorySchema.safeParse(params.get('category')).data ??
    fromArticle?.supportCategory ??
    null;
  const [category, setCategory] = useState<SupportCategory | ''>(initialCategory ?? '');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<'low' | 'normal' | 'high'>('normal');
  const [booking, setBooking] = useState(params.get('booking')?.toUpperCase() ?? '');
  const [problems, setProblems] = useState<Record<string, string>>({});
  // One key per request: a retried submission (lost response) creates one ticket.
  const [clientKey] = useState(newClientKey);
  const bookings = useQuery({
    queryKey: ['support', 'my-bookings'],
    queryFn: ({ signal }) => myBookings(signal),
  });
  const deferred = useDeferredValue(`${subject} ${description}`);
  const suggestions = useMemo(
    () => (deferred.trim().length >= 4 ? suggestHelp(deferred, '', 3) : []),
    [deferred],
  );
  const id = useId();

  const create = useMutation({
    mutationFn: () =>
      createSupportTicket({
        subject,
        category: category as SupportCategory,
        description,
        priority,
        clientKey,
        ...(booking ? { bookingReference: booking } : {}),
      }),
    onSuccess: (t) => {
      void queryClient.invalidateQueries({ queryKey: supportKeys.lists });
      void queryClient.invalidateQueries({ queryKey: notificationKeys.unread });
      queryClient.setQueryData(supportKeys.ticket(t.reference), t);
      void navigate(ticketPath(t.reference), { state: { created: true } });
    },
    onError: (e) => setProblems(fieldErrors(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p: Record<string, string> = {};
    if (!category) p.category = 'Choose what your request is about.';
    if (subject.trim().length < 5) p.subject = 'Give a short subject (at least 5 characters).';
    if (description.trim().length < 20)
      p.description = 'Describe what happened (at least 20 characters).';
    setProblems(p);
    if (Object.keys(p).length === 0 && !create.isPending) create.mutate();
  };

  const bookingOptions = [
    { value: '', label: 'Not about a booking' },
    ...(bookings.data ?? []).map((b) => ({
      value: b.reference,
      label: `${b.reference} · ${b.offer.title}${b.status === 'cancelled' ? ' (cancelled)' : ''}`,
    })),
    // A booking named in the link but not (yet) loaded: kept, and checked by the server.
    ...(booking && !(bookings.data ?? []).some((b) => b.reference === booking)
      ? [{ value: booking, label: booking }]
      : []),
  ];

  return (
    <AccountShell
      title="New support request"
      description="Tell us what you need. Support replies in the request, and you’ll get a notification."
    >
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <form
          noValidate
          onSubmit={submit}
          className="flex min-w-0 flex-col gap-5"
          aria-describedby={`${id}-note`}
        >
          {create.isError && Object.keys(fieldErrors(create.error)).length === 0 ? (
            <Alert tone="danger" title="Your request wasn’t sent">
              {messageOf(create.error)}
            </Alert>
          ) : null}
          <Field label="Topic" error={problems.category}>
            <Select
              value={category}
              onChange={(e) => setCategory(e.target.value as SupportCategory)}
              options={[
                { value: '', label: 'Choose a topic' },
                ...SUPPORT_CATEGORIES.map((c) => ({ value: c, label: SUPPORT_CATEGORY_LABEL[c] })),
              ]}
            />
          </Field>
          <Field
            label="Booking"
            hint="Linking a booking lets support see its status. Support never changes a booking because of a request."
            error={problems.bookingReference}
          >
            <Select
              value={booking}
              onChange={(e) => setBooking(e.target.value)}
              options={bookingOptions}
            />
          </Field>
          <Field label="Subject" error={problems.subject}>
            <Input value={subject} maxLength={120} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field
            label="What happened?"
            hint={`${description.length.toLocaleString('en-IN')} / ${SUPPORT_MESSAGE_MAX.toLocaleString('en-IN')} characters. Don’t include passwords or card details.`}
            error={problems.description}
          >
            <Textarea
              rows={7}
              value={description}
              maxLength={SUPPORT_MESSAGE_MAX}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <HelpSuggestions articles={suggestions} label="These articles might answer it" />
          <RadioGroup legend="How urgent is it?" inline>
            {(['low', 'normal', 'high'] as const).map((p) => (
              <Radio
                key={p}
                label={p === 'low' ? 'Low' : p === 'normal' ? 'Normal' : 'High'}
                value={p}
                checked={priority === p}
                onChange={() => setPriority(p)}
              />
            ))}
          </RadioGroup>
          <p id={`${id}-note`} className="text-caption text-ink-secondary">
            Wayora aims to reply first within 24 hours (low), 8 hours (normal) or 4 hours (high).
            These are targets, not guarantees.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button type="submit" loading={create.isPending}>
              Send request
            </Button>
            <Link
              to={SUPPORT_PATH}
              className="inline-flex min-h-11 items-center px-2 text-label text-ink-secondary hover:text-ink"
            >
              Cancel
            </Link>
          </div>
        </form>
        <aside aria-label="Before you send" className="flex flex-col gap-4">
          {fromArticle ? (
            <Alert tone="info" role="none" title="From the Help Center">
              You came from “{fromArticle.title}”. Mention what it didn’t answer.
            </Alert>
          ) : null}
          <Alert tone="warning" role="none" title="Demo bookings">
            Every booking today is a demo: nothing was reserved with a supplier and no real money
            was taken. Support can explain what happened, but can’t change, cancel or refund a
            booking on request.
          </Alert>
        </aside>
      </div>
    </AccountShell>
  );
}

// ─── Ticket ──────────────────────────────────────────────────────────────

function Bubble({ m }: { m: SupportMessage }) {
  const mine = m.author === 'customer';
  const system = m.author === 'system';
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transitions.standard}
      className={cn('flex flex-col gap-1', mine ? 'items-end' : 'items-start')}
    >
      <span className="text-caption text-ink-secondary">
        {m.authorName} · <time dateTime={m.createdAt}>{formatMoment(m.createdAt)}</time>
        {system ? ' · automatic message' : ''}
      </span>
      <div
        className={cn(
          'max-w-[min(36rem,100%)] rounded-2xl px-4 py-3 text-body-sm whitespace-pre-wrap break-words',
          mine
            ? 'rounded-br-sm bg-brand text-white'
            : system
              ? 'border border-dashed border-line-strong bg-sunken text-ink-secondary'
              : 'rounded-bl-sm border border-line bg-card text-ink',
        )}
      >
        {m.body}
      </div>
      {mine && m.seenBySupport ? (
        <span className="flex items-center gap-1 text-caption text-ink-secondary">
          <CheckCheck className="size-3.5" aria-hidden="true" />
          Seen by support
        </span>
      ) : null}
    </motion.li>
  );
}

function useConversation(reference: string) {
  const latest = useQuery({
    queryKey: supportKeys.messages(reference),
    queryFn: ({ signal }) => getSupportMessages(reference, { limit: 30 }, signal),
  });
  const [older, setOlder] = useState<{ items: SupportMessage[]; nextBefore: number | null } | null>(
    null,
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const items = useMemo(() => {
    const bySeq = new Map<number, SupportMessage>();
    for (const m of [...(older?.items ?? []), ...(latest.data?.items ?? [])]) bySeq.set(m.seq, m);
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }, [older, latest.data]);
  const nextBefore = older ? older.nextBefore : (latest.data?.nextBefore ?? null);
  const loadOlder = async () => {
    if (nextBefore === null) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await getSupportMessages(reference, { before: nextBefore, limit: 30 });
      setOlder((o) => ({
        items: [...page.items, ...(o?.items ?? [])],
        nextBefore: page.nextBefore,
      }));
    } catch (e) {
      setOlderError(messageOf(e));
    } finally {
      setLoadingOlder(false);
    }
  };
  return { latest, items, nextBefore, loadOlder, loadingOlder, olderError };
}

/** /support/:reference */
export function TicketRoute() {
  const raw = useParams().reference ?? '';
  const parsed = supportReferenceSchema.safeParse(raw);
  const reference = parsed.success ? parsed.data : '';
  const ticket = useQuery({
    queryKey: supportKeys.ticket(reference),
    queryFn: ({ signal }) => getSupportTicket(reference, signal),
    enabled: parsed.success,
  });
  useDocumentTitle(ticket.data ? `${ticket.data.subject} · Support` : 'Support request');
  if (
    !parsed.success ||
    (ticket.isError && ticket.error instanceof ApiClientError && ticket.error.status === 404)
  ) {
    return (
      <AccountShell
        title="Request not found"
        description="There’s no support request with that reference in your account."
      >
        <Link to={SUPPORT_PATH} className={linkClass}>
          Back to your requests
        </Link>
      </AccountShell>
    );
  }
  if (ticket.isPending) {
    return (
      <AccountShell title="Support request" description="Loading…">
        <div role="status" aria-label="Loading the request" className="flex flex-col gap-3">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </AccountShell>
    );
  }
  if (ticket.isError) {
    return (
      <AccountShell title="Support request" description="">
        <ErrorState
          title="We couldn’t load this request"
          description={messageOf(ticket.error)}
          action={
            <Button variant="secondary" onClick={() => void ticket.refetch()}>
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          }
        />
      </AccountShell>
    );
  }
  return <Ticket ticket={ticket.data} />;
}

function Ticket({ ticket }: { ticket: SupportTicket }) {
  const queryClient = useQueryClient();
  const location = useLocation();
  const created = (location.state as { created?: boolean } | null)?.created === true;
  const convo = useConversation(ticket.reference);
  const live = useTicketLiveUpdates(
    supportEventsUrl(ticket.reference),
    ticket.revision,
    ticket.status !== 'closed',
    [supportKeys.ticket(ticket.reference), supportKeys.messages(ticket.reference)],
  );
  const [body, setBody] = useState('');
  const [key, setKey] = useState(newClientKey);
  const [problem, setProblem] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [closing, setClosing] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Replies shown here are read: tell the server (once per new revision).
  const lastMarked = useRef(0);
  useEffect(() => {
    if (ticket.unread > 0 && convo.latest.isSuccess && lastMarked.current < ticket.revision) {
      lastMarked.current = ticket.revision;
      void markSupportRead(ticket.reference, ticket.revision).then(() => {
        void queryClient.invalidateQueries({ queryKey: supportKeys.lists });
        void queryClient.invalidateQueries({ queryKey: notificationKeys.unread });
      });
    }
  }, [ticket.unread, ticket.revision, ticket.reference, convo.latest.isSuccess, queryClient]);

  const refresh = (t: SupportTicket) => {
    queryClient.setQueryData(supportKeys.ticket(t.reference), t);
    void queryClient.invalidateQueries({ queryKey: supportKeys.messages(t.reference) });
    void queryClient.invalidateQueries({ queryKey: supportKeys.lists });
  };
  const send = useMutation({
    mutationFn: () => sendSupportMessage(ticket.reference, { body, clientKey: key }),
    onSuccess: (t) => {
      refresh(t);
      setBody('');
      setKey(newClientKey());
      setAnnouncement('Message sent.');
      endRef.current?.scrollIntoView({ block: 'nearest' });
    },
    onError: (e) => setProblem(messageOf(e)),
  });
  const close = useMutation({
    mutationFn: () => closeSupportTicket(ticket.reference),
    onSuccess: (t) => {
      refresh(t);
      setClosing(false);
      setAnnouncement('Request closed.');
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    if (!body.trim()) return setProblem('Write a message first.');
    if (!send.isPending) send.mutate();
  };

  return (
    <AccountShell
      title={ticket.subject}
      description={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-ink">{ticket.reference}</span>
          <span aria-hidden="true">·</span>
          {SUPPORT_CATEGORY_LABEL[ticket.category]}
          <span aria-hidden="true">·</span>
          opened {formatMoment(ticket.createdAt)}
        </span>
      }
      actions={
        <Link
          to={SUPPORT_PATH}
          className="inline-flex min-h-11 items-center gap-1 text-body-sm text-ink-secondary hover:text-ink"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          All requests
        </Link>
      }
    >
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {created ? (
        <Alert tone="success" title="Request sent">
          Your reference is {ticket.reference}. Support will reply here, and you’ll get a
          notification.
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <TicketStatusBadge status={ticket.status} />
        <PriorityBadge priority={ticket.priority} />
        <span className="text-caption text-ink-secondary">
          {live === 'live'
            ? 'Updates appear here as they happen.'
            : live === 'polling'
              ? 'Checking for updates every 30 seconds.'
              : ''}
        </span>
      </div>
      {ticket.status === 'waiting_for_customer' ? (
        <Alert tone="warning" title="Support needs more information">
          Reply below so support can carry on.
        </Alert>
      ) : ticket.status === 'resolved' ? (
        <Alert tone="success" title="Marked as resolved">
          If you still need help, reply and the request reopens. Otherwise it closes by itself after
          7 days.
        </Alert>
      ) : ticket.status === 'closed' ? (
        <Alert tone="info" role="none" title="This request is closed">
          <span>
            To ask something new,{' '}
            <Link
              to={newTicketPath(
                ticket.bookingReference ? { booking: ticket.bookingReference } : {},
              )}
              className={linkClass}
            >
              open a new request
            </Link>
            .
          </span>
        </Alert>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section
          aria-label="Conversation"
          className="flex min-w-0 flex-col gap-4 rounded-xl border border-line bg-canvas p-4 sm:p-5"
        >
          {convo.nextBefore !== null ? (
            <Button
              variant="ghost"
              size="sm"
              className="self-center"
              loading={convo.loadingOlder}
              onClick={() => void convo.loadOlder()}
            >
              Load earlier messages
            </Button>
          ) : null}
          {convo.olderError ? (
            <p className="text-center text-body-sm text-danger-ink">{convo.olderError}</p>
          ) : null}
          {convo.latest.isPending ? (
            <div role="status" aria-label="Loading messages" className="flex flex-col gap-3">
              <Skeleton className="h-16 w-2/3 rounded-2xl" />
              <Skeleton className="h-16 w-2/3 self-end rounded-2xl" />
            </div>
          ) : convo.latest.isError ? (
            <ErrorState
              title="We couldn’t load the messages"
              description={messageOf(convo.latest.error)}
              action={
                <Button variant="secondary" size="sm" onClick={() => void convo.latest.refetch()}>
                  Try again
                </Button>
              }
            />
          ) : (
            <ol aria-label="Messages" className="flex flex-col gap-4">
              <AnimatePresence initial={false}>
                {convo.items.map((m) => (
                  <Bubble key={m.seq} m={m} />
                ))}
              </AnimatePresence>
            </ol>
          )}
          <div ref={endRef} />
          {ticket.canReply ? (
            <form
              noValidate
              onSubmit={submit}
              className="flex flex-col gap-3 border-t border-line pt-4"
            >
              <Field
                label="Your reply"
                error={problem ?? undefined}
                hint={
                  ticket.status === 'resolved'
                    ? 'Replying reopens the request.'
                    : 'Don’t include passwords or card details.'
                }
              >
                <Textarea
                  rows={4}
                  value={body}
                  maxLength={SUPPORT_MESSAGE_MAX}
                  onChange={(e) => setBody(e.target.value)}
                />
              </Field>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Button type="submit" loading={send.isPending}>
                  <Send aria-hidden="true" />
                  Send
                </Button>
                {ticket.canClose ? (
                  <Dialog open={closing} onOpenChange={(o) => !close.isPending && setClosing(o)}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setClosing(true)}
                    >
                      I no longer need help
                    </Button>
                    <DialogContent
                      title="Close this request?"
                      description="Support stops working on it. To ask something new later, you’ll open a new request."
                      footer={
                        <>
                          <Button
                            variant="secondary"
                            onClick={() => setClosing(false)}
                            disabled={close.isPending}
                          >
                            Keep it open
                          </Button>
                          <Button onClick={() => close.mutate()} loading={close.isPending}>
                            Close request
                          </Button>
                        </>
                      }
                    >
                      {close.isError ? (
                        <Alert tone="danger" title="Not closed">
                          {messageOf(close.error)}
                        </Alert>
                      ) : null}
                    </DialogContent>
                  </Dialog>
                ) : null}
              </div>
            </form>
          ) : null}
        </section>
        <aside aria-label="Request details" className="flex flex-col gap-4">
          {ticket.booking ? (
            <Panel title="Booking">
              <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-body-sm">
                <dt className="text-ink-secondary">Reference</dt>
                <dd>
                  <Link
                    to={tripPath(ticket.booking.reference)}
                    className={cn(linkClass, 'font-mono')}
                  >
                    {ticket.booking.reference}
                  </Link>
                </dd>
                <dt className="text-ink-secondary">Booking</dt>
                <dd>{ticket.booking.title}</dd>
                <dt className="text-ink-secondary">Status</dt>
                <dd className="capitalize">{ticket.booking.status}</dd>
                <dt className="text-ink-secondary">Payment</dt>
                <dd>{sentence(ticket.booking.paymentState.replace(/[-_]/g, ' '))}</dd>
              </dl>
              {ticket.booking.demo ? (
                <p className="mt-3 text-caption text-ink-secondary">
                  Demo booking: nothing reserved or charged.
                </p>
              ) : null}
            </Panel>
          ) : null}
          <Panel title="History">
            <ol className="flex flex-col gap-2 text-body-sm">
              {ticket.history.map((h, i) => (
                <li key={i} className="flex flex-col items-start gap-0.5">
                  <TicketStatusBadge status={h.status} />
                  <span className="text-caption text-ink-secondary">
                    {formatMoment(h.at)} ·{' '}
                    {h.by === 'you' ? 'you' : h.by === 'support' ? 'support' : 'Wayora'}
                  </span>
                </li>
              ))}
            </ol>
          </Panel>
          <Link to={HELP_PATH} className={cn(linkClass, 'flex items-center gap-1.5 text-body-sm')}>
            <MessageSquarePlus className="size-4" aria-hidden="true" />
            Search the Help Center
          </Link>
        </aside>
      </div>
    </AccountShell>
  );
}
