# Demo bookings (Phase 12)

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

| Route                            | Component           | Notes                                            |
| -------------------------------- | ------------------- | ------------------------------------------------ |
| `/book/:serviceType/:resultId`   | `CheckoutRoute`     | `?sid=&from=&step=`                              |
| `/trips`                         | `TripsRoute`        | `?view=upcoming                                  | past | cancelled&page=` |
| `/trips/:reference`              | `TripDetailRoute`   | Details, history, cancel                         |
| `/trips/:reference/confirmation` | `ConfirmationRoute` | After booking (replaces the checkout in history) |

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

## Limitations

- Demo only: no supplier reservation, ticket, real payment or refund. Live offers
  are refused for booking until a supplier booking step exists.
- Demo offers are not rechecked with a supplier (`priceCheck: session`), and
  their availability isn't checked: the same demo offer can be booked many times.
- No cancellation policies, amendments, seat/room selection, extras, invoices
  or e-mails. No itemised taxes or fees (the offers don't carry them).
- "Today" for travel dates is the India calendar; multi-time-zone travel will
  need the place's zone per booking.
- Bookings can't be deleted (append-only history; users `RESTRICT`), so account
  deletion needs its own design.
- Traveller names are stored as entered for the booking (no identity checks).
