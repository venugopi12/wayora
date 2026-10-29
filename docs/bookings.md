# Bookings: demo bookings (Phase 12) and supplier reservations (Phase 23)

Signed-in users can book any priced demo offer in all seven categories
(flights, hotels, trains, buses, metro, cabs, holidays), see it in **My trips**,
and cancel it. These are **demo bookings**: Wayora stores them, but it contacts
no supplier, reserves nothing, issues no ticket and takes no real payment.
There is no card form anywhere, and no card data is accepted or stored.

> **Since Phase 13** a booking with an exact price may first need a **demo
> payment** (simulated, no money moves) before its demo confirmation; it then
> starts `pending` and can `expire` if unpaid. The payment step, the
> `booking.payment` field and the rules are in [payments.md](payments.md).
> With `PAYMENT_PROVIDER=none`, everything below applies unchanged.

What a demo booking deliberately does **not** have: a PNR, e-ticket, hotel
confirmation code, supplier reference, ticket download or supplier document.
The only identifier is Wayora's own reference (`WYD-XXXX-XXXX`), which the UI
labels as internal to Wayora.

> **Since Phase 14** booking changes (created, confirmed, cancelled,
> expired) also create an in-app notification in the same transaction
> ([notifications.md](notifications.md)).

> **Since Phase 23** a booking can also be a **supplier booking**: a
> reservation requested from a configured supplier, confirmed only when the
> supplier confirms it ([Supplier reservations](#supplier-reservations-phase-23)).
> **No real supplier implements reservations yet** ([providers.md](providers.md)),
> and the feature is off unless `SUPPLIER_RESERVATIONS_ENABLED=true`, so every
> booking made today is still a demo booking as described here.

## Journey

1. Search (Phase 9) → results → offer page (Phase 10). The offer page shows
   **Book this demo offer** for demo offers that have a price.
2. `/book/:serviceType/:offerId?sid=&from=` (signed-in only). Opening it
   creates nothing. The page loads the offer from the stored search session
   (`GET /search/:type/sessions/:sid/offer`), so expired, unknown or
   tampered links show "This offer can no longer be booked".
3. Steps, kept in the URL as `&step=details|review` so Back/Forward work:
   1. **Check the offer**: the offer details, demo notice and price summary.
   2. **Travellers**: only what the category needs (below). Saved travellers
      (Phase 8) can fill the names. Details stay in memory only: not in the
      URL, browser storage or analytics; a reload starts them again.
      `?step=review` without valid details falls back to this step.
   3. **Review and confirm**: travellers, price, demo terms, and a required
      "I understand this is a demo booking" checkbox. Nothing is sent until
      **Confirm demo booking**.
4. `POST /api/v1/bookings` validates everything again on the server (below).
5. With a payment step (Phase 13): `/trips/:reference/pay`, then the
   payment status page ([payments.md](payments.md#web)).
6. `/trips/:reference/confirmation`: the reference, status "Demo confirmed",
   what was booked, the price, and the no-reservation/no-ticket/no-payment notice.
7. `/trips` (My trips) lists it under Upcoming; `/trips/:reference` shows the
   details, history, and the cancel action.

### What each category asks for

From `bookingRequirementsFor(offer)` in `@wayora/contracts`, shared by the
API (which enforces it) and the form (which renders it), derived only from
fields the offer contract has:

| Category | Names                                                     | Other                           |
| -------- | --------------------------------------------------------- | ------------------------------- |
| Flights  | One per passenger: Adult 1…n, Child…, Infant… (typed)     |                                 |
| Hotels   | Lead guest only (one guest checks in for the whole party) | Note says so                    |
| Trains   | One per passenger                                         |                                 |
| Buses    | One per passenger                                         |                                 |
| Holidays | One per traveller                                         |                                 |
| Cabs     | Lead passenger                                            | Mobile number (E.164), required |
| Metro    | None                                                      |                                 |

Flight and cab offers now say who they were searched for (`passengers` on the
result), so the party size comes from the offer the server stored, never from
the browser.

## Statuses

```
pending ──(demo confirmation, simulated by Wayora)──▶ confirmed
pending ──(payment mode demo: not paid in time)──▶ expired     (Phase 13)
pending ──▶ failed
pending | confirmed ──(you, before the travel date)──▶ cancelled
```

- Transitions are server-side only (`TRANSITIONS` in
  `apps/api/src/modules/bookings/lifecycle.ts`, shared with payments) and are applied with
  `UPDATE … WHERE status = <from>`, so two racing changes can't both win.
- Payment mode `none`: creation writes `pending` and immediately `confirmed`
  inside the same transaction (payment mode `demo` waits for the payment;
  [payments.md](payments.md#rules)), with actor `SYSTEM` and the note "Demo confirmation (simulated):
  Wayora did not contact a supplier, issue a ticket or take payment." It is
  labelled "Demo confirmed" everywhere.
- `failed` exists for a future supplier step; nothing produces it today.
  `HELD` (Phase 1 enum) is reserved and unused.
- Cancelling is allowed for `pending`/`confirmed` until the travel start date
  (inclusive), judged by the calendar in `Asia/Kolkata` (every demo place is in
  India). Metro bookings have no date and can always be cancelled. Cancelling
  only changes the status: no supplier is contacted and nothing is refunded,
  because nothing was paid (a booking paid with a demo payment has its payment
  flagged "refund required"; the demo provider can't refund). Cancelled and
  expired bookings are kept.
- Every change appends a `booking_status_events` row (who, when, note) and an
  `audit_logs` row (`booking.created`, `booking.cancelled`).

## API

All routes need a session (cookie); state-changing routes also need a trusted
`Origin` (CSRF, docs/auth.md). Responses are `Cache-Control: no-store`. The
user is always the session's user; no route accepts a user id. Bookings are
addressed by reference, and another user's reference answers `404` exactly
like a reference that doesn't exist (no IDOR, no existence leak).

| Method | Path                                     | Success | Notes                                                |
| ------ | ---------------------------------------- | ------- | ---------------------------------------------------- |
| POST   | `/api/v1/bookings`                       | 201     | `Idempotency-Key` header required                    |
| GET    | `/api/v1/bookings?view=&page=&pageSize=` | 200     | `view` = `upcoming` (default) · `past` · `cancelled` |
| GET    | `/api/v1/bookings/:reference`            | 200     |                                                      |
| POST   | `/api/v1/bookings/:reference/cancel`     | 200     | Returns the updated booking                          |

Create and cancel are limited to `BOOKING_RATE_LIMIT_MAX` (default 10) per
signed-in user per minute, on top of the general per-IP limit.

### Create request (`createBookingRequestSchema`, strict)

```json
{
  "serviceType": "hotels",
  "searchId": "0189…",
  "offerId": "demo-hotels:goa-casa-lagoa/…",
  "travellers": [{ "firstName": "Asha", "lastName": "Rao" }],
  "contactPhone": "+919876543210",
  "acceptedPrice": {
    "kind": "total",
    "total": { "amountMinor": "2340000", "currency": "INR" },
    "perUnit": null
  },
  "acceptDemoTerms": true
}
```

- `travellers`: exactly the slots the offer needs (names: letters, spaces,
  hyphens or apostrophes, 1–100 characters). `contactPhone` only when required (cabs);
  sending one when it isn't needed is refused rather than silently stored.
- `acceptedPrice` is the price the visitor saw. It is **never used as the
  price**: the server takes the price from its stored search and only compares
  them. If they differ the answer is `409 PRICE_CHANGED` and nothing is booked.
- `acceptDemoTerms` must be `true`.
- Unknown fields (e.g. `userId`, `total`) are rejected (`400`).

Server checks, in order: session → CSRF → rate limit → idempotency key format
→ body schema → offer from the stored search (same codes as the offer page:
`SEARCH_EXPIRED` 410, `OFFER_NOT_IN_SEARCH` 404, `CATEGORY_MISMATCH` 409, …) →
demo source only → has a price → `acceptedPrice` equal → traveller slots and
phone → transaction.

### Booking (`bookingSchema`)

`reference`, `status` (`pending|confirmed|cancelled|expired|failed`), `demo` (always
`true`), `serviceType`, `offer` (the offer as booked), `providerName`, `price`,
`partySize`, `startsOn`, `endsOn` (local dates; null for metro), `createdAt`,
`cancellable`, `payment` (Phase 13, [payments.md](payments.md#rules)), `travellers` (`firstName`, `lastName`, `type`), `contactPhone`,
`priceCheck` (`session` for demo offers: not rechecked with a supplier) and
`history` (`status`, `at`, `by: you|wayora`, `note`). List items
(`bookingSummarySchema`) omit names, phone and history. The list response has
`items`, `pagination` and `counts` per view (for the tab labels).

### Errors

| Code                      | HTTP | When                                                                     |
| ------------------------- | ---- | ------------------------------------------------------------------------ |
| `VALIDATION_FAILED`       | 400  | Bad body/query, missing or malformed `Idempotency-Key`, wrong travellers |
| `UNAUTHENTICATED`         | 401  | No session                                                               |
| `FORBIDDEN`               | 403  | Untrusted origin (CSRF)                                                  |
| `NOT_FOUND`               | 404  | Unknown reference, or someone else's                                     |
| `PRICE_CHANGED`           | 409  | `acceptedPrice` differs from the server's price                          |
| `BOOKING_NOT_CANCELLABLE` | 409  | Already cancelled, failed, or the trip has started                       |
| `IDEMPOTENCY_IN_PROGRESS` | 409  | The same key's first request is still running                            |
| `IDEMPOTENCY_KEY_REUSED`  | 422  | The key was used with a different body                                   |
| `RATE_LIMITED`            | 429  | Too many booking writes                                                  |
| Offer codes               |      | As in docs/search.md#errors (expired search, offer not in search…)       |

## Idempotency

`POST /bookings` requires `Idempotency-Key` (16–128 of `A-Z a-z 0-9 _ -`). It
uses the Phase 1 `idempotency_keys` table:

- Scope `POST /bookings:<userId>`: keys never collide across users.
- The request hash is SHA-256 of the canonical JSON body (sorted keys).
- **Claim**: insert the key `IN_PROGRESS` with a 60 s lock. A concurrent
  request with the same key gets `409 IDEMPOTENCY_IN_PROGRESS`. A lock that has
  expired (a crashed request) is taken over atomically.
- **Complete**: inside the booking's own transaction, the key becomes
  `COMPLETED` with `{ reference }` only (no personal data). Either both commit
  or neither does.
- **Replay**: the same key and body returns the original booking (current
  state) with status 201 and `Idempotent-Replayed: true`. The same key with a
  different body is `422 IDEMPOTENCY_KEY_REUSED`.
- **Failure**: any error before commit releases the key, so the same request
  can be retried.
- Keys expire after 24 h; the API purges expired keys hourly.

Tested against PostgreSQL: six concurrent requests with one key create exactly
one booking; a failure inside the transaction leaves no rows and frees the key.

The web app makes one key per distinct request body (`crypto.randomUUID()`):
double clicks and retries after a network error reuse it; changed details get
a new one. A synchronous guard also stops a second submit in the same tick, and
the button is disabled while saving; `IDEMPOTENCY_IN_PROGRESS` is retried
automatically up to three times, 1.5 s apart.

## Database

Migration `database/migrations/20261022000000_demo_bookings`. It reuses the
Phase 1 `bookings` table (which had no writer until now) and adds two tables.
`orders`, `booking_items` and payments are untouched, for a future payment phase.

**`bookings`** (new columns): `reference` (unique), `user_id` (FK users,
`RESTRICT`), `is_demo`, `search_id`, `offer_snapshot` (JSONB: `{ v: 1, offer,
providerName, priceCheck, searchGeneratedAt, searchExpiresAt }`), `party_size`,
`starts_on`, `ends_on` (`DATE`), `contact_phone`, `confirmed_at`,
`cancelled_at`. `order_id` and `total_amount_minor` become nullable (a demo
booking has no order; a cab estimate has no single total; the old default `0`
is dropped so "no total" is never stored as free). Indexes: `(user_id,
created_at DESC)`, `(user_id, status, starts_on)`.

**`booking_travellers`**: `booking_id`, `position` (unique per booking),
`type` (`passenger_type`: ADULT/CHILD/INFANT, flights only), `first_name`,
`last_name`.

**`booking_status_events`**: `booking_id`, `from_status`, `to_status`,
`actor_type`, `note`, `created_at`.

Guards in the database itself (hand-written SQL):

- Reference format; demo bookings use `WYD-` and can never have a
  `provider_reference` (no fake PNRs).
- Party size 1–50; dates ordered; phone is E.164; snapshot is a JSON object;
  `confirmed_at` set when confirmed; `cancelled_at` set exactly when cancelled.
- Trigger: what was booked is immutable; only `status`, its timestamps,
  `order_id`, `provider_reference` and `updated_at` may change.
- Booked travellers can't be updated; status events are append-only (so a
  booking with history can't be deleted either; account deletion is future work).

### Migration

- **Data safety**: the migration starts with a guard that aborts (changing
  nothing) if `bookings` has any rows, instead of inventing values for the
  new required columns. Every other change is additive. It was applied to a
  database replayed from all migrations and to the existing local dev and test
  databases (both had no bookings), then compared column-by-column with
  `schema.prisma` (no drift). Never reset or drop a database to apply it.
- **Apply**: `npm run db:migrate` (dev) or `prisma migrate deploy` (CI/prod).
- **Rollback** (only while no demo bookings need keeping; it deletes them):

```sql
BEGIN;
DROP TRIGGER IF EXISTS "booking_status_events_append_only" ON "booking_status_events";
DROP TRIGGER IF EXISTS "booking_travellers_immutable" ON "booking_travellers";
DROP TRIGGER IF EXISTS "bookings_booked_facts_immutable" ON "bookings";
DROP FUNCTION IF EXISTS "booking_status_events_prevent_mutation"();
DROP FUNCTION IF EXISTS "booking_travellers_prevent_update"();
DROP FUNCTION IF EXISTS "bookings_protect_booked_facts"();
DROP TABLE IF EXISTS "booking_status_events";
DROP TABLE IF EXISTS "booking_travellers";
DELETE FROM "bookings" WHERE "is_demo";
ALTER TABLE "bookings"
  DROP CONSTRAINT IF EXISTS "bookings_reference_chk",
  DROP CONSTRAINT IF EXISTS "bookings_demo_reference_chk",
  DROP CONSTRAINT IF EXISTS "bookings_demo_no_provider_reference_chk",
  DROP CONSTRAINT IF EXISTS "bookings_party_size_chk",
  DROP CONSTRAINT IF EXISTS "bookings_dates_chk",
  DROP CONSTRAINT IF EXISTS "bookings_contact_phone_chk",
  DROP CONSTRAINT IF EXISTS "bookings_offer_snapshot_chk",
  DROP CONSTRAINT IF EXISTS "bookings_confirmed_at_chk",
  DROP CONSTRAINT IF EXISTS "bookings_cancelled_at_chk",
  DROP CONSTRAINT IF EXISTS "bookings_user_id_fkey";
DROP INDEX IF EXISTS "bookings_reference_key";
DROP INDEX IF EXISTS "bookings_user_id_created_at_idx";
DROP INDEX IF EXISTS "bookings_user_id_status_starts_on_idx";
ALTER TABLE "bookings"
  DROP COLUMN "cancelled_at", DROP COLUMN "confirmed_at", DROP COLUMN "contact_phone",
  DROP COLUMN "ends_on", DROP COLUMN "is_demo", DROP COLUMN "offer_snapshot",
  DROP COLUMN "party_size", DROP COLUMN "reference", DROP COLUMN "search_id",
  DROP COLUMN "starts_on", DROP COLUMN "user_id",
  ALTER COLUMN "order_id" SET NOT NULL,
  ALTER COLUMN "total_amount_minor" SET DEFAULT 0,
  ALTER COLUMN "total_amount_minor" SET NOT NULL;
DROP TYPE IF EXISTS "passenger_type";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261022000000_demo_bookings';
COMMIT;
```

Then deploy the Phase 11 code. The `idempotency_keys` rows with scope
`POST /bookings:%` can be deleted too; they expire on their own.

## Web

| Route                            | Component           | Notes                                                               |
| -------------------------------- | ------------------- | ------------------------------------------------------------------- |
| `/book/:serviceType/:resultId`   | `CheckoutRoute`     | `?sid=&from=&step=`                                                 |
| `/trips`                         | `TripsRoute`        | `?view=upcoming                                                     | past | cancelled&page=` |
| `/trips/:reference`              | `TripDetailRoute`   | Details, travel status, timeline, cancel ([trips.md](trips.md#web)) |
| `/trips/:reference/confirmation` | `ConfirmationRoute` | After booking (replaces the checkout in history)                    |

All are under `RequireAuth` (signed-out visitors go to `/login?redirect=…`
and come back) and share one lazily loaded chunk (`features/bookings`). My
trips is in the account menu, the mobile drawer and the account side
navigation.

- `BookingPriceSummary` is the one price block for checkout, confirmation and
  details: party, per-unit price where the offer has one, "Taxes and fees: Not
  itemised in this offer" (no invented fees, taxes or discounts), and the
  total, or "Estimated fare" for cab ranges.
- The checkout has a sticky summary, a step indicator (`aria-current="step"`),
  focus moved to each step's heading, loading, error, expired and not-found
  states, and motion that follows reduced-motion settings (`@wayora/ui/motion`).
- My trips: tabs with counts, cards (status, dates, party, price, reference),
  pagination, and empty/error/loading states. Cancel asks for confirmation in a
  dialog that says what cancelling does and doesn't do.
- No traveller data goes into URLs, analytics or logs. The API's logger
  redacts `travellers`, names, phone numbers and dates of birth.

## Tests

- `packages/contracts/test/bookings.test.ts`: references, requirements per
  category, request/response schemas.
- `apps/api/test/integration/bookings.test.ts` (real PostgreSQL and Redis):
  every category; server-side price and tampering; expired, wrong-category and
  not-in-search offers; auth, CSRF, terms, key format; idempotent replay, key
  reuse, per-user scope, six concurrent requests → one booking, release on
  failure; a failing transaction leaves nothing; reference collision retry;
  database immutability guards; ownership (404 for others); views and
  pagination around travel dates; cancel once, concurrent cancels, started trips;
  rate limit per user; log redaction.
- `apps/web/test/bookings.test.tsx` (against `test/fake-booking-api.ts`):
  full journey from the offer page to My trips; validation; details kept on
  Back; review guard; saved-traveller prefill; flight passenger types; cab
  phone; metro without names; double submit sends one request; retry with the
  same key; in-progress retry; server field errors; price change; expired
  search; signed-out redirect; My trips empty/error/pagination/tabs; cancel
  dialog; not-found.

## Supplier reservations (Phase 23)

The booking lifecycle is ready for real supplier reservations, without any
being made today. What exists:

- an adapter boundary (`apps/api/src/modules/providers/reservations.ts`);
- a reservation lifecycle kept apart from the booking, payment and refund
  lifecycles;
- duplicate protection, recovery of unknown outcomes, cancellation through
  the supplier, and staff tools.

All of it is exercised end to end with the **test-only** fictional supplier
(`apps/api/test/fixture-supplier.ts`).

### What is real today

| Category | Supplier reservation API integrated | Reservation | Cancellation via Wayora | Tickets / vouchers |
| -------- | ----------------------------------- | ----------- | ----------------------- | ------------------ |
| Flights  | None                                | Demo only   | Demo only               | None issued        |
| Hotels   | None                                | Demo only   | Demo only               | None issued        |
| Trains   | None                                | Demo only   | Demo only               | None issued        |
| Buses    | None                                | Demo only   | Demo only               | None issued        |
| Metro    | None                                | Demo only   | Demo only               | None issued        |
| Cabs     | None                                | Demo only   | Demo only               | None issued        |
| Holidays | None                                | Demo only   | Demo only               | None issued        |

### Separate lifecycles

A booking's parts each have their own state. None is inferred from another:

| What                         | Where                                                                      | States                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Wayora booking               | `bookings.status`                                                          | `PENDING`, `CONFIRMED`, `CANCELLED`, `FAILED`, `EXPIRED` (above)                                |
| Supplier reservation         | `supplier_reservations.status` (supplier bookings only)                    | `PENDING`, `IN_PROGRESS`, `CONFIRMED`, `FAILED`, `UNKNOWN`, `CANCELLATION_PENDING`, `CANCELLED` |
| Payment                      | `payments.status` ([payments.md](payments.md))                             | unchanged                                                                                       |
| Tickets, vouchers, itinerary | `travel_documents` (rows only when a supplier issued one)                  | issued or none                                                                                  |
| Cancellation request         | the reservation's `CANCELLATION_PENDING` / `CANCELLED`, key and timestamps | not requested, pending, cancelled                                                               |
| Refund                       | `refunds.status` ([payments.md](payments.md#refunds))                      | `REQUIRED`, `REQUESTED`, `PENDING`, `SUCCEEDED`, `FAILED`, `UNKNOWN`                            |

```
reservation:  PENDING ──send──▶ IN_PROGRESS ──confirmed──▶ CONFIRMED ──cancel──▶ CANCELLATION_PENDING ──confirmed──▶ CANCELLED
                 │                 │   ├──rejected──▶ FAILED                              └──refused──▶ CONFIRMED
                 │                 │   └──no definitive answer──▶ UNKNOWN ──lookup / same-key resend──┐
                 │                 └──accepted, not confirmed (stays IN_PROGRESS, checked later)       │
                 └──(supplier switched off; nothing sent)──▶ FAILED          UNKNOWN ──▶ CONFIRMED | FAILED | IN_PROGRESS
booking:      PENDING ──(reservation CONFIRMED)──▶ CONFIRMED ──(reservation CANCELLED)──▶ CANCELLED
              PENDING ──(reservation FAILED)──▶ FAILED
```

**Rules for the booking and reservation states**

- A supplier booking is `CONFIRMED` only when its reservation is `CONFIRMED`,
  which needs the supplier's own reference.
  - A database trigger refuses anything else. A supplier booking can't
    become `CONFIRMED`, `CANCELLED` or `FAILED` unless its reservation is in
    the matching state.
  - Sending a request never confirms anything.
- `UNKNOWN` means the request was sent but no definitive answer came back:
  a timeout, a 5xx, a dropped connection or an unreadable answer. The supplier
  may or may not hold the reservation.
  - The booking stays `pending`.
  - The traveller sees "Checking with the supplier".
  - Wayora never sends a new reservation request until the outcome is known.
- Payment and reservation stay separate:
  - Supplier bookings take no payment on Wayora. `settlement: 'supplier'`
    means the traveller pays the supplier under its own terms; Wayora has no
    real payment gateway.
  - So suppliers that need payment through Wayora can't be booked.
  - Payment mode is `NONE`, and any refund of what was paid to the supplier
    follows the supplier's terms.
- Wayora references stay Wayora's:
  - Demo bookings use `WYD-XXXX-XXXX`; supplier bookings use `WY-XXXX-XXXX`
    (the `WY-` prefix was reserved by the Phase 12 check constraint).
  - The supplier's reference is shown separately, and only once the supplier
    confirmed.
  - Demo bookings can never have a supplier reservation or reference (trigger
    and check).

### Adapter boundary

A live adapter whose supplier documents a booking API implements
`SupplierReservations` and declares `operations.book: 'supported'`. The
registry refuses a provider whose declaration and implementation disagree,
and demo providers can't book.

| Member              | Meaning                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `settlement`        | `'supplier'`: the only kind supported (see above)                                                         |
| `idempotentReserve` | `true` only if the supplier **documents** de-duplicating reservation requests by Wayora's idempotency key |
| `reserve(request)`  | Sends exactly one request; never retries itself                                                           |
| `lookup?(ref)`      | Read-only status lookup by key or reference, if the supplier has one                                      |
| `cancel?(ref)`      | Cancels a confirmed reservation, if the supplier supports it                                              |

**`reserve(request)`**

- The request is built only from server records:
  - the booking's immutable offer snapshot, and its price as `expectedPrice`;
  - the booked travellers and contact phone;
  - Wayora's reference and the reservation's `idempotencyKey`.
- No client value is used.

**What adapters return**

- `rejected` (with `offer-unavailable`, `price-changed`, `invalid-details` or
  `other`) only for a definite refusal: a documented refusal status, or a
  request refused before processing.
- Anything they can't map is thrown, and the outcome becomes `UNKNOWN`.
- Every answer is validated (`reservationOutcomeSchema`):
  - references must be printable and non-empty;
  - document types are `ticket`, `voucher` or `itinerary`;
  - prices are integer minor units.
- A "confirmed" answer without a reference is unusable (the outcome becomes
  `UNKNOWN`). No reference is ever generated.
- Each call has a time limit, `SUPPLIER_RESERVATION_TIMEOUT_MS` (default
  12 s, within the web client's 15 s). A call that runs out is `UNKNOWN`
  (`TIMEOUT`).

### Making a reservation

`POST /bookings` with a supplier offer works only when all of these hold:

- `SUPPLIER_RESERVATIONS_ENABLED=true`;
- the offer's provider is enabled and implements reservations;
- its circuit breaker isn't open;
- the offer has an exact total price (estimates can't be reserved);
- the request has `acceptSupplierTerms: true` (demo offers need
  `acceptDemoTerms: true`; the server checks which applies).

Otherwise: `503 SERVICE_UNAVAILABLE`, `503 PROVIDER_UNAVAILABLE` or a
validation error, and **nothing is recorded or sent**.

Then:

1. The usual checks run:
   - the offer comes from the server's search session, revalidated if the
     supplier supports it;
   - the accepted price must match the server's (`PRICE_CHANGED` otherwise);
   - the category's traveller details are checked.
2. One transaction records:
   - the booking (`WY-…`, `PENDING`, `is_demo = false`, payment mode `NONE`);
   - the reservation (`PENDING`, with a fresh `idempotency_key`);
   - both histories;
   - the "requested" notification and the audit entry;
   - the idempotency outcome.

   From here, the same request (same `Idempotency-Key` and body) returns
   this booking and never reaches the supplier again.

3. After commit, the reservation is **claimed** with a conditional update
   (`PENDING → IN_PROGRESS`, `attempts + 1`). Only the process that changes
   the row sends the request.
4. The answer is applied in one transaction (booking row locked):
   - `confirmed` → reservation `CONFIRMED`:
     - the supplier reference is stored (set once, unique per provider) and
       copied to `bookings.provider_reference`;
     - the normalized `confirmed_details` are stored;
     - `travel_documents` rows are written for documents the supplier issued
       (unknown traveller indexes are dropped and logged);
     - the booking goes to `CONFIRMED`, with a notification and audit entry.
     - If the confirmed price differs from the booked one, it is still
       confirmed (the supplier holds it), but marked `PRICE_MISMATCH` and
       `needs_attention` for staff, and the traveller is told.
     - If a reference already belongs to another booking, it is never
       attached twice: the reservation stays open for staff.
   - `pending` → stays `IN_PROGRESS`, checked later (or needs attention if
     the supplier has no lookup).
   - `rejected` → reservation `FAILED` with a normalized category; booking
     `FAILED` with a `BOOKING_FAILED` notification ("nothing was reserved,
     Wayora took no payment").
   - thrown / timed out → `UNKNOWN`, `ambiguous`, with an error category
     (`TIMEOUT`, `UNAVAILABLE`, `INVALID_RESPONSE`, `UNKNOWN`).
5. The response is `201` with the booking in whatever state it reached. A
   failure after the commit never fails the request: the booking exists and
   shows its state.

### Idempotency and duplicates

| Layer              | Protection                                                                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP               | `Idempotency-Key` on `POST /bookings` ([Idempotency](#idempotency)), persisted in `idempotency_keys`. Replay returns the same booking; a reused key with another body is `422 IDEMPOTENCY_KEY_REUSED`; a concurrent duplicate is `409 IDEMPOTENCY_IN_PROGRESS` |
| Booking → supplier | One reservation per booking (`supplier_reservations.booking_id` unique); its `idempotency_key` is unique and immutable                                                                                                                                         |
| Sending            | Only a conditional `PENDING → IN_PROGRESS` (or `UNKNOWN → IN_PROGRESS` for a permitted resend) sends; concurrent senders lose the update                                                                                                                       |
| Supplier side      | The key is sent with every request; resends (same key) only to suppliers with `idempotentReserve: true`                                                                                                                                                        |
| Supplier reference | Unique per provider (`supplier_reservations` and `bookings`), set once (trigger)                                                                                                                                                                               |
| Cancellation       | One `cancellation_key` per reservation (set once); a second cancel while pending changes nothing and calls nothing                                                                                                                                             |

No in-memory lock is involved anywhere: every guard is a database constraint
or a conditional update.

### Recovery

Supplier calls live in the API (the adapters and their credentials are
there), so recovery runs like payment maintenance:

- every 30 s on each API instance (`server.ts`), as
  `ReservationService.reconcileDue`;
- and on a read of the booking when its check is due.

Each row is first **leased** with a conditional update of `next_check_at`, so
two instances never handle the same row. The BullMQ worker has no adapters
and isn't used for this.

| State                                   | What recovery does                                                                                                                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PENDING` older than 60 s               | Never sent (the process stopped between commit and send): sends it once, with the same claim rule                                                                                                        |
| `IN_PROGRESS` / `UNKNOWN`, with lookup  | Read-only lookup: `confirmed` / `rejected` apply; `pending` waits; `not-found` means "not reserved" only 15 minutes after the last request (suppliers can lag), otherwise it waits                       |
| `UNKNOWN`, no lookup, de-duplicating    | Resends the **same** request with the **same** key, at most 3 requests in total                                                                                                                          |
| `UNKNOWN`, no lookup, no de-duplication | Stops: `needs_attention`. Wayora never resends. Staff reconcile it                                                                                                                                       |
| `CANCELLATION_PENDING`                  | Lookup: `cancelled` completes it; still `confirmed` → the cancellation is asked again with the same cancellation key (cancelling creates nothing), at most 3 times; without a lookup → `needs_attention` |

Checks back off exponentially:

- from 30 s, doubling, capped at 30 min, with half of each delay jittered;
- after 8 checks the row is handed to staff (`needs_attention`).

Every recovery step is logged with its correlation id, provider, operation
and outcome category; no payloads or traveller data are logged.

### Operational handling of ambiguous reservations

A reservation needs attention when recovery can't settle it. That happens
when there is no lookup and no safe resend, checks are exhausted, the
supplier is switched off, a price mismatch is found, or a reference is
already in use.

1. Find it: **Admin → Bookings**, filter "Supplier reservation: Needs
   attention" (`GET /admin/bookings?attention=true`).
2. Open the booking. The reservation panel shows:
   - status, ambiguity and the last error category;
   - requests, cancellation requests and checks made;
   - the last request time and its correlation id (for supplier support and
     the logs);
   - the supplier's capabilities, documents, and the full reservation history.
3. If the supplier has a lookup, **Check with the supplier now** runs one
   read-only lookup. It never sends a reservation, even to a de-duplicating
   supplier.
4. Otherwise, contact the supplier with the booking's Wayora reference (sent
   with every request) and the correlation id, then **Record the outcome**:
   - reserved (with the supplier's reference) or not reserved;
   - for a pending cancellation: cancelled, or still confirmed (reference
     must match).

   A reason of 10+ characters is required. It is kept in the audit log
   (`reservation.resolved_manually`) and never shown to the traveller. The
   booking, notification and history follow as if the supplier had
   answered.

5. Never book the same offer again with the supplier "to retry": that is
   exactly the duplicate this lifecycle prevents.

Both actions are admin-only (`admin.reservations.manage`). Support staff see
the panel with the supplier reference masked to its last four characters.

### Cancellation

- Demo bookings: unchanged (status only).
- Supplier bookings can be cancelled only when all of these hold:
  - the booking and reservation are `CONFIRMED`;
  - the trip hasn't started;
  - the supplier implements `cancel`.

  Otherwise `409 BOOKING_NOT_CANCELLABLE`, with Wayora's explanation:
  - not confirmed yet (if the supplier never confirms, nothing is reserved);
  - nothing reserved;
  - cancellation not available through Wayora: contact the supplier with
    its reference, under its own terms.

- The request first moves the reservation to `CANCELLATION_PENDING` (with a
  set-once `cancellation_key`). The booking **stays `CONFIRMED`**.
- Then the supplier is asked:
  - `cancelled` → reservation `CANCELLED`, booking `CANCELLED`, notification;
  - `pending` / no answer → stays pending and recovery checks it;
  - `rejected` → back to `CONFIRMED` (`NOT_CANCELLABLE`), and the request
    answers `409`: the supplier refused, so it stays confirmed.
- A second cancel while one is pending is refused without calling the supplier.
- Cancellation terms are shown only when the supplier's offer carried them
  (`cancellationPolicy`, Phase 22). Demo offers never do.

### Travel documents

- `travel_documents` holds tickets, vouchers and itineraries **only as the
  supplier issued them**: type, reference, traveller, issue time.
- A trigger allows rows only for a reservation that is `CONFIRMED` (or has a
  cancellation pending), for the same booking. Rows can't be changed or
  deleted.
- Demo bookings show "no ticket, voucher or PNR exists". Supplier bookings
  without documents say none were issued through Wayora and point to the
  supplier reference.
- No ticket, PNR or confirmation number is ever generated.

### API additions

**`Booking` and `BookingSummary`**

- New: `reservation` — `kind` (`demo` / `supplier`), `state`,
  `supplierReference` (only once confirmed), `confirmedAt`, `priceMismatch`,
  `needsAttention`, `explanation`.
- New on `Booking` only:
  - `documents` (`state`, `items`, `explanation`);
  - `cancellation` (`available`, `state`, `explanation`, supplier `policy`);
  - `refund` (`state`, `amount`, `demo`, `explanation`).
- `history[].by` can be `supplier`.

All explanations are Wayora's own wording; supplier text is never shown.

**Other changes**

- `GET /bookings/:reference` checks a due reservation with the supplier
  before answering. The schedule bounds how often a read can reach the
  supplier.
- The offer endpoint adds `booking: { available, kind: 'demo' | 'supplier', reason }`.
- Booking errors are unchanged: `SERVICE_UNAVAILABLE`, `PROVIDER_UNAVAILABLE`,
  `PRICE_CHANGED`, `VALIDATION_FAILED` (`body.acceptSupplierTerms` /
  `body.acceptDemoTerms`), `BOOKING_NOT_CANCELLABLE`, `IDEMPOTENCY_*`.

### Web

**Offer page**

- An available supplier offer shows "Request this booking" with the supplier
  terms.
- Otherwise the server's reason is shown, and no booking action.

**Checkout**

- The same steps, with the "Booking request" label.
- The supplier terms, and the "I understand how this supplier booking works"
  checkbox.
- The button reads "Send booking request"; the request carries
  `acceptSupplierTerms: true`.

**Confirmation page**

- "<supplier> confirmed your booking" (with its reference), "Your booking
  request was sent" (unknown or pending), or "Your booking wasn't confirmed".
- The Wayora reference is labelled as Wayora's own.

**Trip page**

- A "Booking status" panel with one line each for: supplier reservation (or
  "Demo booking: no supplier reservation"), payment, tickets and vouchers,
  cancellation and refund.
- Alerts for not-confirmed-yet, needs attention, price mismatch and not booked.
- While the reservation is open, the page re-reads every 15 s, and "Check
  again" re-reads on demand. Reads never resend anything.
- Cancellation:
  - supplier bookings get "Request cancellation", with the supplier's terms
    when it gave any;
  - the toast says "Booking cancelled" or "Cancellation requested";
  - a refusal is shown in the dialog.

**Labels**

- "Supplier booking" (never "live" or "instant").
- Demo bookings keep "Demo booking" and "Demo confirmed".

### Database (migration `20261031000000_supplier_reservations`)

Additive only:

- five enums;
- the `BOOKING_FAILED` notification type;
- four tables: `supplier_reservations`, `reservation_events`,
  `travel_documents`, `refunds`;
- a stricter `bookings_protect_booked_facts`, which makes the provider
  reference set-once and makes a supplier booking's status follow its
  reservation.

No existing row changes.

Hand-written constraints:

- confirmed (or later) needs a supplier reference and `confirmed_at`;
- `CANCELLED` ⇔ `cancelled_at`;
- a cancellation needs its key and time;
- `ambiguous` only for `UNKNOWN` / `CANCELLATION_PENDING`;
- counters are non-negative;
- references are non-blank;
- `reservation_events` is append-only;
- `travel_documents` are immutable and only for confirmed reservations;
- reservations only for non-demo bookings of the same provider.

Refund constraints are in [payments.md](payments.md#refunds).

### Phase 23 rollback

Back up first. The rollback refuses to run if any supplier booking exists, or
any refund other than a recorded-only `REQUIRED` one, because those records
would be lost. In that case, export them first.

```sql
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bookings" WHERE NOT "is_demo") THEN
    RAISE EXCEPTION 'supplier bookings exist; export them before rolling back Phase 23';
  END IF;
  IF EXISTS (SELECT 1 FROM "refunds" WHERE "status" <> 'REQUIRED') THEN
    RAISE EXCEPTION 'refunds in progress or settled exist; export them before rolling back Phase 23';
  END IF;
END
$$;
-- The Phase 13 version of the bookings trigger function.
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
    OR NEW."payment_mode" IS DISTINCT FROM OLD."payment_mode"
    OR NEW."payment_due_at" IS DISTINCT FROM OLD."payment_due_at"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'bookings: booked facts are immutable (only status changes)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
DROP TABLE "refunds";
DROP TABLE "travel_documents";
DROP TABLE "reservation_events";
DROP TABLE "supplier_reservations";
DROP FUNCTION "refunds_check_insert"(), "refunds_protect_facts"(), "refunds_prevent_delete"(),
  "travel_documents_check_insert"(), "travel_documents_prevent_mutation"(),
  "reservation_events_prevent_mutation"(), "supplier_reservations_protect_facts"(),
  "supplier_reservations_check_booking"();
DROP TYPE "refund_reason", "refund_status", "travel_document_type",
  "reservation_error_category", "reservation_status";
COMMIT;
```

The `BOOKING_FAILED` notification value stays in `notification_type`
(PostgreSQL can't drop an enum value). Only supplier bookings create such
notifications, and the guard above ensures there are none. Then deploy the
Phase 22 API and web.

Tested on a copy of the test database:

- the rollback refuses while a supplier booking exists;
- it removes exactly these objects (tables, enums, functions, triggers) and
  restores the Phase 13 trigger function;
- the migration applies again afterwards, with an identical schema and the
  tests passing. Its notification value uses `ADD VALUE IF NOT EXISTS` for
  this reason.

## Limitations

- No real supplier reservation, cancellation, ticket or refund API is
  integrated ([providers.md](providers.md)). Supplier bookings exist only with
  the test-only fixture supplier, and only when
  `SUPPLIER_RESERVATIONS_ENABLED=true`. Everything users can book today is a
  demo booking.
- Supplier bookings need suppliers paid directly by the traveller
  (`settlement: 'supplier'`): Wayora has no real payment gateway.
- Recovery runs in API instances on a 30 s timer (not the worker). With no
  API instance running, nothing is checked.
- No supplier webhooks for reservation updates: suppliers that only confirm
  by webhook would need one.
- Amendments, partial cancellations and per-traveller tickets beyond the
  supplier's own references aren't modelled.
- Demo only: no supplier reservation, ticket, real payment or refund for demo
  bookings.
- Demo offers are not rechecked with a supplier (`priceCheck: session`), and
  their availability isn't checked: the same demo offer can be booked many times.
- No cancellation policies, amendments, seat/room selection, extras, invoices
  or e-mails. No itemised taxes or fees (the offers don't carry them).
- "Today" for travel dates is the India calendar; multi-time-zone travel will
  need the place's zone per booking.
- Bookings can't be deleted (append-only history; users `RESTRICT`), so account
  deletion needs its own design.
- Traveller names are stored as entered for the booking (no identity checks).
