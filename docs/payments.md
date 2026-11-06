# Payments (Phase 13)

Bookings can require a payment before their demo confirmation. Today the only
provider is the **demo payment provider**, a deterministic simulator inside
the API: no money moves, no card or bank details exist anywhere in the flow,
and every demo payment says **"Demo payment — no real money was charged."**
The provider boundary is built so a real gateway can be added later without
touching booking logic.

A payment is not a booking, and a successful payment never means a supplier
reserved anything. Bookings are still demo bookings (docs/bookings.md).

Every payment and booking change described here also creates an in-app
notification in the same transaction (Phase 14, [notifications.md](notifications.md#events)).

## Booking and payment

> **Rewards (Phase 25).** Points and travel credit applied at checkout reduce
> what is due: a payment must be for the booking's total **minus** applied
> rewards, and is recorded for that amount (`booking.payment.amount` shows it,
> `booking.payment.rewards` what was applied). Rewards are settled after a
> payment or booking change commits, never inside it. See
> [rewards.md](rewards.md#booking-and-payment).

> **Promotions (Phase 26).** Coupons and automatic offers come off before
> rewards: a payment must be for the total **minus** reserved promotions
> **minus** applied rewards (`pricing/breakdown.ts` `payableMinor`, read under
> the booking lock). Before an attempt is created, coupons that were switched
> off or have ended are released, and the attempt is refused with
> `409 PAYMENT_AMOUNT_MISMATCH` ("The amount to pay has changed…") so the
> customer confirms the new amount. A promotion use becomes redeemed only once
> the payment succeeded and the booking is confirmed. See
> [promotions.md](promotions.md#before-payment).

### Booking payment mode

Every booking records how it is paid, fixed when it is made (`bookings.payment_mode`):

| Mode   | When                                                                                                                                                                                      | Lifecycle                                 |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `NONE` | Payments off (`PAYMENT_PROVIDER=none`), estimate-priced offers (cab fares are ranges: there is no exact amount to take), and every booking made before Phase 13 (the migration sets this) | Demo-confirmed at once, as in Phase 12    |
| `DEMO` | Payments on and the offer has an exact total                                                                                                                                              | `pending` until its demo payment succeeds |

### Rules

```
Booking (mode DEMO)                         Payment attempts
pending ──────────────────────────────┐     created ─▶ pending ─▶ succeeded / failed / cancelled
  │  payment succeeded ─▶ confirmed   │     created ─▶ succeeded / failed / cancelled
  │  due time passed, nothing         │     succeeded ─▶ refund_pending ─▶ refunded
  │    in progress     ─▶ expired     │     refund_pending ─▶ succeeded (refund refused)
  │  you cancel        ─▶ cancelled   │
confirmed ─▶ cancelled (you, before travel)
```

1. A booking in mode `DEMO` starts `pending` with a due time
   (`payment_due_at`, `PAYMENT_WINDOW_MINUTES`, default 30).
2. New attempts are allowed only while the booking is `pending`, its due
   time hasn't passed, nothing is paid, and no attempt is in progress. Cancelled,
   expired, failed, confirmed and mode-`NONE` bookings refuse new payments
   (`409 PAYMENT_NOT_ALLOWED`). Failed or cancelled attempts can be followed by
   another (`attempt` 2, 3…).
3. When an attempt **succeeds** and the booking is still `pending`, the booking
   moves to `confirmed` in the same transaction, with actor Wayora and the note
   "Demo confirmation (simulated) after a demo payment: no supplier was
   contacted, no ticket was issued, and no real money was charged." This is a
   demo confirmation, never a supplier confirmation: no PNR, ticket or
   supplier reference is created (the database still forbids one on demo
   bookings).
4. <a id="late-success"></a>**Late success**: when an attempt succeeds after its booking
   was cancelled or expired, the booking stays as it is (it is never revived),
   the payment is flagged `refund.required`, and an audit entry
   `payment.succeeded_after_booking_closed` is written. The demo provider can't
   refund (nothing was taken), so the UI says a refund would be owed but isn't
   supported and no real money was charged. Nothing is marked "refunded".
5. **Cancelling a booking** first cancels any attempt still in progress (best
   effort; if it settles anyway, rule 4 applies). Cancelling a **paid** booking
   flags its payment `refund.required` (same wording as rule 4).
6. **Expiry**: a `pending` booking whose due time has passed becomes `expired`
   (actor Wayora). It does not expire while an attempt is in progress; that
   attempt may still succeed and confirm it. Expiry runs before bookings are
   read or paid, and in the background.
7. Payment and booking changes for one booking are serialized with a row lock
   on the booking (`SELECT … FOR UPDATE`), and every related change (payment
   status, history, booking status, audit) commits in one transaction.

The booking API exposes this as `booking.payment`:
`{ mode, state, amount, dueAt, canPay, activePaymentId, demoScenarios }` with
`state` one of `not-required`, `unpaid`, `processing`, `paid`,
`refund-required`, `closed`. Booking `status` gains `expired`; expired
bookings are listed under the `cancelled` view.

## States

`PAYMENT_TRANSITIONS` in `apps/api/src/modules/payments/events.ts`:

| From                              | Allowed to                                    |
| --------------------------------- | --------------------------------------------- |
| `CREATED`                         | `PENDING`, `SUCCEEDED`, `FAILED`, `CANCELLED` |
| `PENDING`                         | `SUCCEEDED`, `FAILED`, `CANCELLED`            |
| `SUCCEEDED`                       | `REFUND_PENDING`                              |
| `REFUND_PENDING`                  | `REFUNDED`, `SUCCEEDED`                       |
| `FAILED`, `CANCELLED`, `REFUNDED` | (final)                                       |

Only the provider (through an event) moves an attempt out of `CREATED` or
`PENDING`, except one case: a provider that definitely refused to start an
attempt (`ProviderPaymentError('rejected')`) lets Wayora mark it `FAILED`.
An unknown outcome (timeout, outage) is never assumed either way: the attempt
stays `CREATED` and is reconciled later. Changes are conditional
(`UPDATE … WHERE status = <current>`), so a status never moves backwards.

## Providers

`apps/api/src/modules/payments/providers/types.ts` defines `PaymentProvider`:

| Member               | Purpose                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| `id`, `name`, `mode` | `mode` is `DEMO` (simulated) or `LIVE`                                 |
| `capabilities`       | `cancel`, `refund` (only if the provider confirms refunds), `webhooks` |
| `createAttempt`      | Starts an attempt; idempotent on Wayora's payment id                   |
| `retrieve`           | Everything the provider has to say so far (reconciliation)             |
| `cancel`             | Cancels a pending attempt, or `not_cancellable`                        |
| `refund?`            | Only for providers that can refund                                     |
| `verifyEvent?`       | Verifies a webhook signature over the raw body; returns its events     |

Providers never change Wayora state themselves: they return
`ProviderPaymentEvent`s (`id`, `type`, `providerReference`, `occurredAt`,
optional `failureCode`) and every event goes through `PaymentEventProcessor`.

### Demo provider

`providers/demo.ts`, id `demo`, name "Wayora demo payments (simulated)".

- No network calls, no stored state: the outcome is a pure function of the
  attempt (scenario, creation time, Wayora's recorded status) and the clock,
  with deterministic event ids (`demo_pay_<id>:payment.succeeded`…), so asking
  again never produces a second event.
- Scenarios: `succeed` (default), `decline`, `pending` (succeeds after
  `PAYMENT_DEMO_PENDING_SECONDS`, default 8), `pending-decline`. A cancelled
  attempt never settles.
- The client may ask for a scenario only when the server enables them
  (`PAYMENT_DEMO_SCENARIOS`, on by default outside production, off in
  production, and only valid with the demo provider). Otherwise any
  `demoScenario` is refused with 400. The client never sends a status.
- It can cancel pending attempts and can't refund.

## API

All routes need a session; writes need a trusted `Origin` (CSRF) and are
limited to `PAYMENT_RATE_LIMIT_MAX` (default 10) per signed-in user per
minute. Responses are `Cache-Control: no-store`. Another user's booking or
payment answers `404` exactly like a missing one.

| Method | Path                                   | Success | Notes                                        |
| ------ | -------------------------------------- | ------- | -------------------------------------------- |
| POST   | `/api/v1/bookings/:reference/payments` | 201     | Start an attempt; `Idempotency-Key` required |
| GET    | `/api/v1/bookings/:reference/payments` | 200     | `{ items }`, newest attempt first            |
| GET    | `/api/v1/payments/:paymentId`          | 200     | Reconciled with the provider if in progress  |
| POST   | `/api/v1/payments/:paymentId/cancel`   | 200     | Only `created`/`pending`                     |

There is deliberately no endpoint to mark a payment successful, and no demo
callback: `POST /api/v1/payment-events/demo` is a 404.

### Create request (`createPaymentRequestSchema`, strict)

```json
{ "amount": { "amountMinor": "2340000", "currency": "INR" }, "demoScenario": "pending" }
```

`amount` is what the visitor saw. The server takes the amount and currency
from the booking's own record (`bookings.total_amount_minor`, `currency`, set
from the server-side offer when booked) and only compares: any difference is
`409 PAYMENT_AMOUNT_MISMATCH`. Unknown fields (a `status`, card details…) are
a 400.

Server order: session → CSRF → rate limit → key format → body → scenario
allowed → idempotency claim → booking (owner) → expiry → row lock →
eligibility → amount → insert `CREATED` + history + audit + key completion
(one transaction) → provider call → events.

### Payment (`paymentSchema`)

`id`, `bookingReference`, `attempt`, `status`, `mode` (`demo`/`live`), `demo`,
`providerName`, `amount`, `demoScenario`, `failure` (`{ code, message }` in
Wayora's words, never the provider's), `cancellable`,
`refund: { required, supported }`, `createdAt`, `updatedAt`, `completedAt`,
`history` (`status`, `at`, `by: you|wayora|provider`, `note`) and `notice`
(the demo notice, or null for real payments). No provider reference, key or
secret is returned.

### Errors

| Code                      | HTTP | When                                                                                             |
| ------------------------- | ---- | ------------------------------------------------------------------------------------------------ |
| `PAYMENT_NOT_ALLOWED`     | 409  | Paid, cancelled, expired, mode `NONE`, an attempt in progress, payments off, refunds unsupported |
| `PAYMENT_AMOUNT_MISMATCH` | 409  | Amount or currency differs from the booking's                                                    |
| `PAYMENT_NOT_CANCELLABLE` | 409  | The attempt has completed                                                                        |
| `IDEMPOTENCY_IN_PROGRESS` | 409  | The same key is still being processed                                                            |
| `IDEMPOTENCY_KEY_REUSED`  | 422  | The same key with a different body                                                               |
| `BAD_REQUEST`             | 400  | Missing/malformed key, demo scenarios not available                                              |
| `SERVICE_UNAVAILABLE`     | 503  | The provider couldn't be reached to cancel                                                       |

## Idempotency

Reuses the Phase 12 mechanism (`idempotency_keys`, bookings.md#idempotency):
scope `POST /bookings/<reference>/payments:<userId>` (user, booking and
operation), SHA-256 of the canonical body, 60 s lock, 24 h retention. The key
is completed in the same transaction that inserts the `CREATED` attempt and
stores only `{ paymentId }`; a replay returns that payment's **current** state
with `Idempotent-Replayed: true`. A failure before that commit frees the key.
The payment row also keeps a SHA-256 of the key (`idempotency_key_hash`).

Independently of keys, two partial unique indexes make duplicates impossible
in the database: at most one attempt `CREATED`/`PENDING` per booking, and at
most one `SUCCEEDED`/`REFUND_PENDING`/`REFUNDED` per booking.

The web app uses one key per distinct request (`crypto.randomUUID()`), a
synchronous in-flight guard plus a disabled button, and retries
`IDEMPOTENCY_IN_PROGRESS` up to three times.

## Events

`PaymentEventProcessor` (`payments/events.ts`) applies every provider event,
from a call (`call`), reconciliation (`poll`) or a verified webhook (`webhook`):

- **Authenticity**: webhooks reach it only after the provider's
  `verifyEvent` accepted the signature; demo events are created inside the
  API process. Inbound webhooks are served only at
  `POST /api/v1/payment-events/:providerId` for providers with
  `capabilities.webhooks` and `verifyEvent` (none today); any other id is a 404. No session or Origin is involved; a bad signature, stale timestamp or
  malformed event is a 400 ("The event could not be verified.") and nothing is
  stored. The raw body is kept only for that path.
- **Structure**: `providerPaymentEventSchema` (strict).
- **De-duplication**: the Phase 1 `webhook_events` table, unique on
  `(provider, external_id)`. Processed and ignored events are never applied
  again (`duplicate`); failed ones are retried when they arrive again (or on
  the next reconciliation); a `PROCESSING` row older than a minute is taken
  over.
- **Ordering**: an event whose transition isn't allowed (e.g. `pending` after
  `succeeded`) is stored `IGNORED` with the reason; the status never regresses.
- **Unknown payment**: stored `FAILED` (to be retried if resent).
- **Stored payload**: provider reference, type, time, failure code and source
  only: no raw body, signature, token or personal data. Logs carry the
  provider and event id, never signatures or bodies.

`apps/api/test/payment-support.ts` has a test-only `SignedTestGateway`
(HMAC-SHA256 over `timestamp.body`, 5-minute tolerance, refunds) used to test
this boundary. It is never registered by the application.

## Refunds

Since Phase 23, refunds have their own lifecycle in the `refunds` table, apart
from the payment and the booking (`apps/api/src/modules/payments/refunds.ts`).
There is still no refund button and no refund endpoint: refunds follow from
what makes them owed.

| Status      | Meaning                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `REQUIRED`  | Owed, but the payment's provider can't refund through Wayora. The demo provider: no money was taken. Nothing is sent or claimed |
| `REQUESTED` | To be sent to the provider (or being sent)                                                                                      |
| `PENDING`   | The provider accepted it and is processing it (`refund.pending`)                                                                |
| `SUCCEEDED` | The provider confirmed it (`refund.succeeded`). The only way a refund completes                                                 |
| `FAILED`    | The provider refused it (a `rejected` call, or `refund.failed`); the payment stays owed back                                    |
| `UNKNOWN`   | Sent, no definitive answer: checked with the provider before anything is sent again                                             |

**When a refund is opened** (in the same transaction):

- a paid booking is cancelled (`BOOKING_CANCELLED`);
- a payment succeeds after its booking closed (`PAID_AFTER_CLOSE`,
  [late success](#rules));
- `PaymentsService.requestRefund` is called (`MANUAL`; not exposed over HTTP).

**Rules**

- **The payment's own amount and currency.** A trigger refuses any other
  figure; nothing about a refund comes from a request.
- **Once per payment.** A partial unique index allows one refund that isn't
  `FAILED` per payment, so opening it twice changes nothing.
- **Idempotent with the provider.**
  - `PaymentProvider.refund(attempt, { refundId, amountMinor, currency })`
    must de-duplicate by `refundId` (Wayora's refund id).
  - Each send is claimed first (a conditional update counting `attempts`).
  - An `UNKNOWN` refund is first checked with the provider (`retrieve`).
  - It is sent again (same id) only if that check settled nothing, at most 5
    attempts; then it needs attention.
  - A `PENDING` refund is re-checked every 5 minutes.
- **Completion only by the provider's word.**
  - Refund events go through the event processor (dedupe, verified webhooks)
    and update both the payment (`REFUND_PENDING`, `REFUNDED`) and the refund
    row.
  - A payment may now go `SUCCEEDED → REFUNDED` directly, for providers that
    report a refund without a pending step.
- **Shown separately.**
  - `booking.refund` gives the state, the payment's amount, whether it was a
    demo payment, and Wayora's explanation.
  - Admin booking detail lists refunds (status, reason, mode, amount,
    attempts, failure code).

**What is real today**: no payment provider that can refund is configured.
The demo provider can't refund (it took nothing), so its refunds are
`REQUIRED` and labelled "no real money was charged". The full lifecycle is
tested with the test-only signed gateway
(`apps/api/test/integration/refunds.test.ts`).

## Background work

`server.ts` runs every 30 seconds on each API instance (idempotent and
row-locked): reconcile attempts still in progress (`retrieve` + events),
expire overdue bookings, then process due refunds (Phase 23: send
`REQUESTED`, check `PENDING`/`UNKNOWN`). Reads do the same for the rows they show, so this
only keeps records current when nobody is looking. The BullMQ worker has no
database access and is not used for this.

## Database

Migration `database/migrations/20261023000000_payments` (additive):

- `booking_status` gains `EXPIRED`; new enums `booking_payment_mode`,
  `payment_status`, `payment_mode`.
- `bookings.payment_mode` (existing rows: `NONE`, then no default) and
  `bookings.payment_due_at`; index `(status, payment_due_at)`; checks: a due
  time only for `DEMO`, `DEMO` only with an exact total. The booked-facts
  trigger now also protects both columns.
- `payments`: `booking_id`, `user_id` (both `RESTRICT`), `attempt` (unique per
  booking), `mode`, `provider`, `provider_reference` (unique per provider, set
  once), `status`, `currency`, `amount_minor` (`BIGINT` > 0), `demo_scenario`
  (demo only), `idempotency_key_hash`, `failure_code`/`failure_message` (failed
  or cancelled only), `refund_required` (succeeded/refund states only),
  `created_at`, `updated_at`, `completed_at` (set exactly when it leaves
  created/pending). Partial unique indexes as above. Triggers: amount,
  booking, provider, reference and key hash are immutable; rows can't be
  deleted.
- `payment_status_events`: append-only history (`from_status`, `to_status`,
  `actor_type`, `provider_event_id`, `note`).
- No card, CVV, bank or token columns exist.

Verified: replayed all migrations into an empty database (no drift against
`schema.prisma` besides the two hand-written partial indexes), applied to a
copy of the development database with Phase 12 bookings (all became `NONE`),
then to the local dev and test databases. Never reset a database to apply it.

### Rollback

Only while no payments need keeping (it deletes them). `EXPIRED` can't be
removed from `booking_status` without recreating the type; expired bookings
are moved to `CANCELLED` so Phase 12 code can read them.

```sql
BEGIN;
DROP TRIGGER IF EXISTS "payment_status_events_append_only" ON "payment_status_events";
DROP TRIGGER IF EXISTS "payments_no_delete" ON "payments";
DROP TRIGGER IF EXISTS "payments_facts_immutable" ON "payments";
DROP FUNCTION IF EXISTS "payment_status_events_prevent_mutation"();
DROP FUNCTION IF EXISTS "payments_prevent_delete"();
DROP FUNCTION IF EXISTS "payments_protect_facts"();
DROP TABLE IF EXISTS "payment_status_events";
DROP TABLE IF EXISTS "payments";
DELETE FROM "webhook_events" WHERE "provider" = 'demo';
ALTER TABLE "bookings" DISABLE TRIGGER "bookings_booked_facts_immutable";
UPDATE "bookings" SET "status" = 'CANCELLED', "cancelled_at" = now() WHERE "status" = 'EXPIRED';
ALTER TABLE "bookings" ENABLE TRIGGER "bookings_booked_facts_immutable";
ALTER TABLE "bookings"
  DROP CONSTRAINT IF EXISTS "bookings_payment_due_at_chk",
  DROP CONSTRAINT IF EXISTS "bookings_demo_payment_total_chk";
DROP INDEX IF EXISTS "bookings_status_payment_due_at_idx";
-- Restore the Phase 12 trigger function first (it names the columns being dropped).
CREATE OR REPLACE FUNCTION "bookings_protect_booked_facts"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."reference" IS DISTINCT FROM OLD."reference"
    OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
    OR NEW."category" IS DISTINCT FROM OLD."category"
    OR NEW."is_demo" IS DISTINCT FROM OLD."is_demo"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."search_id" IS DISTINCT FROM OLD."search_id"
    OR NEW."offer_snapshot" IS DISTINCT FROM OLD."offer_snapshot"
    OR NEW."party_size" IS DISTINCT FROM OLD."party_size"
    OR NEW."starts_on" IS DISTINCT FROM OLD."starts_on"
    OR NEW."ends_on" IS DISTINCT FROM OLD."ends_on"
    OR NEW."contact_phone" IS DISTINCT FROM OLD."contact_phone"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."total_amount_minor" IS DISTINCT FROM OLD."total_amount_minor"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'bookings: booked facts are immutable (only status changes)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
ALTER TABLE "bookings" DROP COLUMN "payment_mode", DROP COLUMN "payment_due_at";
DROP TYPE IF EXISTS "payment_mode";
DROP TYPE IF EXISTS "payment_status";
DROP TYPE IF EXISTS "booking_payment_mode";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261023000000_payments';
COMMIT;
```

Then deploy the Phase 12 code. Pending demo bookings left over can be
cancelled with the Phase 12 API.

## Configuration (`apps/api/.env`)

| Variable                       | Default                                 | Meaning                                                |
| ------------------------------ | --------------------------------------- | ------------------------------------------------------ |
| `PAYMENT_PROVIDER`             | `demo` (dev/test), `none` (production)  | `none` turns payments off (Phase 12 behaviour)         |
| `PAYMENT_DEMO_SCENARIOS`       | `true` (dev/test), `false` (production) | Let requests choose a demo outcome; demo provider only |
| `PAYMENT_WINDOW_MINUTES`       | `30` (5–1440)                           | How long a booking waits for its payment               |
| `PAYMENT_DEMO_PENDING_SECONDS` | `8` (1–300)                             | How long demo `pending` scenarios stay pending         |
| `PAYMENT_RATE_LIMIT_MAX`       | `10`                                    | Payment starts and cancels per user per minute         |

No payment credentials exist; nothing payment-related is exposed through `VITE_*`.

## Web

| Route                                   | What it shows                                                                                                                                                                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/trips/:reference/pay`                 | Review: reference, travel summary, amount (`BookingPriceSummary`), method "Wayora demo payments — Simulated", demo disclosure, due time, demo outcome choice (only when the server offers it), "Pay ₹… (demo)". No card form.     |
| `/trips/:reference/payments/:paymentId` | Status: processing (polled every 2 s, up to 90 s, then "Check again"), success with the demo notice, declined or failed with "Try again", cancelled, refund-required, and a "couldn't check this payment" state with a safe retry |

After "Confirm demo booking", a booking that needs a payment goes to the
review instead of the confirmation. The confirmation page, My trips badges
("Awaiting demo payment", "Expired (not paid)") and the booking page's
**Payment** panel (state, due time, Pay link, attempts) all read the server's
`booking.payment`. Status changes are announced through a polite live region;
motion follows reduced-motion settings; both screens were checked with axe at
1366 px and 375 px.

## Tests

- `packages/contracts/test/payments.test.ts`
- `apps/api/test/integration/payments.test.ts` (PostgreSQL and Redis): payment
  modes, success/decline/pending/pending-decline, cancellation, transitions,
  tampered amount/currency/status, scenarios off, no public success callback,
  cancelled/expired bookings, background expiry, late success, cancelling
  paid/pending bookings, replay, key reuse, concurrent duplicates (same and
  new keys), client timeout and retry, provider outage/refusal, transaction
  failure and event retry, signed webhooks (valid, duplicate, out of order,
  bad signature, stale, malformed, unknown payment), refunds (provider-confirmed
  only; demo unsupported), ownership, rate limit, log redaction, database guards.
- `apps/api/test/integration/bookings.test.ts` runs the Phase 12 rules with
  `PAYMENT_PROVIDER=none`.
- `apps/web/test/payments.test.tsx`: checkout to review, disclosure and no card
  form, duplicate clicks, success/decline/pending/cancel, status retrieval
  failure, amount mismatch, unpayable bookings, not found, booking page panel.

## Before enabling a real gateway

1. A contract with a PCI-compliant gateway; card entry only on its hosted page
   or hosted fields (never through Wayora's servers).
2. Credentials in a secrets manager, read by the API only (never `VITE_*`).
3. A `PaymentProvider` adapter: `createAttempt` idempotent on Wayora's payment
   id, `retrieve`, `cancel`, `refund` only if refunds are confirmed by events,
   and `verifyEvent` implementing the gateway's documented signature scheme
   with timestamp tolerance and constant-time comparison.
4. Webhook URL registered with the gateway; the endpoint exists automatically
   for providers with `capabilities.webhooks`.
5. Real bookings first: a supplier reservation step and its own confirmation
   status, separate from payment (today every booking is a demo).
6. Refund flow and policy, customer communication, reconciliation reports,
   and alerting on `refund_required` payments and failed events.
7. Currency rules (the booking's currency is charged as is today).
8. Load and failure testing against the gateway's sandbox.

## Limitations

- Demo only: no money moves, no refunds, no receipts or invoices.
- Pending demo payments settle on the next read or the 30-second background
  check, not by push.
- Estimate-priced bookings (cabs) can't be paid on Wayora.
- One currency per booking, no partial payments, no split payments.
- `refund_required` is shown but there is no refund workflow.
- The background check runs inside each API process (no separate scheduler).
