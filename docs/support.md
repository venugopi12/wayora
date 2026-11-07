# Customer support, Help Center and booking assistance (Phase 27)

Customers ask for help in **support tickets**: a subject, a topic, a
conversation with Wayora's support team and, optionally, one of their
bookings. Staff work tickets from a **support workspace** in the existing
admin dashboard. A **Help Center** answers common questions from articles
kept in the repository. Optional **AI suggestions** help staff, and they
are never sent to customers by themselves.

> **What support can't do.** Opening a ticket never changes a booking.
> Support doesn't cancel bookings, issue refunds, move money or apply
> discounts from a ticket; those follow the rules in
> [bookings.md](bookings.md), [payments.md](payments.md),
> [rewards.md](rewards.md) and [promotions.md](promotions.md). Every booking
> today is a demo.

## Contents

- [Architecture](#architecture)
- [Data model](#data-model)
- [Lifecycle](#lifecycle)
- [Permissions](#permissions)
- [Assignment and escalation](#assignment-and-escalation)
- [Conversation](#conversation)
- [Internal notes](#internal-notes)
- [Booking context](#booking-context)
- [Targets](#targets) and [metrics](#metrics)
- [Notifications](#notifications)
- [Live updates](#live-updates)
- [AI assistance](#ai-assistance)
- [Help Center](#help-center)
- [Attachments](#attachments)
- [API](#api)
- [Web](#web)
- [Security](#security)
- [Configuration](#configuration)
- [Database](#database) and [rollback](#rollback)
- [Tests](#tests)
- [Limitations](#limitations)

## Architecture

| Piece                                             | Role                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/contracts/src/support.ts`               | Vocabulary, transitions, targets, input validation, customer and staff response schemas  |
| `packages/contracts/src/help.ts`                  | Help Center categories and articles, and the deterministic search                        |
| `apps/api/src/modules/support/rules.ts`           | Pure rules: who may do what, target deadlines and states, metric maths, AI output checks |
| `apps/api/src/modules/support/support.service.ts` | Tickets, conversation, staff actions, metrics, auto-close sweep                          |
| `apps/api/src/modules/support/ai.ts`              | Builds the AI input from customer-visible data only; the rule-based demo template        |
| `apps/api/src/modules/support/support.routes.ts`  | `/support` (customers) and `/admin/support` (staff), including live-update streams       |
| `apps/web/src/features/help`                      | Help Center pages                                                                        |
| `apps/web/src/features/support`                   | Customer pages, the booking panel, the live-update hook                                  |
| `apps/web/src/features/admin/SupportAdmin.tsx`    | Staff dashboard, queue and ticket workspace                                              |

It reuses what exists instead of adding parallel systems:

- **Roles:** the existing `support` and `admin` roles (no new role and no
  separate admin login).
- **Permissions:** `ROLE_PERMISSIONS`.
- **Audit:** `audit_logs`.
- **Notifications:** `notify()`, with its dedupe keys.
- **Live updates:** the SSE stack used by trips and planner
  (`PgSignalHub`, `serveSignalStream`).
- **AI:** the assistant's provider abstraction.
- **Booking context:** the owner's booking view (`BookingsService.get`).

## Data model

**`support_tickets`**: one row per request.

- `reference`: `WYS-XXXX-XXXX`, public. The id is never shown.
- `user_id`: the owner, taken from the session.
- `booking_id`, plus `booking_context`: a JSON snapshot taken when the
  ticket opens.
- `category`, `priority`, `status`, `subject`.
- `assignee_id`, `escalated` and `escalated_at`.
- `revision`: the latest sequence number.
- `customer_read_seq` and `staff_read_seq`.
- `last_customer_message_at`, `last_agent_reply_at`, `first_response_at`.
- `first_response_due_at` and `resolution_due_at`: the targets.
- `resolved_at`, `closed_at`, `reopen_count`.
- `client_key`: unique per user, for safe retries.

**`support_messages`**: the conversation (append-only).

- `seq`: the ticket revision when the message was written. It orders the
  conversation.
- `author_kind`: `CUSTOMER`, `AGENT` or `SYSTEM`, with `author_id` (none for
  `SYSTEM`).
- `internal`: staff notes.
- `ai_assisted`: the agent started from an AI draft.
- `client_key`: unique per ticket and author.

**`support_ticket_events`**: the history (append-only), one row per change,
with the same `seq`.

- Types: `CREATED`, `STATUS_CHANGED`, `PRIORITY_CHANGED`, `ASSIGNED`,
  `UNASSIGNED`, `ESCALATED`, `DE_ESCALATED`, `CUSTOMER_MESSAGE`,
  `AGENT_REPLY`, `INTERNAL_NOTE`, `SYSTEM_MESSAGE`.
- Columns: actor, `from` and `to` values, reason, and `internal` (staff-only
  entries).
- `CATEGORY_CHANGED` exists in the enum but nothing records it yet: staff
  can't change a ticket's topic in this phase.

Every change runs in one transaction with the ticket row locked
(`SELECT … FOR UPDATE`). It bumps `revision`, writes the message or
history row with that number, writes notifications and an audit row, and
commits them together.

## Lifecycle

| From                   | Allowed next statuses (staff)                                                       |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `open`                 | `in_progress`, `waiting_for_customer`, `waiting_for_provider`, `resolved`, `closed` |
| `in_progress`          | `waiting_for_customer`, `waiting_for_provider`, `resolved`, `closed`                |
| `waiting_for_customer` | `in_progress`, `waiting_for_provider`, `resolved`, `closed`                         |
| `waiting_for_provider` | `in_progress`, `waiting_for_customer`, `resolved`, `closed`                         |
| `resolved`             | `in_progress` (reopen), `closed`                                                    |
| `closed`               | none: final                                                                         |

Automatic transitions:

| What happens                                                       | Result                                                   |
| ------------------------------------------------------------------ | -------------------------------------------------------- |
| The first public reply on an `open` ticket                         | `in_progress`                                            |
| A reply with "ask for more information"                            | `waiting_for_customer`                                   |
| A customer reply on `waiting_for_customer`                         | `in_progress`                                            |
| A customer reply on `resolved`                                     | `in_progress`; `reopen_count + 1`, `resolved_at` cleared |
| The customer closes their ticket ("I no longer need help")         | `closed`, from any open status                           |
| `resolved` for `SUPPORT_AUTO_CLOSE_DAYS` (default 7) with no reply | `closed` by the sweep, actor Wayora                      |

Transitions are checked in the service (`canTransition` plus the actor's
permissions) and again by a database trigger (`support_tickets_guard`),
which also keeps the opening facts immutable and a closed ticket closed.
Staff changes carry the `revision` they were made on. A stale one is
refused (`409`, "This ticket changed since you opened it"), so two agents
can't overwrite each other.

## Permissions

| Permission                | Support | Admin | Allows                                                                                                    |
| ------------------------- | ------- | ----- | --------------------------------------------------------------------------------------------------------- |
| `admin.support.read`      | ✓       | ✓     | Queue, tickets, conversations (with notes), history, metrics, live updates                                |
| `admin.support.manage`    | ✓       | ✓     | Reply, internal notes, status, priority, take or release _their own_ assignment, escalate, AI suggestions |
| `admin.support.supervise` | –       | ✓     | Assign or release anyone, work escalated tickets, de-escalate                                             |

- **Enforcement:** every `/admin/support` route goes through
  `requirePermission`; denials are audited as `admin.access_denied`. The
  service then applies the ticket-level rules (`allowedFor` in `rules.ts`),
  and the workspace only shows what the server's `allowed` field says.
- **Customer search:** searching by customer email also needs
  `admin.users.read`.
- **Customers:** the customer API (`/support`) never takes a user id; the
  owner always comes from the session.
- **Becoming staff:** staff are provisioned only with the existing
  `admin:role` command ([admin.md](admin.md#provisioning)). Nothing grants
  support access silently.

## Assignment and escalation

- **Self-service:** a support agent may take an unassigned, unescalated
  ticket ("Assign to me") and release their own. Only administrators assign
  tickets to other people or release someone else's.
- **Who can be assigned:** only an active `support` or `admin` user. Never a
  customer or a suspended account. Escalated tickets go to administrators
  only.
- **Escalating:** any support agent can escalate, and must give a reason (at
  least 5 characters).
  - Escalation releases a support agent's assignment and notifies every
    active administrator.
  - While escalated, support agents keep read access and can add internal
    notes. Replies, status and priority are for administrators.
  - Only administrators de-escalate.
- **History:** assignments, escalations and priority changes are recorded
  as staff-only history (names, never ids) and audited (`support.assigned`,
  `support.unassigned`, `support.escalated`, `support.de_escalated`,
  `support.priority_changed`).
- **Original context:** the subject, topic, opening message and booking
  snapshot never change (the trigger enforces it).

## Conversation

- **Ordering:** messages are ordered by `seq`.
- **Paging:** pages come newest-first (`?limit=`, default 30, at most 100)
  and are shown oldest-first; `?before=<seq>` loads older ones.
- **Validation:** text is normalized (NFC, `\r\n` → `\n`) and trimmed, 1–5,000
  characters, no control characters other than line breaks and tabs. It is
  stored as plain text and rendered as text, never HTML.
- **Duplicates:** each submission carries a `clientKey` (UUID). A retried or
  double-clicked submission returns the same result and stores one message
  (or one ticket).
- **Read state:** customers see "Seen by support" on their messages. Staff
  see "read by the customer" on replies. Customers get an unread count per
  ticket. The page reports what was read with `POST …/read { seq }`; nothing
  is marked read just by fetching.
- **Acknowledgement:** a new ticket gets an automatic acknowledgement from
  Wayora (`SYSTEM`, shown as "automatic message"). It is never a first
  response.
- **Names:** customers see support replies signed with the agent's first
  name ("Ravi · Wayora support"), never staff emails or ids.

## Internal notes

Internal notes (`internal = true`) exist only in the staff API:

- the customer endpoints filter them out in the query (`internal: false`);
- their history rows are `internal`, so customers' history and live streams
  never mention them;
- AI suggestions never include them;
- database checks allow notes only from staff, and a note can't ask the
  customer anything or be marked AI-assisted.

Integration tests check that a note's text appears in no customer response
(ticket, list, messages, notifications) and in no AI prompt.

## Booking context

- **Linking:** a booking can be linked only if it belongs to the signed-in
  customer. Anyone else's booking is answered exactly like a missing one
  (`404`, "We couldn't find that booking in your trips.").
- **Trusted source:** the context is read from Wayora's own records through
  the owner's booking view. It has the reference, service, title, demo flag,
  booking status, payment state, supplier reservation state, refund state
  and start date. It has no travellers, contact details, amounts or payment
  ids. The client can't send or override any of it.
- **Snapshot and current state:** the snapshot taken at opening is kept
  (`booking_context`). Staff also see the booking as it is now; customers
  see the current state.
- **No side effects:** opening a ticket never changes the booking, and an
  integration test checks that its status and history are unchanged.
- **On the booking page:** `/trips/:reference` has a "Help with this
  booking" panel. It lists that booking's tickets and links to a new request
  with the booking preselected.

## Targets

Response targets are deadlines Wayora aims for, in **calendar hours, 24/7**.
There are no business hours and no pauses (time spent waiting for the
customer still counts). They are set from the priority when the ticket opens,
and recalculated from the opening time if staff change the priority.

| Priority | First response | Resolution |
| -------- | -------------- | ---------- |
| Urgent   | 1 h            | 8 h        |
| High     | 4 h            | 24 h       |
| Normal   | 8 h            | 72 h       |
| Low      | 24 h           | 120 h      |

Customers choose low, normal or high. Only staff set urgent. Customer pages
call these targets, not guarantees.

Each ticket shows a target state:

- **met** or **missed**: it happened, before or after the deadline;
- **pending**: not yet, and the deadline is ahead;
- **overdue**: not yet, and the deadline has passed.

A ticket closed without a first response counts as missed if the deadline
had passed by then.

## Metrics

`GET /admin/support/metrics?range=24h|7d|30d`, computed from stored
timestamps and statuses. No figure is estimated.

| Metric             | Definition                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Open               | Active tickets with status `open`                                                                                     |
| In progress        | Status `in_progress`                                                                                                  |
| Pending            | Status `waiting_for_customer` or `waiting_for_provider`                                                               |
| Unassigned         | Active tickets with no assignee                                                                                       |
| Escalated          | Active escalated tickets                                                                                              |
| Overdue            | Active tickets past the first-response deadline without a response, or past the resolution deadline                   |
| Created            | Tickets opened in the range                                                                                           |
| Resolved           | Tickets whose latest resolution is in the range                                                                       |
| First response     | For tickets opened in the range and answered: median of `first_response_at − created_at`, and the share within target |
| Resolution         | For tickets resolved in the range: median of `resolved_at − created_at`, and the share within target                  |
| By topic, priority | Active tickets per category and per priority                                                                          |
| Workload           | Per active staff member: active assigned tickets and how many are overdue                                             |

- **First responses:** `first_response_at` is set by the first public reply
  from a person on the support team. Internal notes and Wayora's automatic
  messages never set it.
- **No data:** medians and shares are `null` when nothing was measured, and
  the dashboard shows "—" rather than zero.

## Notifications

In-app notifications are created in the same transaction as the change.
Each has a dedupe key `support:<ticketId>:<seq>:<recipientId>`, so a retry or
a replayed request can't notify twice.

| To                         | When                                                                                                               | Type             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------- |
| Customer                   | Ticket received; agent reply; more information requested; status changed; resolved; closed (by staff or the sweep) | `support_ticket` |
| Every active support/admin | A new ticket enters the queue                                                                                      | `support_queue`  |
| Assignee                   | Assigned to them by someone else; the customer replied; the customer closed it                                     | `support_queue`  |
| Every active admin         | A ticket was escalated (except the escalating admin)                                                               | `support_queue`  |
| Assignee                   | De-escalated (when someone else did it)                                                                            | `support_queue`  |

- **Links:** the customer's notification links to `/support/:reference`;
  staff notifications link to the workspace. A staff link is shown only
  while the recipient still has `admin.support.read`.
- **Content:** notifications carry the reference and, for staff, the
  subject. They never include message text.
- **Email:** support notifications are **in-app only**. No email is queued
  for them, so none is claimed. Wayora has no email provider yet
  ([notifications.md](notifications.md#delivery)).
- **Preferences:** in-app notifications are always kept, as for other types.

## Live updates

A trigger on `support_ticket_events` announces each new history row on
commit (`pg_notify`). It sends ids and sequence numbers only, on two
channels:

- `wayora_support_staff`: every change;
- `wayora_support_customer`: customer-visible changes only, so an internal
  note doesn't even reveal that something happened.

The API listens with `PgSignalHub` (one connection per channel and instance)
and serves Server-Sent Events:

- `GET /support/tickets/:reference/events` (owner only);
- `GET /admin/support/tickets/:reference/events` (`admin.support.read`).

The staff stream re-checks the viewer's role before each announcement.

Browsers re-read through the normal endpoints when an announcement is
newer than what they show. If the stream isn't available, pages re-read
every 30 seconds while visible, and say which mode they're in. There is no
simulated real-time.

## AI assistance

Staff with `admin.support.manage` can ask for a **suggested reply** or a
**summary** (`POST /admin/support/tickets/:reference/ai`).

- **Provider:** it reuses the assistant's provider (`AI_PROVIDER`), through a
  new optional `complete()` method on `AssistantProvider`. The Anthropic
  adapter implements it with the same transport; credentials stay in the
  adapter, server-side.
- **What it sees:** customer-visible messages (the last 20, each shortened),
  the subject, topic and status, safe booking fields, and the matching help
  articles. It never sees internal notes, staff names, emails, ids or
  payment data.
- **Untrusted input:** customer text is passed inside `<conversation>`, with
  instructions to treat it as quoted data and not follow anything in it. The
  rules forbid promising refunds, compensation, cancellations or changes,
  and asking for secrets.
- **Warnings:** the output is checked for refunds, compensation,
  cancellations, promises and secrets, and returned with warnings for the
  agent.
- **Nothing is sent:** a draft is never stored or sent. "Edit in the reply
  box" copies it into the composer, the agent edits and sends it as their
  own reply, and the message is marked `ai_assisted` (shown to staff only).
- **Audit:** each request is audited as `support.ai_suggestion`, with the
  kind, provider and number of warnings, never the text. Requests are rate
  limited per staff member (`AI_RATE_LIMIT_MAX`).
- **Labelling:** the demo provider is rule-based with no language model, so
  its suggestions are templates labelled "Template (not AI)". With
  `AI_PROVIDER=none`, AI suggestions are off and everything else works.
- **What it can't do:** it can't change bookings or payments, issue
  refunds, or send messages.

The customer's new-request form suggests help articles as they type. That
uses the Help Center's keyword search in the browser, not AI.

## Help Center

- **Pages:**
  - `/help`: search, topics and popular questions;
  - `/help?q=`: search results;
  - `/help/topics/:category`;
  - `/help/articles/:slug`: the article, related articles, a link back to
    its topic, a "Contact support" action with the topic preselected, and the
    date it was last checked against the product.
- **Content management:** articles live in
  `packages/contracts/src/help.ts`, not the database, so changes go through
  code review. To add or change one:
  1. Edit `HELP_ARTICLES`. Each article has a category, summary, body blocks,
     related slugs, keywords, a support category and a `reviewed` date.
  2. State only what the code does today. Mark anything set by airlines,
     hotels, operators or governments as a `provider` block, which is shown
     as "Set by the provider, not Wayora".
  3. Update `reviewed`.
  4. Run the support-rules tests: they check that slugs are unique, related
     links resolve, every category has an article and actions are app paths.
- **Old FAQ:** the previous `/help` FAQ content (demo bookings, sample
  prices, currency selector, accounts, cookies, platform status) moved into
  articles.
- **Search:** `searchHelp` is deterministic, with no AI and no network. It
  weights title, keyword, summary and body matches, counts prefix matches of
  four or more letters, and gives a bonus when every term matches.

## Attachments

**Not supported.** Wayora has no secure file storage: no upload handling,
object store or malware scanning. Support is text-only, and the form says not
to share passwords or card details. Adding attachments needs private
storage with signed, short-lived access, content-type sniffing (not
extensions), size limits and scanning before tickets accept files.

## API

Customers (`/api/v1/support`; signed in; another customer's ticket is `404`):

| Method | Path                                                         | Notes                                                                               |
| ------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| GET    | `/tickets?view=active\|closed\|all&booking=&page=&pageSize=` | Own tickets with unread counts                                                      |
| POST   | `/tickets`                                                   | `createSupportTicketSchema` (strict); `SUPPORT_TICKET_RATE_LIMIT_MAX` per hour; 201 |
| GET    | `/tickets/:reference`                                        | Ticket, booking context, status history                                             |
| GET    | `/tickets/:reference/messages?before=&limit=`                | Public messages only                                                                |
| POST   | `/tickets/:reference/messages`                               | `{ body, clientKey }`; `SUPPORT_MESSAGE_RATE_LIMIT_MAX` per minute; `409` if closed |
| POST   | `/tickets/:reference/read`                                   | `{ seq }`                                                                           |
| POST   | `/tickets/:reference/close`                                  | `{ reason? }`                                                                       |
| GET    | `/tickets/:reference/events`                                 | SSE                                                                                 |

Staff (`/api/v1/admin/support`): see [Permissions](#permissions) and the
route list in `support.routes.ts`. That covers `metrics`, `staff`,
`tickets` (filters `view`, `status` including `active`, `priority`,
`category`, `overdue`, `q`, `sort`, `page`, `pageSize`), a ticket, its
`messages`, and the POST actions `messages`, `status`, `assign`, `escalate`,
`priority`, `read` and `ai`, plus `events`.

Errors use the standard envelope: `400 VALIDATION_FAILED`, `403 FORBIDDEN`,
`404 NOT_FOUND`, `409 CONFLICT` (closed ticket, stale revision, transition
not allowed), `429 RATE_LIMITED`, `503 ASSISTANT_UNAVAILABLE` and
`504 ASSISTANT_TIMEOUT`.

## Web

- **Customers:**
  - **Support** in the account menu and side navigation;
  - `/support`: requests, with Open, Closed and All views, unread counts
    and paging;
  - `/support/new`: topic, booking (your bookings only), subject,
    description with a character count, priority, help suggestions as you
    type, and field errors from the server;
  - `/support/:reference`: the conversation, with "Load earlier messages",
    reply, the "I no longer need help" dialog, booking context, status
    history and the live-update mode;
  - the trip detail panel.
- **Staff:**
  - **Support** in the admin navigation (`admin.support.read`);
  - `/admin/support`: metrics with their definitions, workload, and quick
    links to queues;
  - `/admin/support/tickets`: the filtered, paged queue;
  - `/admin/support/tickets/:reference`: the workspace. It has the
    conversation with highlighted notes, a reply and note composer, AI
    suggestions, status, assignment, priority, escalation, the booking now
    and when the ticket opened, and history.
- **Design:** the pages use the existing design system: badges with text
  labels, skeletons, empty and error states, live regions for results.
  New conversation messages fade in with `motion` (switched off under
  reduced motion by the app's `MotionConfig`).

## Security

- **Authorization:** checked on the server for every route (the session for
  customers, `requirePermission` plus ticket rules for staff). Customers
  can't name an owner, status or priority above high.
- **Ticket references:** public references are random (CSPRNG, 31-character
  alphabet). Another customer's reference is indistinguishable from an
  unknown one.
- **Input:** validated with strict schemas (unknown fields refused). Text is
  normalized and checked for control characters, and rendered as text.
- **Rate limits:** per user for new tickets, messages (customers and staff)
  and AI requests.
- **Audit:**
  - `support.ticket_created`, `support.customer_replied`,
    `support.ticket_closed_by_customer`;
  - `admin.support_ticket_viewed`;
  - `support.agent_replied`, `support.note_added`, `support.status_changed`;
  - `support.assigned` / `support.unassigned`, `support.escalated` /
    `support.de_escalated`, `support.priority_changed`;
  - `support.ai_suggestion`, `support.auto_closed`.

  Audit metadata never holds message text.

- **Logs:** never include message text or AI output.

## Configuration

| Variable                         | Default | Meaning                                          |
| -------------------------------- | ------- | ------------------------------------------------ |
| `SUPPORT_TICKET_RATE_LIMIT_MAX`  | `5`     | New tickets per customer per hour                |
| `SUPPORT_MESSAGE_RATE_LIMIT_MAX` | `20`    | Support messages per user per minute             |
| `SUPPORT_AUTO_CLOSE_DAYS`        | `7`     | Days a resolved ticket waits before auto-closing |

AI suggestions use the assistant's settings: `AI_PROVIDER`, `AI_API_KEY`,
`AI_MODEL`, `AI_TIMEOUT_MS` and `AI_RATE_LIMIT_MAX`. Output is capped at
1,024 tokens.

## Database

Migration `20261106000000_customer_support` adds:

- **Notification types:** the values `SUPPORT_TICKET` and `SUPPORT_QUEUE`.
- **Enums:** `support_ticket_status`, `support_ticket_priority`,
  `support_ticket_category`, `support_author_kind` and
  `support_event_type`.
- **Tables:** `support_tickets`, `support_messages` and
  `support_ticket_events`, with CHECKs, indexes and foreign keys
  (`RESTRICT`).
- **Notifications link:** a nullable `notifications.support_ticket_id`
  (`SET NULL`).
- **Triggers:** delete-blocking, append-only, the status guard and the
  announcement trigger.

Existing data is not changed.

### Rollback

This deletes all support data, so take a backup first. Enum values added to
`notification_type` can't be dropped in PostgreSQL; they stay unused.

```sql
BEGIN;
DELETE FROM "notifications" WHERE "type" IN ('SUPPORT_TICKET', 'SUPPORT_QUEUE');
ALTER TABLE "notifications" DROP COLUMN IF EXISTS "support_ticket_id";
DROP TRIGGER IF EXISTS "support_ticket_events_announce" ON "support_ticket_events";
DROP TRIGGER IF EXISTS "support_ticket_events_append_only" ON "support_ticket_events";
DROP TRIGGER IF EXISTS "support_messages_append_only" ON "support_messages";
DROP TRIGGER IF EXISTS "support_tickets_guard" ON "support_tickets";
DROP TRIGGER IF EXISTS "support_tickets_no_delete" ON "support_tickets";
DROP TABLE IF EXISTS "support_ticket_events";
DROP TABLE IF EXISTS "support_messages";
DROP TABLE IF EXISTS "support_tickets";
DROP FUNCTION IF EXISTS "support_ticket_events_announce"();
DROP FUNCTION IF EXISTS "support_tickets_guard"();
DROP FUNCTION IF EXISTS "support_append_only"();
DROP FUNCTION IF EXISTS "support_prevent_delete"();
DROP TYPE IF EXISTS "support_event_type";
DROP TYPE IF EXISTS "support_author_kind";
DROP TYPE IF EXISTS "support_ticket_category";
DROP TYPE IF EXISTS "support_ticket_priority";
DROP TYPE IF EXISTS "support_ticket_status";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261106000000_customer_support';
COMMIT;
```

## Tests

- **`apps/api/test/support-rules.test.ts`:**
  - transitions and permissions (support, admin, customer, escalated,
    closed);
  - target deadlines and states, medians and shares;
  - input normalization and refusals;
  - AI output warnings;
  - Help Center content integrity and deterministic search.
- **`apps/api/test/integration/support.test.ts`** (real PostgreSQL):
  - creation with booking context, with nothing changed on the booking;
  - other customers' bookings and client-supplied owners refused;
  - idempotent creation, and ownership (404s, staff-only routes);
  - booking-linked lists;
  - replies, and internal notes absent from every customer response;
  - duplicate messages and paging;
  - transitions, stale revisions, reopening and closing;
  - database guards;
  - customer close and the auto-close sweep;
  - assignment rules and notifications;
  - escalation rules;
  - filters, search and pagination;
  - SLA metrics with the acknowledgement excluded;
  - notification de-duplication;
  - AI isolation from notes and labelling, with demo and no-AI fallbacks.
- **`apps/web/test/support.test.tsx`:**
  - Help Center search, topics, articles, provider notes, not-found;
  - the new-request form (validation, suggestions, what is sent, server
    errors);
  - list, conversation, read marking, reply and close;
  - the booking panel;
  - the staff dashboard, notes, AI drafts needing review,
    assign-to-administrators-only for escalated tickets, and the queue.

## Limitations

- **Attachments:** not supported (text only); see [Attachments](#attachments).
- **Email:** support notifications are in-app only.
- **Targets:** calendar hours, 24/7. There are no business-hours calendars,
  holidays or pausing while waiting for the customer.
- **Help Center content:** kept in the repository, so there is no admin
  editor. Articles have no per-language versions.
- **Search:** the Help Center search is keyword-based (no stemming beyond
  prefixes, no synonyms).
- **Topic:** staff can't change a ticket's topic once it's open.
- **Escalation:** one level (administrators); there are no teams, queues per
  skill or routing rules.
- **AI:** the demo provider gives templates, not AI. Real AI suggestions
  need `AI_PROVIDER=anthropic` and a key; they weren't exercised against the
  real API in tests (a recording fake provider was used).
- **Notifications:** new tickets notify every active support and admin user.
  With a large team, this should become queue- or rota-based.
- **Customer identity:** staff see the customer's name and, with
  `admin.users.read`, email. There is no phone or other channel.
