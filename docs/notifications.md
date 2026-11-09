# Notifications (Phase 14)

Signed-in users get an in-app notification for each booking and payment event
that actually happened, see them from a bell in the header and on
`/notifications`, and choose which ones would be emailed. Email delivery runs
through a database outbox processed by the existing BullMQ worker. **No email
provider is configured**: deliveries are recorded as `NOT_CONFIGURED`, nothing
is sent, and nothing is ever marked sent.

Every notification about a demo booking or demo payment is labelled as a
simulation and never claims a supplier reservation, ticket, real payment or
refund.

## Events

| Type                                                                                                                 | Produced when                                                                                                                                                                    | Notes                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `booking_created`                                                                                                    | A booking that needs a demo payment is created (status `pending`)                                                                                                                | Gives the payment deadline                                                                                                                                                                                                                              |
| `booking_confirmed`                                                                                                  | A booking that needs no payment is created and demo-confirmed in the same transaction                                                                                            | One notification for that one event                                                                                                                                                                                                                     |
| `booking_cancelled`                                                                                                  | You cancel a booking                                                                                                                                                             | Paid demo bookings say a refund would be owed but the demo provider can't refund; no money was charged                                                                                                                                                  |
| `booking_expired`                                                                                                    | An unpaid booking passes its payment deadline                                                                                                                                    |                                                                                                                                                                                                                                                         |
| `booking_failed`                                                                                                     | A supplier booking's reservation definitively failed (Phase 23; never for demo bookings)                                                                                         | Says nothing was reserved and Wayora took no payment. Supplier bookings also use `booking_created` ("Booking requested"), `booking_confirmed` (with the supplier's reference) and `booking_cancelled` (the supplier confirmed it), without demo wording |
| `payment_pending`                                                                                                    | A payment attempt becomes `pending`                                                                                                                                              | In-app only (no email)                                                                                                                                                                                                                                  |
| `payment_succeeded`                                                                                                  | A payment attempt succeeds                                                                                                                                                       | Also covers the booking's demo confirmation (no second "confirmed" notification). If the booking was already cancelled/expired, says it stays so and a refund would be owed                                                                             |
| `payment_failed`                                                                                                     | A payment attempt fails (provider declined, or refused to start it)                                                                                                              |                                                                                                                                                                                                                                                         |
| `payment_refunded`                                                                                                   | The payment provider **confirms** a refund (`refund.succeeded` event)                                                                                                            | Never produced by the demo provider (it can't refund)                                                                                                                                                                                                   |
| `travel_reminder`                                                                                                    | The day before a confirmed booking starts (India calendar), created by the API's background job                                                                                  | Demo bookings: "no ticket or supplier reservation exists"                                                                                                                                                                                               |
| `trip_disruption`                                                                                                    | A travel disruption is reported, changes, or ends (Phase 17, [trips.md](trips.md#notifications))                                                                                 | Simulated ones say "(simulated)"; always says Wayora changed nothing about the booking. Category `trip`                                                                                                                                                 |
| `plan_invitation` · `plan_invitation_accepted` · `plan_invitation_declined` · `plan_member_changed` · `plan_updated` | Plan collaboration (Phase 19): invitations and answers, role changes, removals, members leaving, a plan's dates or destination changing ([planner.md](planner.md#notifications)) | In-app only (no email delivery rows). Category `plan`. Links to the plan or invitation only while the recipient can still open it                                                                                                                       |

Not notified: a payment cancelled by its owner (they just did it, or it was
cancelled with the booking they cancelled), `refund_pending`, and anything
that didn't change state (refused requests, out-of-order or duplicate provider
events, lost races).
Plan budgets and expenses (Phase 20) create no notifications: budget,
expense and recorded-payment changes appear live on the plan and in its
history only ([planner.md](planner.md#budget-and-expenses)).

### Where they are created

Inside the same database transaction as the change they report, right after
the conditional update that made the change:

| Change                         | Code                                                                        |
| ------------------------------ | --------------------------------------------------------------------------- |
| Booking created / cancelled    | `bookings.service.ts` (`create`, `cancel`)                                  |
| Booking expired                | `bookings/lifecycle.ts` (`expireIfOverdue`)                                 |
| Payment status from a provider | `payments/events.ts` (`PaymentEventProcessor`) → `notifications/events.ts`  |
| Payment refused by provider    | `payments.service.ts` (`failWithoutProvider`)                               |
| Travel reminders               | `notifications/reminders.ts`, every 30 min from `server.ts`                 |
| Plan collaboration (Phase 19)  | `planner/collaboration.service.ts`, `planner/planner.service.ts` (`update`) |

So a notification exists exactly when its change was committed: if either
write fails, both roll back (tested with an injected database failure).

### Idempotency

Each notification has a unique `dedupe_key`, e.g. `booking:<id>:CANCELLED`,
`payment:<id>:SUCCEEDED`, `booking:<id>:REMINDER`, and is inserted with
`ON CONFLICT DO NOTHING` (so a duplicate doesn't abort the surrounding
transaction). Together with the conditional state transitions and the
provider-event de-duplication (payments.md#events), a retried request, a
repeated provider event or a re-run job never creates a second notification.

## API

All routes need a session; writes need a trusted `Origin` (CSRF) and fall
under the general rate limit. Responses are `Cache-Control: no-store`. The
recipient is always the session's user: no route accepts a user id, every
query is `WHERE user_id = <session user>`, and another user's notification
answers `404` exactly like one that doesn't exist.

| Method | Path                                            | Response                                                                                                                                    |
| ------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/notifications?page=&pageSize=&unread=` | `{ items, pagination, unreadCount }`; newest first, ties by id (deterministic); `pageSize` 1–50 (default 20), `unread=true` for unread only |
| GET    | `/api/v1/notifications/unread-count`            | `{ unread }`                                                                                                                                |
| PATCH  | `/api/v1/notifications/:notificationId/read`    | The notification; idempotent (keeps the first read time)                                                                                    |
| POST   | `/api/v1/notifications/read-all`                | `{ updated, unread }`                                                                                                                       |
| GET    | `/api/v1/notifications/preferences`             | Preferences (below)                                                                                                                         |
| PATCH  | `/api/v1/notifications/preferences`             | `{ emailBookings?, emailPayments?, emailReminders? }` (strict, at least one)                                                                |

Notifications can't be deleted (there is no DELETE route); they are a record
of what happened to bookings and payments.

`notificationSchema`: `id`, `type`, `category` (`booking`/`payment`/`reminder`),
`title`, `message`, `demo`, `read`, `readAt`, `createdAt`, and `link`
(`{ kind: 'booking', bookingReference }` or `{ kind: 'payment',
bookingReference, paymentId }`, or null). Links are built from the
notification's own booking (checked to be the same owner); the pages they lead
to check ownership again. Titles and messages are written by Wayora (never
provider text), contain no traveller names or contact details, and are
rendered as text, never HTML.

## Preferences

`notification_preferences`, one row per user; no row means the defaults (all
on). They decide only whether an **email** is queued for a new notification
(bookings, payments, reminders). In-app notifications, including payment
status records, are always created. Changing a preference doesn't affect
emails already queued.

Because no email provider is configured, the API reports
`email: { active: false, status: "Email isn’t set up on this server yet…" }`
and the page says so; choices are still saved and will apply once email is
configured.

## Delivery

### Outbox

When a notification is created and the user's preference allows email, a
`notification_deliveries` row (`channel EMAIL`, `PENDING`) is written in the
same transaction. Nothing is published to Redis by the API, so a Redis or
worker outage loses nothing: rows wait in PostgreSQL. `payment_pending`
notifications are in-app only.

### Worker

`apps/worker/src/notifications/dispatcher.ts`, scheduled on the existing
`wayora-system` BullMQ queue as `notifications.dispatch` (a job scheduler,
every `NOTIFICATION_DISPATCH_INTERVAL_MS`, default 15 s). The worker needs
`DATABASE_URL`; without it, it logs that delivery is off and runs its other
jobs.

1. **Claim**: up to 20 due `PENDING` rows are leased for 2 minutes with
   `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`, incrementing
   `attempts`. Concurrent workers never take the same row.
2. **Not configured**: with no email provider, each row becomes
   `NOT_CONFIGURED` (final). Nothing is sent; `sent_at` stays null.
3. **Send** (when a provider exists): the message is rendered from the
   notification (subject `[Demo] … – Wayora` for demo, escaped HTML and text,
   a link built from `WEB_ORIGIN`, a demo footer), sent with the delivery id as
   the idempotency key.
4. **Finish**: only the worker still holding the lease may update the row
   (conditional on `locked_until`), so a slow worker can't overwrite a newer
   outcome. `SENT` only after the provider accepted it (a CHECK ties `SENT` to
   `sent_at`). Transient errors go back to `PENDING` with exponential backoff
   (30 s, 1 min, 2 min… capped at 1 h); after 5 attempts, or on a permanent
   error, `FAILED`. `last_error` holds a short code, never addresses or
   provider bodies.
5. **Recovery**: if a worker dies, its leases expire and another worker (or the
   restarted one) picks the rows up. Delivery is at-least-once: a crash after
   the provider accepted a message but before it was recorded can resend it;
   providers that honour idempotency keys drop the duplicate.

Retries never create notifications (the worker only reads them).

### Enabling a real email provider

1. Choose a transactional email provider with idempotency-key support and a
   verified sending domain (SPF, DKIM, DMARC).
2. Implement `EmailProvider` (`configured: true`, `send(message, key)` mapping
   its errors to `EmailDeliveryError('transient' | 'permanent', code)`).
3. Add its settings to the worker's env (e.g. `EMAIL_PROVIDER`, an API key from
   a secrets manager, `EMAIL_FROM`), select it in `apps/worker/src/main.ts`,
   and set `WEB_ORIGIN`. Never put keys in `VITE_*` variables.
4. Report `email.active: true` from the API (`NotificationsService` is given
   `{ active: false }` in `app.ts` today).
5. Decide what to do with rows already `NOT_CONFIGURED` (they are final; they
   are not resent automatically).
6. Add unsubscribe links and bounce/complaint handling as the provider requires.

## Database

Migration `database/migrations/20261024000000_notifications` (additive; no
existing rows change):

- `notifications`: `user_id` (cascade with the user), `type`
  (`notification_type`), `title` (≤120), `message` (≤500), `is_demo`,
  `booking_id`/`payment_id` (optional, `RESTRICT`), unique `dedupe_key`,
  `read_at`, `created_at`. Indexes: `(user_id, created_at DESC, id DESC)` for
  listing and a partial index on unread rows per user. Checks: non-empty text,
  `read_at ≥ created_at`, a payment notification also names its booking.
  Trigger: only `read_at` may change.
- `notification_deliveries` (the outbox): `notification_id` (cascade),
  `channel`, `status` (`PENDING`, `SENT`, `FAILED`, `NOT_CONFIGURED`),
  `attempts`, `next_attempt_at`, `locked_until`, `last_error`,
  `provider_message_id`, `sent_at`; unique per notification and channel; a
  partial index on due `PENDING` rows; `SENT` ⇔ `sent_at`.
- `notification_preferences`: `user_id` primary key, three booleans (default
  true).

Verified: replayed all migrations into an empty database (no drift against
`schema.prisma`; the two partial indexes are hand-written), applied to the
local dev and test databases.

### Rollback

```sql
BEGIN;
DROP TRIGGER IF EXISTS "notifications_content_immutable" ON "notifications";
DROP FUNCTION IF EXISTS "notifications_protect_content"();
DROP TABLE IF EXISTS "notification_deliveries";
DROP TABLE IF EXISTS "notification_preferences";
DROP TABLE IF EXISTS "notifications";
DROP TYPE IF EXISTS "notification_delivery_status";
DROP TYPE IF EXISTS "notification_channel";
DROP TYPE IF EXISTS "notification_type";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261024000000_notifications';
COMMIT;
```

Then deploy the Phase 13 code (and stop workers running Phase 14 code).

## Web

- **Header bell** (`features/notifications/NotificationsAction.tsx`), signed-in
  only, on every screen size. Its label states the count ("Notifications, 3
  unread"); the badge shows up to `99+`. The count is shown only when the
  server answered: while loading or after an error there is no badge (label
  "Notifications (unread count unavailable)").
- **Panel**: the existing `Popover` (focus moves in; Escape and outside click
  close it and return focus to the bell; it fits a 375 px screen). Latest 8
  notifications with category icon, unread dot (and "(unread)" for screen
  readers), "Demo" badge, title, message, relative time, "View booking" /
  "View payment" (marks it read and closes the panel), "Mark as read",
  "Mark all as read", loading, error with "Try again", empty state, and a link
  to the page. Actions are announced in a polite live region.
- **`/notifications`** (account area, "Notifications" in the account
  navigation, menu and mobile drawer): all notifications, 20 per page, mark one
  or all as read, and the email preferences (with the "Email isn't active"
  notice).
- **Refresh strategy** (no WebSockets or SSE exist, and a badge doesn't justify
  them): the count loads on sign-in, refreshes every 60 s only while the tab is
  visible, on window focus, when the panel opens, after marking read, and
  after the app books, pays or cancels.

## Tests

- `apps/api/test/integration/notifications.test.ts` (PostgreSQL and Redis):
  booking/payment events create one notification each with demo wording and
  links; no-payment bookings; pending/declined/settled payments; owner-cancelled
  payments notify nothing; cancelled/expired bookings once; refused changes
  notify nobody; late success wording; duplicate and out-of-order provider
  events; provider-confirmed refunds; travel reminders once; transaction
  rollback; pagination and deterministic order; unread counts per user; mark
  one/all with ownership; signed-out, CSRF, malformed and unknown requests;
  persistence across an API restart; content immutability; preferences and the
  email outbox rows they decide.
- `apps/worker/test/dispatcher.test.ts` (PostgreSQL): `NOT_CONFIGURED` never
  sent; sending with idempotency key and escaped demo template; transient
  retries with backoff; permanent failures; attempt limit; concurrent
  dispatchers; recovery after a worker dies; a worker that lost its lease;
  templates.
- `apps/web/test/notifications.test.tsx`: badge and `99+`, failed count,
  mobile placement, plain-text rendering, mark one/all, announcements, link to
  booking/payment, empty, loading and error states, keyboard focus, the page,
  pagination and preferences.

## Limitations

- No email is sent (no provider). No SMS or push.
- In-app updates arrive by polling (up to a minute), not in real time.
- Travel reminders are created every 30 minutes by each API instance (deduplicated),
  only for bookings with a start date (not metro), on the India calendar.
- Notifications can't be deleted or archived; there is no retention policy yet.
- `NOT_CONFIGURED` deliveries are final and won't be sent later.
- Delivery is at-least-once once a provider exists (see Recovery).

## Rewards (Phase 25)

Loyalty events use one type, `REWARDS` (`rewards`), and are **in-app only**:
no email is queued for them. Events and dedupe keys are listed in
[rewards.md](rewards.md#notifications).

## Support (Phase 27)

Two types, both **in-app only** (no email is queued): `SUPPORT_TICKET`
(`support_ticket`, to the customer who opened the ticket) and
`SUPPORT_QUEUE` (`support_queue`, to support staff). They link to the
ticket through `notifications.support_ticket_id`: the customer's own ticket
page, or the staff workspace while the recipient still has
`admin.support.read`. Dedupe keys are `support:<ticketId>:<seq>:<recipientId>`.
Events and recipients are listed in [support.md](support.md#notifications).

## Reviews (Phase 28)

One type, **in-app only**: `REVIEW` (`review`, category `reviews`), to a
review's author when it is published, not published, or removed. Its link
is the author's own reviews page (`my-reviews`); no extra column is needed.
Dedupe key: `review:<reviewId>:<revision>`. Details:
[reviews.md](reviews.md#notifications).

## Browser push (Phase 30)

A second delivery channel, `PUSH`, next to email in the same outbox
(`notification_deliveries`, one row per notification and channel). A push
row is queued in the notification's transaction only when the topic's push
preference is on (`pushBookings`, `pushPayments`, `pushReminders`,
`pushSupport`, `pushRewards`; all default on) and the user has a device with
push turned on in a session that's still signed in. The worker's
`PushDispatcher` sends it with Web Push (VAPID); the email dispatcher only
claims `EMAIL` rows. Without VAPID keys, push rows become `NOT_CONFIGURED`
and nothing is sent. Preferences gained the `push*` fields and a `push`
status object (`active`, `status`, `publicKey`). Details, setup and limits:
[pwa.md](pwa.md#push).
