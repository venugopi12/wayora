# Coupons, promotions and pricing rules (Phase 26)

Wayora has one promotion engine in the API. It looks up coupons and
automatic offers, checks whether a booking qualifies, works out the
discount in integer minor units, reserves a use while the customer pays,
and confirms or gives back that use as the booking and payment progress.
The browser sends only a coupon code. Every amount it shows comes from the
server.

All discounts apply to **demo bookings** (bookings with payment mode `DEMO`).
No real money moves, and no promotion changes an offer's price.

## Contents

- [Architecture](#architecture)
- [Data model](#data-model)
- [Calculation order](#calculation-order)
- [Discounts](#discounts)
- [Eligibility](#eligibility)
- [Stacking](#stacking)
- [Automatic promotions](#automatic-promotions)
- [Lifecycle](#lifecycle)
- [Before payment](#before-payment)
- [Loyalty and travel credit](#loyalty-and-travel-credit)
- [API](#api)
- [Errors](#errors)
- [Admin](#admin)
- [Web](#web)
- [Security](#security)
- [Configuration](#configuration)
- [Database](#database)
- [Tests](#tests)
- [Limitations](#limitations)

## Architecture

| Piece                                                   | Role                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `packages/contracts/src/promotions.ts`                  | Code normalization, admin input validation, response schemas, the rejection codes                |
| `apps/api/src/modules/promotions/engine.ts`             | Pure rules: `discountFor`, `staticRejection`, `rankAutomatic`, customer-facing messages          |
| `apps/api/src/modules/promotions/promotions.service.ts` | Lookup, locked checks, reservation, removal, revalidation, reconcile, sweep, discovery and admin |
| `apps/api/src/modules/pricing/breakdown.ts`             | The single source of the amount to pay: total − promotions − applied rewards                     |
| `apps/api/src/modules/promotions/promotions.routes.ts`  | Customer, booking-pricing and admin routes                                                       |

The service plugs into the existing modules instead of duplicating them:

- `PaymentsService.onSettled` reconciles a booking's promotions after a payment
  settles (promotions first, then rewards).
- `PaymentsService.onBeforePayment` revalidates coupons before an attempt is
  created.
- `BookingsService` applies the best automatic offer after a demo booking is
  created (best effort: a failure leaves the booking at full price).
- `RewardsService.releaseApplied` gives back applied points and credit
  whenever a booking's promotions change.
- `server.ts` runs `promotions.sweep()` every minute to release holds whose
  payment window has passed.

## Data model

**`promotions`**: one row per coupon or automatic offer.

- `kind`: `COUPON` (has a unique `code`) or `AUTOMATIC` (no code).
- `discount_type`: `PERCENTAGE` (`percent_bps`, 1–9000, so at most 90%; an
  optional `max_discount_minor` cap) or `FIXED` (`amount_minor`).
- `min_amount_minor` and `currency` (ISO 4217; one currency per promotion).
- `categories travel_category[]`; empty means every category.
- `starts_at` and `ends_at`. The end is exclusive.
- `usage_limit` (total uses) and `per_user_limit`, both optional.
- `first_booking_only`, `user_id` (a personal offer for one customer),
  `stackable`, `listed`, `active`.
- `version`, which goes up on every edit, and `created_by` / `updated_by`.

**`promotion_redemptions`**: one row per use of a promotion on a booking.

- `status`: `RESERVED`, `REDEEMED`, `RELEASED` or `REVERSED`.
- `reserved_until`: the booking's payment due time.
- The facts of the use: `promotion_version`, `eligible_amount_minor`,
  `discount_minor`, `currency`, `user_id`, `booking_id` and `kind`.
- `redeemed_at`, `closed_at` and `close_reason`.

Codes are normalized the same way everywhere (`normalizeCouponCode`: NFKC,
spaces removed, capitals). They must match `^[A-Z0-9][A-Z0-9-]{2,23}$` and are
unique for good: a code is never reused, even after its promotion ends.

## Calculation order

```
original price (booking total; never changed)
  − promotions (automatic offer and/or coupon)      = after promotions
  − loyalty points (measured on "after promotions")
  − travel credit  (measured on "after promotions")
  = to pay  (never below ₹1 / 100 minor units)
```

`GET /bookings/:reference/pricing` returns exactly these lines. Payments,
the booking's `payment.amount` and the rewards quote all read the same
`payableMinor` from `pricing/breakdown.ts`, under the booking lock. Nothing
is discounted twice: each step works on what is left after the previous one.

## Discounts

All maths is `bigint` on minor units, with no floats:

- **Percentage:** `floor(eligible × percent_bps / 10000)`, then capped at
  `max_discount_minor`.
- **Fixed:** `amount_minor`.
- **Either:** at most `eligible − 100`, so the amount to pay never falls below
  `MIN_PAYABLE_MINOR` (₹1). A computed discount of 0 counts as "minimum not
  met".

`eligible` is the booking total, or for a stackable coupon, the total minus
the automatic discount.

## Eligibility

The pure checks run in this order, and the first failure is the answer:

1. A personal offer for another customer → `COUPON_NOT_FOUND`. It looks
   exactly like an unknown code, so nothing about other customers leaks.
2. Not active → `COUPON_INACTIVE`.
3. Before `starts_at` → `COUPON_NOT_STARTED`.
4. At or after `ends_at` → `COUPON_EXPIRED`.
5. Booking currency differs → `CURRENCY_NOT_SUPPORTED`.
6. Booking category not in `categories` → `CATEGORY_NOT_ELIGIBLE`.
7. Total below `min_amount_minor`, or discount 0 → `MINIMUM_AMOUNT_NOT_MET`.

Then, in the transaction, with the promotion row locked (`FOR UPDATE`) and a
per-customer advisory lock (`pg_advisory_xact_lock(hashtext('promotions:user:' || user_id))`):

8. First booking only: the customer must have no other confirmed booking and
   no other open first-booking use → else `USER_NOT_ELIGIBLE`.
9. Per-customer limit: reserved and redeemed uses by this customer →
   `USER_USAGE_LIMIT_REACHED`.
10. Total limit: all reserved and redeemed uses → `USAGE_LIMIT_REACHED`.

Holds whose payment window has passed are released before counting, so an
abandoned checkout never blocks the last use. Because the promotion row is
locked, two checkouts racing for the last use can't both get it; the
integration tests run that race.

## Stacking

- One coupon per booking. Applying another replaces it (the first is
  released, reason `REPLACED`).
- At most one automatic offer per booking. A partial unique index enforces
  one open use per (booking, kind).
- **Non-stackable coupon** (the default): it replaces the automatic offer
  only if it takes more off. Otherwise the answer is
  `PROMOTION_NOT_STACKABLE` and the automatic offer stays.
- **Stackable coupon:** applied after the automatic offer, on what is left.
- Removing the coupon lets the best automatic offer apply again.

## Automatic promotions

When a demo booking is created, and whenever its pricing is read while it
has no open promotion, the engine picks among automatic offers the booking
qualifies for (the same checks as coupons). Selection is deterministic:
largest discount, then the one ending soonest, then the oldest, then by id.
The breakdown names the offer and its description, so the customer sees why
the price is lower.

No promotions are seeded. Offers exist only when an administrator creates
them.

## Lifecycle

```
RESERVED ──(booking paid and confirmed)──▶ REDEEMED ──(booking cancelled)──▶ REVERSED
    │
    ├──(customer removes or replaces it)───────────────▶ RELEASED (REMOVED / REPLACED)
    ├──(booking expired, failed or cancelled unpaid)───▶ RELEASED (BOOKING_CLOSED)
    ├──(payment window passed, nothing paying)─────────▶ RELEASED (RESERVATION_EXPIRED)
    └──(coupon switched off or ended before payment)───▶ RELEASED (COUPON_INACTIVE / COUPON_EXPIRED)
```

- "Applied" in the UI is a `RESERVED` row. Its discount is fixed when it's
  reserved, and later edits to the promotion don't change it.
- A use becomes `REDEEMED` **only** in `reconcileBooking`, after the payment
  succeeded and the booking is confirmed. Reconcile runs from the payment
  `onSettled` hook, on pricing reads and from the sweep, and is idempotent.
- Released and reversed uses no longer count towards limits. A database
  trigger stops a closed use from reopening and keeps its facts immutable.
- Cancelling a paid demo booking refunds only what was paid (the discounted
  amount), and the use is `REVERSED`. Neither the discount nor a second
  discount is paid out.

## Before payment

`POST /bookings/:reference/payments` calls `revalidateBeforePayment` first.
A reserved coupon that has been switched off, or has ended, is released.
Applied rewards are given back so they can be applied to the new price, and
the payment is refused with `PAYMENT_AMOUNT_MISMATCH`: "The amount to pay has
changed (for example, a coupon stopped being valid). Review the new amount
and pay again." The next pricing read carries a `notice` explaining what
happened, and the checkout shows it before the customer pays the new amount.

## Loyalty and travel credit

- Points and credit are measured on the amount **after promotions**. The
  rewards quote returns `afterPromotions`, and its limits (the 50% points
  cap, the ₹1 minimum) use it.
- Any change to a booking's promotions (apply, replace, remove, revalidate,
  automatic re-apply) calls `RewardsService.releaseApplied`. That gives back
  applied points and credit through the existing ledger (audited as
  `rewards.redemption.released_for_repricing`), so they are never measured on
  a stale price. Balances are never written directly.
- Points are earned on the cash actually paid, which is already after
  promotions, points and credit (docs/rewards.md#earning).

## API

All amounts are `{ amountMinor, currency }`, and responses are wrapped in
`{ data, meta }`.

| Method   | Path                                  | Who                         | Notes                                                               |
| -------- | ------------------------------------- | --------------------------- | ------------------------------------------------------------------- |
| `GET`    | `/promotions?category=`               | anyone                      | Running, listed offers, plus the signed-in customer's personal ones |
| `GET`    | `/bookings/:reference/pricing`        | booking owner               | The breakdown; applies the best automatic offer if none is open     |
| `PUT`    | `/bookings/:reference/pricing/coupon` | booking owner, rate limited | Body `{ code }` only                                                |
| `DELETE` | `/bookings/:reference/pricing/coupon` | booking owner, rate limited |                                                                     |
| `GET`    | `/admin/promotions`                   | `admin.promotions.read`     | Filters `state`, `kind`, `q`; with usage counts                     |
| `GET`    | `/admin/promotions/:id`               | `admin.promotions.read`     |                                                                     |
| `GET`    | `/admin/promotions/:id/usage`         | `admin.promotions.read`     | Booking references, no customer details                             |
| `POST`   | `/admin/promotions`                   | `admin.promotions.manage`   | `adminPromotionInputSchema`; duplicate code → `409 CONFLICT`        |
| `PATCH`  | `/admin/promotions/:id`               | `admin.promotions.manage`   | Kind and code can't change; `reason` required                       |
| `POST`   | `/admin/promotions/:id/status`        | `admin.promotions.manage`   | `{ active, reason }`                                                |

Another customer's booking answers `404`, as an unknown reference does.

## Errors

| Code                       | HTTP | Message (customer-facing)                                                              |
| -------------------------- | ---- | -------------------------------------------------------------------------------------- |
| `COUPON_NOT_FOUND`         | 422  | We don’t recognise that code. Check it and try again.                                  |
| `COUPON_EXPIRED`           | 422  | This code has expired.                                                                 |
| `COUPON_NOT_STARTED`       | 422  | This code isn’t valid yet.                                                             |
| `COUPON_INACTIVE`          | 422  | This code isn’t active.                                                                |
| `MINIMUM_AMOUNT_NOT_MET`   | 422  | This booking doesn’t reach the minimum amount for this code.                           |
| `CATEGORY_NOT_ELIGIBLE`    | 422  | This code can’t be used on this kind of booking.                                       |
| `CURRENCY_NOT_SUPPORTED`   | 422  | This code can’t be used on bookings in this currency.                                  |
| `USER_NOT_ELIGIBLE`        | 422  | Your account isn’t eligible for this code.                                             |
| `USAGE_LIMIT_REACHED`      | 409  | This code has reached its usage limit.                                                 |
| `USER_USAGE_LIMIT_REACHED` | 409  | You’ve already used this code as many times as it allows.                              |
| `PROMOTION_NOT_STACKABLE`  | 409  | This code can’t be combined with the offer already applied, and doesn’t take more off. |

No message mentions another customer, how many uses remain, or why a
personal offer exists. Each rejection is audited as
`promotion.coupon_rejected`, with the code and reason but never the
customer's other bookings.

## Admin

- **Permissions:** `admin.promotions.read` (support and admin) and
  `admin.promotions.manage` (admin only), enforced on the server for every
  route. The web hides the forms for support staff, for presentation only.
- **Pages:**
  - `/admin/promotions`: a list filtered by state (running, scheduled, ended,
    inactive), kind and text, showing redeemed and reserved counts and the
    discount given.
  - `/admin/promotions/new`: create a promotion.
  - `/admin/promotions/:id`: configuration; performance (redeemed, reserved,
    released, reversed, discount given, booking value); switch on or off
    with a reason; edit with a reason; paged usage history with booking
    references only.
- **Validation:** the same strict schema as the API. Percent is entered as a
  percentage and sent as basis points. Money is entered in units and sent
  as minor-unit strings, converted without floats. Dates are entered in
  India time and sent with `+05:30`.
- **Audit:**
  - `promotion.created`
  - `promotion.updated`, with `{reason, version, changes: {field: {from, to}}}`
  - `promotion.activated` / `promotion.deactivated`, with the reason
  - `promotion.coupon_applied` / `promotion.coupon_removed` /
    `promotion.coupon_rejected`
  - `promotion.repriced`
- Promotions and uses can't be deleted (database trigger). Switching one off
  ends it for new checkouts and releases reserved uses before they pay.

## Web

- **Checkout** (`features/promotions/CheckoutPromotions.tsx`): an "Offers and
  coupons" panel before Rewards, with a coupon field, Apply, applied offers
  with Remove, a hold time, and an alert for the server's price-change
  notice. Changes are announced in a polite live region. `PriceBreakdown`
  replaces the old summary in the payment aside, showing original price,
  each offer, points, credit and the amount to pay.
- **Discovery** (`features/promotions/routes.tsx`): `/promotions` lists
  running offers with their discount, conditions, end date, code (with
  Copy) and terms. The homepage shows up to three, or nothing when none are
  running. There are no countdowns or urgency, and no "you're eligible"
  claims: eligibility is checked at checkout. The footer links "Offers and
  coupons".
- **Admin** (`features/admin/PromotionsAdmin.tsx`): see [Admin](#admin).

## Security

- The client sends a code, never an amount, discount, user id or status.
  The server prices everything, and payments must match `payableMinor`.
- Coupon writes are rate limited per customer (`COUPON_RATE_LIMIT_MAX` per
  15 minutes, default 20, Redis store `coupons`) to slow code guessing.
- Booking ownership is checked on every pricing route.
- Database CHECKs mirror the rules: discount shape, dates, limits, personal
  offers can't be listed, a use's discount is above 0 and below its eligible
  amount.

## Configuration

| Variable                | Default | Meaning                                                            |
| ----------------------- | ------- | ------------------------------------------------------------------ |
| `COUPON_RATE_LIMIT_MAX` | `20`    | Coupon apply/remove requests per signed-in customer per 15 minutes |

## Database

Migration `20261102000000_promotions` adds:

- the enums `promotion_kind`, `promotion_discount_type` and
  `promotion_redemption_status`;
- the tables `promotions` and `promotion_redemptions`, with their CHECKs,
  indexes and foreign keys (`ON DELETE RESTRICT`);
- the partial unique index `promotion_redemptions_one_open_per_kind`;
- the triggers `promotions_no_delete`, `promotion_redemptions_no_delete` and
  `promotion_redemptions_facts_immutable`.

It changes no existing table. Apply it with
`npm run db:migrate:deploy -w @wayora/database`.

### Rollback

This deletes all promotion data. Take a backup first, and only roll back
when no booking depends on a promotion.

```sql
BEGIN;
DROP TRIGGER IF EXISTS "promotion_redemptions_facts_immutable" ON "promotion_redemptions";
DROP TRIGGER IF EXISTS "promotion_redemptions_no_delete" ON "promotion_redemptions";
DROP TRIGGER IF EXISTS "promotions_no_delete" ON "promotions";
DROP FUNCTION IF EXISTS "promotion_redemptions_protect_facts"();
DROP FUNCTION IF EXISTS "promotions_prevent_delete"();
DROP TABLE IF EXISTS "promotion_redemptions";
DROP TABLE IF EXISTS "promotions";
DROP TYPE IF EXISTS "promotion_redemption_status";
DROP TYPE IF EXISTS "promotion_discount_type";
DROP TYPE IF EXISTS "promotion_kind";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261102000000_promotions';
COMMIT;
```

Then deploy the previous application version. Bookings paid with a discount
keep their recorded payment amounts.

## Tests

- `apps/api/test/promotions-engine.test.ts`: percentage and fixed maths,
  caps, the ₹1 minimum, eligibility order, safe messages, automatic ranking,
  code normalization, configuration validation.
- `apps/api/test/integration/promotions.test.ts` (real PostgreSQL):
  - reservation, server-side pricing, and redemption only after payment;
  - every rejection code;
  - the fixed-discount floor, and idempotent re-apply;
  - concurrent checkouts racing for the last use;
  - an expired hold freeing its use;
  - automatic selection, replacement, stacking, and re-apply on removal;
  - points after promotions, and released on repricing;
  - cancellation reversal, with the refund equal to what was paid;
  - revalidation before payment, with the amount mismatch and notice;
  - discovery visibility and personal offers;
  - admin RBAC, validation, audit, and usage without customer details;
  - database triggers.
- `apps/web/test/promotions.test.tsx`:
  - checkout apply, refusal, remove, breakdown and pay amount;
  - the price-change notice;
  - the offers page and its empty state, and the homepage section;
  - admin read-only views for support, deactivate with a reason, and create
    (basis points, minor units, India time), plus a duplicate-code error.

## Limitations

- **Demo only:** discounts apply to demo bookings; there is no live payment
  provider. The admin "discount given" figure is demo value, not revenue.
- **One currency per promotion;** no conversion.
- **Before payment, revalidation only catches a coupon that was switched off
  or has ended.** Other edits (a new minimum, categories, limits) apply to
  new checkouts; existing holds keep the terms they were reserved under
  until the payment window ends.
- **The first-booking check** looks at confirmed bookings in Wayora only.
- **No bulk or generated codes,** and no per-segment targeting beyond
  personal offers.
- **Rate limiting** slows code guessing but does not stop a distributed
  attempt.
- **No partial refunds** (the same as Phase 23): cancellation reverses the
  whole use.
