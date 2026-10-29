import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquarePlus, RotateCw, SearchX, Send, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  ASSISTANT_LIMITS,
  assistantConversationIdSchema,
  plannedTripIdSchema,
  type AssistantApplyResult,
  type AssistantBlockOf,
  type AssistantConversationDetail,
  type AssistantIntent,
  type AssistantMessage,
  type AssistantStatus,
  type TripAccess,
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
  Skeleton,
  Spinner,
  Textarea,
  cn,
  useToast,
} from '@wayora/ui';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { ApiClientError } from '../../lib/api-client';
import {
  createAssistantConversation,
  deleteAssistantConversation,
  getAssistantConversation,
  getAssistantStatus,
  getAssistantTripContext,
  listAssistantConversations,
  sendAssistantMessage,
} from '../../services/assistant';
import { getPlannedTrip } from '../../services/planner';
import { AccountShell } from '../account/AccountShell';
import { plannerKeys } from '../planner/keys';
import { planPath } from '../planner/paths';
import { ActivityDialog, BudgetProposalDialog, ItineraryDialog, MoveDialog } from './apply';
import { Blocks, type BlockActions } from './blocks';
import { assistantKeys } from './keys';
import { ASSISTANT_PATH, assistantPath } from './paths';

/*
 * /assistant and /assistant/:conversationId (docs/assistant.md#web).
 *
 * - Replies arrive whole: while waiting, the page says so plainly (no fake
 *   typing indicator, no simulated streaming).
 * - Every reply is labelled by where it came from (AI, or the rule-based
 *   demo), and "From your plan" figures are marked as Wayora's own.
 * - Suggestions change nothing until the user reviews and confirms them in a
 *   dialog; the API checks their role on the plan again.
 * - Text from the assistant is rendered as text, never HTML.
 */

const DESCRIPTION =
  'Ask for destination ideas, a day-by-day plan, activities, a budget split or a packing list. Suggestions change nothing until you choose to apply them.';

const PROMPTS: { text: string; intent: AssistantIntent; needsPlan?: boolean }[] = [
  { text: 'Plan a 4-day trip to Goa for two people.', intent: 'itinerary' },
  { text: 'Create a relaxed 5-day itinerary for Japan.', intent: 'itinerary' },
  { text: 'Suggest a weekend trip under ₹15,000.', intent: 'destinations' },
  { text: 'Suggest activities suitable for a family trip.', intent: 'activities' },
  { text: 'What should I pack for this destination?', intent: 'packing' },
  { text: 'Make my itinerary less hectic.', intent: 'review', needsPlan: true },
  { text: 'Help us reduce our group trip expenses.', intent: 'budget', needsPlan: true },
];

function errorText(error: unknown): string {
  const api = error instanceof ApiClientError ? error : null;
  if (!api || api.code === 'NETWORK_ERROR' || api.code === 'TIMEOUT') {
    return 'We couldn’t reach Wayora, or the reply took too long. Check your connection and try again.';
  }
  return api.message;
}

// ─── Route ───────────────────────────────────────────────────────────────

export function AssistantRoute() {
  useDocumentTitle('Travel assistant');
  const { conversationId } = useParams();
  const [params] = useSearchParams();
  const tripParam = conversationId ? null : params.get('trip');
  const status = useQuery({
    queryKey: assistantKeys.status,
    queryFn: ({ signal }) => getAssistantStatus(signal),
  });

  let main;
  if (conversationId !== undefined) {
    main = assistantConversationIdSchema.safeParse(conversationId).success ? (
      <ConversationView key={conversationId} id={conversationId} status={status.data} />
    ) : (
      <NotFound />
    );
  } else {
    main = (
      <NewConversation
        key={tripParam ?? 'none'}
        tripId={tripParam && plannedTripIdSchema.safeParse(tripParam).success ? tripParam : null}
        invalidTrip={Boolean(tripParam) && !plannedTripIdSchema.safeParse(tripParam).success}
        status={status.data}
      />
    );
  }

  return (
    <AccountShell
      title="Travel assistant"
      description={DESCRIPTION}
      actions={
        conversationId ? (
          <Button asChild variant="secondary">
            <Link to={ASSISTANT_PATH}>
              <MessageSquarePlus aria-hidden="true" />
              New conversation
            </Link>
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-6">
        <SourceNotice status={status.data} loading={status.isPending} />
        <div className="grid gap-6 xl:grid-cols-[15rem_minmax(0,1fr)]">
          <ConversationList currentId={conversationId ?? null} />
          <div className="min-w-0">{main}</div>
        </div>
      </div>
    </AccountShell>
  );
}

function SourceNotice({
  status,
  loading,
}: {
  status: AssistantStatus | undefined;
  loading: boolean;
}) {
  if (loading || !status) return null;
  if (!status.available) {
    return (
      <Alert tone="warning" role="none" title="The assistant isn’t available right now">
        Your plans, budgets and the rest of Wayora work as usual. You can still read earlier
        conversations.
      </Alert>
    );
  }
  return status.source?.simulated ? (
    <Alert tone="info" role="none" title="Demo assistant: rule-based, not AI">
      Answers come from fixed rules and Wayora’s twelve sample destinations. They never include
      prices, opening hours, availability or travel times.
    </Alert>
  ) : (
    <Alert tone="info" role="none" title="AI suggestions can be wrong">
      Answers are generated by AI. Prices, opening hours, availability and travel times aren’t
      checked: confirm them before you go.
    </Alert>
  );
}

function NotFound({ message }: { message?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-card">
      <EmptyState
        icon={<SearchX />}
        title="We couldn't open that conversation"
        description={
          message ?? 'It may have been deleted. You can only see your own conversations.'
        }
        action={
          <Button asChild>
            <Link to={ASSISTANT_PATH}>Start a new conversation</Link>
          </Button>
        }
      />
    </div>
  );
}

// ─── Conversation list ──────────────────────────────────────────────────

function ConversationList({ currentId }: { currentId: string | null }) {
  const list = useQuery({
    queryKey: assistantKeys.lists,
    queryFn: ({ signal }) => listAssistantConversations(1, signal),
  });
  const headingId = useId();
  return (
    <nav
      aria-labelledby={headingId}
      className="flex flex-col gap-2 xl:sticky xl:top-24 xl:self-start"
    >
      <h2 id={headingId} className="text-label text-ink">
        Your conversations
      </h2>
      {list.isPending ? (
        <div role="status" aria-label="Loading conversations" className="flex flex-col gap-2">
          <Skeleton className="h-12 rounded-lg" />
          <Skeleton className="h-12 rounded-lg" />
        </div>
      ) : list.isError ? (
        <p className="text-body-sm text-ink-secondary">
          We couldn’t load your conversations.{' '}
          <button type="button" className="underline" onClick={() => void list.refetch()}>
            Try again
          </button>
        </p>
      ) : list.data.items.length === 0 ? (
        <p className="text-body-sm text-ink-secondary">None yet. They’re saved here as you go.</p>
      ) : (
        <ul className="flex gap-2 overflow-x-auto pb-1 xl:flex-col xl:overflow-visible">
          {list.data.items.map((c) => (
            <li key={c.id} className="w-56 shrink-0 xl:w-auto">
              <Link
                to={assistantPath(c.id)}
                aria-current={c.id === currentId ? 'page' : undefined}
                className={cn(
                  'flex min-h-11 flex-col justify-center rounded-lg border border-line bg-card px-3 py-2 text-body-sm hover:border-line-strong',
                  'aria-[current=page]:border-brand aria-[current=page]:bg-brand-soft',
                )}
              >
                <span className="truncate font-semibold text-ink">{c.title}</span>
                <span className="truncate text-caption text-ink-secondary">
                  {c.trip
                    ? `About ${c.trip.title}`
                    : c.tripAvailable
                      ? 'General'
                      : 'Plan no longer available'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

// ─── An existing conversation ───────────────────────────────────────────

function ConversationView({ id, status }: { id: string; status: AssistantStatus | undefined }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const detail = useQuery({
    queryKey: assistantKeys.conversation(id),
    queryFn: ({ signal }) => getAssistantConversation(id, signal),
    retry: false,
  });
  const [deleting, setDeleting] = useState(false);
  const remove = useMutation({
    mutationFn: () => deleteAssistantConversation(id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: assistantKeys.conversation(id) });
      void queryClient.invalidateQueries({ queryKey: assistantKeys.lists });
      toast({ tone: 'success', title: 'Conversation deleted' });
      void navigate(ASSISTANT_PATH, { replace: true });
    },
    onError: (error) =>
      toast({ tone: 'danger', title: 'We couldn’t delete it', description: errorText(error) }),
  });

  const deleteDialog = (
    <Dialog open={deleting} onOpenChange={(open) => !remove.isPending && setDeleting(open)}>
      <DialogContent
        size="sm"
        title="Delete this conversation?"
        description="Its messages and suggestions are deleted for good. Plans and budgets you changed with it stay as they are."
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setDeleting(false)}
              disabled={remove.isPending}
            >
              Keep it
            </Button>
            <Button
              variant="destructive"
              loading={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Delete conversation
            </Button>
          </>
        }
      />
    </Dialog>
  );

  if (detail.isPending) {
    return (
      <div role="status" aria-label="Loading the conversation" className="flex flex-col gap-3">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }
  if (detail.isError) {
    const api = detail.error instanceof ApiClientError ? detail.error : null;
    if (api?.status === 404) {
      const gone = /no longer available/.test(api.message);
      return (
        <div className="flex flex-col gap-4">
          <NotFound message={api.message} />
          {gone ? (
            <div>
              <Button variant="ghost" onClick={() => setDeleting(true)}>
                <Trash2 aria-hidden="true" />
                Delete this conversation
              </Button>
            </div>
          ) : null}
          {deleteDialog}
        </div>
      );
    }
    return (
      <ErrorState
        title="We couldn't load this conversation"
        description="Check your connection, then try again."
        reference={api?.requestId ?? undefined}
        action={
          <Button
            variant="secondary"
            onClick={() => void detail.refetch()}
            loading={detail.isFetching}
          >
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
        }
      />
    );
  }
  return (
    <>
      <Chat
        conversationId={id}
        trip={detail.data.conversation.trip}
        tripAccess={detail.data.tripAccess}
        detail={detail.data}
        status={status}
        onDelete={() => setDeleting(true)}
      />
      {deleteDialog}
    </>
  );
}

// ─── A new conversation (created on the first message) ──────────────────

function NewConversation({
  tripId,
  invalidTrip,
  status,
}: {
  tripId: string | null;
  invalidTrip: boolean;
  status: AssistantStatus | undefined;
}) {
  const trip = useQuery({
    queryKey: plannerKeys.detail(tripId ?? ''),
    queryFn: ({ signal }) => getPlannedTrip(tripId ?? '', signal),
    enabled: Boolean(tripId),
    retry: false,
  });
  if (invalidTrip || (tripId && trip.isError)) {
    return <NotFound message="We couldn’t find that plan, or you don’t have access to it." />;
  }
  if (tripId && trip.isPending) {
    return <Skeleton className="h-40 rounded-xl" />;
  }
  return (
    <Chat
      conversationId={null}
      trip={trip.data ? { id: trip.data.id, title: trip.data.title } : null}
      tripAccess={trip.data?.access ?? null}
      detail={null}
      status={status}
    />
  );
}

// ─── The chat ───────────────────────────────────────────────────────────

type DialogState =
  | { kind: 'itinerary'; messageId: string; block: AssistantBlockOf<'itinerary'> }
  | { kind: 'activity'; messageId: string; block: AssistantBlockOf<'activities'>; index: number }
  | { kind: 'budget'; messageId: string; block: AssistantBlockOf<'budget'> }
  | { kind: 'move'; messageId: string; block: AssistantBlockOf<'moves'>; index: number }
  | null;

interface Pending {
  text: string;
  intent: AssistantIntent | undefined;
  key: string;
}

function Chat({
  conversationId,
  trip,
  tripAccess,
  detail,
  status,
  onDelete,
}: {
  conversationId: string | null;
  trip: { id: string; title: string } | null;
  tripAccess: TripAccess | null;
  detail: AssistantConversationDetail | null;
  status: AssistantStatus | undefined;
  onDelete?: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const location = useLocation();
  const [announcement, setAnnouncement] = useState(
    () => (location.state as { announce?: string } | null)?.announce ?? '',
  );
  const [dialog, setDialog] = useState<DialogState>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastRef = useRef<HTMLLIElement>(null);
  const createKey = useRef(crypto.randomUUID());
  const available = status?.available ?? false;
  const messages = detail?.messages ?? [];

  const send = useMutation({
    mutationFn: async (p: Pending) => {
      const created = conversationId
        ? null
        : await createAssistantConversation(trip?.id ?? null, createKey.current);
      const id = conversationId ?? created!.id;
      const exchange = await sendAssistantMessage(
        id,
        { text: p.text, ...(p.intent ? { intent: p.intent } : {}) },
        p.key,
      );
      return { id, created, exchange };
    },
    onSuccess: ({ id, created, exchange }) => {
      queryClient.setQueryData<AssistantConversationDetail>(
        assistantKeys.conversation(id),
        (old) =>
          old
            ? { ...old, messages: [...old.messages, exchange.userMessage, exchange.reply] }
            : created
              ? {
                  conversation: created,
                  tripAccess,
                  messages: [exchange.userMessage, exchange.reply],
                  hasMore: false,
                }
              : undefined,
      );
      void queryClient.invalidateQueries({ queryKey: assistantKeys.conversation(id) });
      void queryClient.invalidateQueries({ queryKey: assistantKeys.lists });
      void queryClient.invalidateQueries({ queryKey: assistantKeys.status });
      setPending(null);
      setAnnouncement('The assistant replied.');
      // The new conversation's page takes over: tell it what to announce.
      if (!conversationId) {
        void navigate(assistantPath(id), {
          replace: true,
          state: { announce: 'The assistant replied.' },
        });
      }
    },
    onError: () => setAnnouncement('The message wasn’t answered. You can try again.'),
  });

  useEffect(() => {
    if (messages.length > 0) lastRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);
  // Arriving from the first message of a new conversation: keep typing here.
  const arrived = Boolean((location.state as { announce?: string } | null)?.announce);
  useEffect(() => {
    if (arrived) inputRef.current?.focus();
  }, [arrived]);

  const submit = (text: string, intent?: AssistantIntent) => {
    const clean = text.trim();
    if (!clean || send.isPending || !available) return;
    const p = { text: clean, intent, key: crypto.randomUUID() };
    setPending(p);
    setDraft('');
    // The visible waiting status (role=status) announces itself.
    setAnnouncement('');
    send.mutate(p);
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit(draft);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit(draft);
    }
  };

  const onApplied = (result: AssistantApplyResult) => {
    if (conversationId)
      void queryClient.invalidateQueries({ queryKey: assistantKeys.conversation(conversationId) });
    void queryClient.invalidateQueries({ queryKey: plannerKeys.detail(result.tripId) });
    void queryClient.invalidateQueries({ queryKey: plannerKeys.budget(result.tripId) });
    void queryClient.invalidateQueries({ queryKey: plannerKeys.lists });
    toast({
      tone: 'success',
      title: result.message,
      ...(result.warnings.length > 0
        ? {
            description: `The planner flags ${result.warnings.length} schedule warning${result.warnings.length === 1 ? '' : 's'} on that plan.`,
          }
        : {}),
      action: {
        label: 'Open plan',
        altText: 'Open the plan',
        onClick: () => void navigate(planPath(result.tripId)),
      },
    });
  };

  const canEditTrip = Boolean(tripAccess?.canEdit);
  const actionsFor = (m: AssistantMessage): BlockActions => ({
    canEditTrip,
    tripId: trip?.id ?? null,
    applied: m.applied,
    onItinerary: (block) => setDialog({ kind: 'itinerary', messageId: m.id, block }),
    onActivity: (block, index) => setDialog({ kind: 'activity', messageId: m.id, block, index }),
    onBudget: (block) => setDialog({ kind: 'budget', messageId: m.id, block }),
    onMove: (block, index) => setDialog({ kind: 'move', messageId: m.id, block, index }),
  });
  const target = (messageId: string) => ({ conversationId: conversationId ?? '', messageId });

  const prompts = PROMPTS.filter((p) => !p.needsPlan || trip);
  const showPrompts = messages.length === 0 && !pending;
  const counterId = useId();

  return (
    <section aria-label="Conversation" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-wrap items-center gap-2 text-body-sm text-ink-secondary">
          {trip ? (
            <>
              About{' '}
              <Link to={planPath(trip.id)} className="font-semibold text-ink underline">
                {trip.title}
              </Link>
              {tripAccess && !tripAccess.canEdit ? (
                <Badge size="sm" tone="neutral">
                  View only
                </Badge>
              ) : null}
            </>
          ) : (
            'A general conversation (not about one plan)'
          )}
        </p>
        {onDelete ? (
          <Button size="sm" variant="ghost" onClick={onDelete}>
            <Trash2 aria-hidden="true" />
            Delete conversation
          </Button>
        ) : null}
      </div>

      {trip ? <ContextDisclosure tripId={trip.id} /> : null}

      {detail?.hasMore ? (
        <p className="text-caption text-ink-secondary">
          Showing the latest {messages.length} messages.
        </p>
      ) : null}

      <ol aria-label="Messages" className="flex flex-col gap-4">
        {messages.map((m, i) => (
          <li
            key={m.id}
            ref={i === messages.length - 1 ? lastRef : undefined}
            className={cn(
              'flex flex-col gap-1.5',
              m.role === 'user' ? 'items-end' : 'items-stretch',
            )}
          >
            {m.role === 'user' ? (
              <>
                <span className="sr-only">You said:</span>
                <p className="max-w-[85%] rounded-xl bg-brand px-4 py-2.5 text-body whitespace-pre-line break-words text-ink-inverse">
                  {m.text}
                </p>
              </>
            ) : (
              <div className="flex flex-col gap-2 rounded-xl border border-line bg-page p-3 sm:p-4">
                <p className="flex flex-wrap items-center gap-2 text-caption text-ink-secondary">
                  <Sparkles className="size-4" aria-hidden="true" />
                  <span className="font-semibold text-ink">Assistant</span>
                  {m.source ? (
                    <Badge size="sm" tone={m.source.simulated ? 'neutral' : 'brand'}>
                      {m.source.simulated ? 'Demo · rule-based, not AI' : 'AI-generated'}
                    </Badge>
                  ) : null}
                </p>
                <Blocks
                  blocks={m.blocks}
                  suggestionLabel={m.source?.simulated ? 'Demo suggestion' : 'AI suggestion'}
                  actions={actionsFor(m)}
                />
              </div>
            )}
          </li>
        ))}
        {pending ? (
          <li className="flex flex-col items-end gap-1.5">
            <span className="sr-only">You said:</span>
            <p className="max-w-[85%] rounded-xl bg-brand px-4 py-2.5 text-body whitespace-pre-line break-words text-ink-inverse">
              {pending.text}
            </p>
          </li>
        ) : null}
      </ol>

      {send.isPending ? (
        <p role="status" className="flex items-center gap-2 text-body-sm text-ink-secondary">
          <Spinner size="sm" label="" />
          Waiting for the assistant’s reply. This can take up to half a minute.
        </p>
      ) : null}
      {send.isError && pending ? (
        <Alert
          tone="danger"
          title="Your message wasn’t answered"
          action={
            <span className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => send.mutate(pending)}>
                <RotateCw aria-hidden="true" />
                Try again
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(pending.text);
                  setPending(null);
                  send.reset();
                  inputRef.current?.focus();
                }}
              >
                Edit message
              </Button>
            </span>
          }
        >
          {errorText(send.error)} Nothing was saved.
        </Alert>
      ) : null}

      {showPrompts ? (
        <div className="flex flex-col gap-2">
          <h2 className="text-label text-ink">Try asking</h2>
          <ul className="flex flex-wrap gap-2">
            {prompts.map((p) => (
              <li key={p.text}>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!available}
                  onClick={() => submit(p.text, p.intent)}
                >
                  {p.text}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-2 rounded-xl border border-line bg-card p-3 sm:p-4"
      >
        <Field
          label="Message the assistant"
          hint="Enter sends; Shift+Enter starts a new line. Don’t include passwords or card details."
        >
          <Textarea
            ref={inputRef}
            rows={3}
            value={draft}
            maxLength={ASSISTANT_LIMITS.maxMessageChars}
            disabled={!available}
            aria-describedby={counterId}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </Field>
        <div className="flex items-center justify-between gap-3">
          <span id={counterId} className="text-caption text-ink-secondary">
            {draft.length} / {ASSISTANT_LIMITS.maxMessageChars}
          </span>
          <Button
            type="submit"
            loading={send.isPending}
            disabled={!available || send.isPending || !draft.trim()}
          >
            <Send aria-hidden="true" />
            Send
          </Button>
        </div>
      </form>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {dialog?.kind === 'itinerary' ? (
        <ItineraryDialog
          target={target(dialog.messageId)}
          block={dialog.block}
          defaultTripId={canEditTrip ? (trip?.id ?? null) : null}
          onClose={() => setDialog(null)}
          onApplied={onApplied}
        />
      ) : null}
      {dialog?.kind === 'activity' ? (
        <ActivityDialog
          target={target(dialog.messageId)}
          block={dialog.block}
          index={dialog.index}
          defaultTripId={canEditTrip ? (trip?.id ?? null) : null}
          onClose={() => setDialog(null)}
          onApplied={onApplied}
        />
      ) : null}
      {dialog?.kind === 'budget' && trip ? (
        <BudgetProposalDialog
          target={target(dialog.messageId)}
          block={dialog.block}
          tripId={trip.id}
          onClose={() => setDialog(null)}
          onApplied={onApplied}
        />
      ) : null}
      {dialog?.kind === 'move' ? (
        <MoveDialog
          target={target(dialog.messageId)}
          block={dialog.block}
          index={dialog.index}
          onClose={() => setDialog(null)}
          onApplied={onApplied}
        />
      ) : null}
    </section>
  );
}

/** "What the assistant can see": the exact context, loaded when opened. */
function ContextDisclosure({ tripId }: { tripId: string }) {
  const [open, setOpen] = useState(false);
  const context = useQuery({
    queryKey: assistantKeys.tripContext(tripId),
    queryFn: ({ signal }) => getAssistantTripContext(tripId, signal),
    enabled: open,
  });
  return (
    <details
      className="rounded-xl border border-line bg-card p-3 text-body-sm sm:p-4"
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-label text-ink">
        What the assistant can see about this plan
      </summary>
      {context.isPending && open ? (
        <Skeleton className="mt-3 h-16 rounded-lg" />
      ) : context.data ? (
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <p className="font-semibold text-ink">Shared when relevant</p>
            <ul className="flex list-disc flex-col gap-0.5 pl-5 text-ink-secondary">
              <li>
                Destination, dates and length ({context.data.trip.dayCount} days); group size (
                {context.data.trip.groupSize})
              </li>
              <li>Pace, interests and group type, if set</li>
              <li>
                Activity names, categories, times and durations ({context.data.activities.length})
              </li>
              <li>Schedule warnings ({context.data.warnings.length})</li>
              <li>For budget questions: budget and expense totals per currency and category</li>
            </ul>
          </div>
          <div className="flex flex-col gap-1">
            <p className="font-semibold text-ink">Never shared</p>
            <ul className="flex list-disc flex-col gap-0.5 pl-5 text-ink-secondary">
              {context.data.excluded.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : context.isError ? (
        <p className="mt-3 text-ink-secondary">We couldn’t load this just now.</p>
      ) : null}
    </details>
  );
}
