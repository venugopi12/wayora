# Loyalty, rewards and travel credit (Phase 25)

> **Demo rewards.** Every booking and payment on Wayora today is a demo, so
> every point and every travel credit is a **demo reward**: no cash value,
> earned only from demo bookings paid with the demo payment simulator, and
> usable only on demo bookings. Travel credit is never a cash refund, and a
> refund is never turned into credit. Live rewards exist in the code but stay
> off (`LOYALTY_LIVE_REWARDS_ENABLED=false`) and can't happen without a real,
> live payment provider, which Wayora doesn't have.

## Contents

- [Architecture](#architecture)
- [Ledger](#ledger)
- [Rules](#rules): [earning](#earning), [redemption](#redemption), [tiers](#tiers), [expiry](#expiry)
- [Travel credits](#travel-credits)
- [Booking and payment](#booking-and-payment)
- [Checkout](#checkout)
- [Demo and live](#demo-and-live)
- [API](#api)
- [Admin](#admin)
- [Notifications](#notifications)
- [Maintenance](#maintenance)
- [Security and integrity](#security-and-integrity)
- [Database](#database) and [rollback](#rollback)
- [Web](#web)
- [Tests](#tests)
- [Limitations](#limitations)

## Architecture

```text
booking / payment change commits ──► PaymentsService.settled(bookingId) ─┐
maintenance sweep (every minute) ─────────────────────────────────────────┼─► RewardsService.reconcileBooking
GET /rewards, GET /bookings/:ref/rewards (on read) ───────────────────────┘        (idempotent)
                                                                                      │
                     ledger.ts (lockAccount → ledger row + cached balance + lots/credits)
```

- `apps/api/src/modules/rewards/rules.ts`: pure calculations (earning, tiers,
  redemption limits), BigInt only, no clock or database.
- `ledger.ts`: the only code that changes balances, lots and credits.
- `rewards.service.ts`: customer views, checkout, settling bookings, the
  sweep, admin operations.
- `rewards.routes.ts`: `/rewards`, `/bookings/:reference/rewards`, `/admin/rewards/*`.
- Contracts: `packages/contracts/src/rewards.ts` (rules schema, API shapes,
  `DEFAULT_LOYALTY_RULES`).

**States stay separate.** Rewards read bookings and payments but never change
them: the supplier reservation, booking status, payment status and rewards
each keep their own records. Rewards are settled **after** a booking or payment
change has committed, outside its transaction, so a rewards failure can never
undo a payment, cancel a booking or touch a confirmed supplier booking. A
failed settlement is logged and retried by the sweep.

## Ledger

Every change to a points balance or a credit is one row in
`reward_transactions` (append-only: a trigger blocks `UPDATE` and `DELETE`).

| Type              | Sign | Written when                                                                |
| ----------------- | ---- | --------------------------------------------------------------------------- |
| `POINTS_EARNED`   | ≥ 0  | A paid, confirmed booking's trip has ended (once per booking)               |
| `POINTS_REDEEMED` | < 0  | Points applied at checkout                                                  |
| `POINTS_RESTORED` | > 0  | Applied points given back (removed, booking expired/failed/cancelled)       |
| `POINTS_REVERSED` | ≤ 0  | Earned points taken back: the booking stopped qualifying (once per booking) |
| `POINTS_EXPIRED`  | < 0  | A lot reached its expiry                                                    |
| `POINTS_ADJUSTED` | ≠ 0  | An admin's manual adjustment (reason required)                              |
| `CREDIT_ISSUED`   | > 0  | An admin issued a credit (reason required)                                  |
| `CREDIT_REDEEMED` | < 0  | Credit applied at checkout                                                  |
| `CREDIT_RESTORED` | > 0  | Applied credit given back                                                   |
| `CREDIT_EXPIRED`  | < 0  | A credit reached its expiry                                                 |
| `CREDIT_REVOKED`  | ≤ 0  | An admin withdrew a credit (reason required)                                |

Each row has `origin` (`AUTOMATED` or `MANUAL`; manual rows must carry a
`reason` and the admin's id — a CHECK enforces it), the actor, the
`rule_version` used, the booking/redemption/credit it concerns,
`balance_after` for points rows, an `idempotency_key` (unique) and, for
earning, the full calculation in `metadata`.

**Balances.** `loyalty_accounts.points_balance` (one row per user and mode)
is a cache of the ledger, updated in the same transaction as each points row,
with `CHECK (points_balance >= 0)`. Invariant (tested): balance = Σ ledger
points = Σ remaining in unexpired-and-unswept lots.

**Concurrency.** Every balance change for a user and mode runs under that
account's row lock (`SELECT … FOR UPDATE`, created on first use). Checkout
also locks the booking first (lock order is always booking → account), so two
checkouts can't spend the same points or credit; one waits, re-reads and is
refused if there's no longer enough. A partial unique index allows at most
one open redemption per booking, and others allow one `POINTS_EARNED` and one
`POINTS_REVERSED` per booking.

## Rules

Rules are versioned rows in `loyalty_rule_versions` (append-only), validated
with `loyaltyRulesSchema`. The version in force at a moment is the newest one
whose `effective_from` has passed. Version 1 is shipped by the migration and
equals `DEFAULT_LOYALTY_RULES`. Each transaction and redemption stores the
version it used. Money is integer minor units (strings); multipliers are
basis points (10000 = ×1); every division rounds down. No floating point.

Version 1:

| Setting                | Value                                                                     |
| ---------------------- | ------------------------------------------------------------------------- |
| Spend per base point   | ₹10 (`INR: "1000"` paise); other currencies don't earn                    |
| Category multipliers   | ×1 for all seven categories                                               |
| Campaigns              | none                                                                      |
| Points available       | 1 day after the trip ends                                                 |
| Points expire          | 24 months after they're added                                             |
| Point value            | ₹0.25 (`INR: "25"`)                                                       |
| Redemption             | 200 – 20,000 points, at most 50% of the booking total                     |
| Always left to pay     | ₹1 (`INR: "100"`)                                                         |
| Redemption categories  | flights, hotels, trains, buses, holidays                                  |
| Tiers (qualifying pts) | Explorer 0 ×1 · Silver 2,000 ×1.25 · Gold 6,000 ×1.5 · Platinum 15,000 ×2 |
| Qualification window   | 12 months (rolling)                                                       |

### Earning

```text
paid       = sum of the booking's SUCCEEDED, not-refund-required payment amounts
base       = floor(paid / spendMinorPerPoint[currency])
qualifying = floor(base × categoryBps / 10000)
points     = floor(qualifying × tierBps × (10000 + Σ campaign bonusBps) / 10000²)
```

- **What qualifies:** only money actually paid. Points and credit used on the
  booking reduce the payment, so they don't earn. Demo offers don't itemise
  taxes or fees, so the whole paid total counts; there are no discounts other
  than rewards.
- **When:** the booking is `CONFIRMED`, has a successful payment that isn't
  owed back, and its trip has ended: `endsOn`, else `startsOn`, else the
  confirmation day, plus `availableAfterDays`. Bookings that are cancelled,
  expired, failed, unpaid, or paid after they closed never earn.
- **Which rules:** the version in force when the booking was **confirmed**
  (campaigns are matched on the confirmation time too); the tier is the
  account's tier when the points are added.
- **Once:** the idempotency key `earn:<bookingId>` and a partial unique index.
  A booking that earns 0 points (e.g. below ₹10) still gets a 0-point row with
  the reason, so it isn't reconsidered.
- **Explained:** `metadata` holds paid amount, currency, spend per point,
  base points, category, tier and campaign multipliers, and any note.

Confirmed bookings whose trip hasn't ended appear on the dashboard under
**On the way** as estimates (same formula, not in the ledger).

### Redemption

For a booking with total `T` in currency `c`, value `v = pointValueMinor[c]`
and minimum cash `m = minCashMinor[c]`:

```text
maxPoints  = min(balance, maxPointsPerBooking,
                 floor(T × coverageBps / 10000 / v),
                 floor((T − m) / v))           — 0 if below minPoints
maxCredit(p) = min(active credit in c, T − m − p × v)
```

- Points are worth `points × v` (exact integer minor units).
- At least `m` is always left to pay: the payment flow confirms the booking,
  and zero-amount payments aren't supported.
- Only categories in `redeem.categories`; only currencies with a point value;
  credit only in the booking's currency.
- The server recomputes all of this on every request; a client-sent amount
  is never trusted (the request carries only points and a credit amount).

### Tiers

- **Qualifying points:** Σ `qualifying_points` over the account's ledger rows
  in the last `qualificationMonths` (earned base points, minus reversed ones).
  Tier and campaign bonuses don't count. Manual adjustments don't count.
- **Upgrade:** as soon as qualifying points reach a higher tier's minimum.
- **Renewal:** while still qualifying, the tier's hold is renewed.
- **Downgrade:** a tier is kept for `qualificationMonths` after it was last
  reached or renewed; after that it drops to the tier the current qualifying
  points reach (possibly several steps). Reviewed on every earning or
  reversal and by the sweep.
- **Benefits:** only the earning multiplier. Wayora promises no lounges,
  priority support or other perks, because it can't deliver them.
- Deterministic: `evaluateTier(rules, state, qualifyingPoints, now)`.

### Expiry

- **Points:** each earning or positive adjustment creates a lot that expires
  `expiryMonths` after it was added. Spending, reversals and negative
  adjustments take from the soonest-expiring lot first. Expired lots are
  expired (a `POINTS_EXPIRED` row per lot) by the sweep and before any spend,
  and checkout never counts a lot past its expiry, even before the sweep.
- **Credits:** optional expiry date (end of that UTC day). Expired by the
  sweep and before any spend.
- **Given back after expiry:** points and credit given back to a lot or
  credit that has already expired come back and expire again at once.
- **Notices:** one in-app notification per lot or credit 30 days before it expires.

## Travel credits

A credit is separate from points: `travel_credits` holds its reference
(`WYC-XXXX-XXXX`), reason (`PROMOTION`, `SUPPORT_COMPENSATION`,
`BOOKING_ADJUSTMENT`), customer note, original and remaining amount,
currency, issue and expiry dates, status (`ACTIVE`, `USED`, `EXPIRED`,
`REVOKED`), related booking or campaign, and the admin who issued it. Its
usage history is the ledger rows that point at it.

- **Issued only by admins** (`admin.rewards.manage`) with a reason and a
  justification, audited, once per idempotency key.
- **Never from a refund.** There is no refund reason, and no code path turns
  a refund into credit. Cash refunds stay in `refunds` (docs/payments.md#refunds).
- **Currency:** a credit only pays for bookings in its own currency; a credit
  for a booking must be in that booking's currency.
- **Partial use** is allowed; several credits are used soonest-expiry first.
- **Revocation** (admin, with a reason) withdraws what's left; a revoked
  credit isn't restored if a booking it paid for is later cancelled.
- A trigger keeps the issue facts (user, amount, currency, reason, issuer,
  key) immutable and blocks deletion.

## Booking and payment

`reconcileBooking(bookingId)` is idempotent and runs after commits, on reads
and from the sweep:

| Situation                                                                   | Rewards effect                           |
| --------------------------------------------------------------------------- | ---------------------------------------- |
| Rewards applied, booking still payable                                      | kept (status `APPLIED`)                  |
| Rewards applied, payment succeeded, booking confirmed                       | `CONSUMED`, "rewards used" notification  |
| Rewards applied, booking expired/failed/cancelled unpaid                    | `RELEASED`: points and credit given back |
| Rewards used on a paid booking that is cancelled                            | `RESTORED`: points and credit given back |
| Paid booking confirmed and trip ended                                       | points earned once                       |
| Earned, then the booking is no longer confirmed or its payment is owed back | points taken back once, never below zero |

- **Restoring:** cancellation of a demo booking refunds its paid part in full
  (Phase 23), so rewards used on it are restored in full; there are no
  partial refunds. Points and credit go back to the lots and credits they came
  from, keeping their original expiry.
- **Reversal:** takes back first from the booking's own lot, then the
  soonest-expiring others, never more than the balance. What couldn't be taken
  back (already spent) is recorded in the row's `metadata.unrecovered`.
- **Delayed payment confirmations:** nothing depends on timing. A payment that
  succeeds later is settled when its event is applied (the payment's
  `afterApplied` hook) or by the sweep; one that succeeds after its booking
  closed never earns, and its applied rewards are restored.
- **Payment amount:** `POST /bookings/:reference/payments` must send the
  booking's total **minus** applied rewards (`RewardsService.payableMinor`,
  read under the booking lock), and the payment is recorded for that amount.
  The booking's `payment.amount` shows it; `payment.rewards` shows what was
  applied. The offer price and `totalAmountMinor` never change.
- Rewards can't change while a payment is in progress or after the booking is
  paid.

## Checkout

`/trips/:reference/pay` has a **Rewards** panel:

1. `GET /bookings/:reference/rewards` returns the balance, minimum and
   maximum points, point value, available and maximum credit, what's applied,
   and what's left to pay, all calculated by the server.
2. The customer types points and/or a credit amount (a preview shows the
   points' value from the server's point value) and must tick a confirmation
   box before applying.
3. `PUT /bookings/:reference/rewards` with `{ points, creditAmountMinor, confirm: true }`.
   The server validates everything again, gives back anything applied before,
   applies the new choice and returns the new quote. The same request twice
   changes nothing.
4. The pay button and summary show the remaining amount from the server.
   **Remove** (`DELETE`) gives the rewards back.

Errors (below minimum, above maximum, not enough points or credit, payment in
progress, booking not payable) are shown in the server's words; the payment
can always go ahead without rewards, even if rewards fail to load.

## Demo and live

| Mode   | Earned from                                              | Spent on           | Status                                                                               |
| ------ | -------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------ |
| `DEMO` | demo bookings, or any booking paid by the demo simulator | demo bookings only | on                                                                                   |
| `LIVE` | non-demo bookings paid through a LIVE payment provider   | live bookings only | off: needs `LOYALTY_LIVE_REWARDS_ENABLED=true` **and** a live provider (none exists) |

The two modes are separate accounts and separate credit; nothing converts
between them. Demo notifications, the dashboard and checkout all say "demo".
With live rewards off, `/rewards` shows only the demo account and admins
can't adjust or issue in live mode (`409`).

## API

| Method and path                                     | Who                    | What                                                                                                      |
| --------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET /rewards`                                      | signed in              | accounts (balance, tier, pending, expiring, credits, monthly) and public rules                            |
| `GET /rewards/transactions?mode&kind&page&pageSize` | signed in              | own ledger, newest first                                                                                  |
| `GET /bookings/:reference/rewards`                  | owner                  | checkout quote                                                                                            |
| `PUT /bookings/:reference/rewards`                  | owner                  | apply `{ points, creditAmountMinor, confirm: true }`                                                      |
| `DELETE /bookings/:reference/rewards`               | owner                  | give applied rewards back                                                                                 |
| `GET /admin/rewards/transactions`                   | `admin.rewards.read`   | ledger with `userId`, `type`, `origin`, `mode` filters                                                    |
| `GET /admin/rewards/users/:userId`                  | `admin.rewards.read`   | balances, ledger sum, tier, credits, recent rows (no contact details); audited view                       |
| `GET /admin/rewards/rules`                          | `admin.rewards.read`   | active version and history                                                                                |
| `POST /admin/rewards/users/:userId/adjustments`     | `admin.rewards.manage` | `{ mode, points, reason, idempotencyKey }`                                                                |
| `POST /admin/rewards/users/:userId/credits`         | `admin.rewards.manage` | `{ mode, amount, reason, note, justification, expiresOn?, bookingReference?, campaign?, idempotencyKey }` |
| `POST /admin/rewards/credits/:reference/revoke`     | `admin.rewards.manage` | `{ reason }`                                                                                              |
| `POST /admin/rewards/rules`                         | `admin.rewards.manage` | `{ config, reason }`: a new version in force now                                                          |

Bodies are strict (unknown fields → `400`); bookings of other users answer
`404`; there is no customer endpoint that sets a balance. Rewards writes share
the per-user limit `PAYMENT_RATE_LIMIT_MAX`.

## Admin

- `admin.rewards.read`: support and admins. `admin.rewards.manage`: admins only.
- **Adjustments** need a reason (≥ 10 characters), can't take the balance
  below zero, are recorded as `MANUAL` ledger rows with the admin and reason,
  and in the audit log (`rewards.points_adjusted`). One per idempotency key.
- **Credits:** `rewards.credit_issued` / `rewards.credit_revoked` audit entries.
- **Rules:** a new version (`rewards.rules_created`); old versions stay for history.
- Tier changes are audited as `rewards.tier_upgrade` / `rewards.tier_downgrade`;
  checkout actions as `rewards.redemption.applied` / `rewards.redemption.removed`.
- Web: **Admin → Rewards** (ledger with filters), **Rules and versions**
  (summary, history, and a validated JSON editor for admins), and a customer's
  rewards page (linked from the user page) with the adjustment and credit
  forms for admins only. The API enforces permissions regardless.

## Notifications

One notification type, `REWARDS` (`rewards` in the API), **in-app only**: no
email is queued, so no email is ever claimed. Events and dedupe keys:

| Event                    | Dedupe key                                    |
| ------------------------ | --------------------------------------------- |
| Points earned (> 0)      | `rewards:earned:<bookingId>`                  |
| Rewards used (consumed)  | `rewards:redeemed:<redemptionId>`             |
| Rewards given back       | `rewards:restored:<redemptionId>`             |
| Points taken back        | `rewards:reversed:<bookingId>`                |
| Credit issued            | `rewards:credit-issued:<creditId>`            |
| Points added by support  | `rewards:adjusted:<idempotencyKey>`           |
| Points / credit expiring | `rewards:expiring:lot:<id>` / `…:credit:<id>` |
| Tier reached             | `rewards:tier:<accountId>:<tier>:<day>`       |

Demo notifications carry `isDemo` and say demo rewards have no cash value.

## Maintenance

`server.ts` runs `RewardsService.sweep()` every minute (idempotent, row-locked,
safe on every instance): settles bookings with applied redemptions that need
action, paid bookings whose trip has ended, and earned bookings that stopped
qualifying; expires points and credit; creates expiry notices; and reviews
tiers whose hold has run out. Reads (`GET /rewards`, checkout) settle the
user's own bookings too.

## Security and integrity

- Ownership: every customer route scopes by the session's user; other users'
  bookings are `404`.
- No client value decides a reward: requests carry a points count, a credit
  amount and a confirmation; the server derives every amount.
- Concurrency: account and booking row locks; partial unique indexes;
  idempotency keys on every automated step and admin write.
- Database guards: non-negative balance, lot and credit amount CHECKs, sign
  checks per transaction type, manual rows need a reason, append-only ledger
  and rule versions, immutable credit facts.
- Logs and audit metadata hold ids, amounts and reasons — no traveller
  details, emails or payment data.

## Database

Migration `20261101000000_loyalty_rewards` (additive): enums
`reward_transaction_type`, `reward_origin`, `travel_credit_status`,
`travel_credit_reason`, `reward_redemption_status`; notification type
`REWARDS`; tables `loyalty_accounts`, `loyalty_rule_versions` (with version 1),
`reward_transactions`, `loyalty_point_lots`, `travel_credits`,
`reward_redemptions`; partial unique indexes
`reward_redemptions_one_open_per_booking`,
`reward_transactions_one_earn_per_booking`,
`reward_transactions_one_reversal_per_booking`; triggers keeping the ledger and
rule versions append-only and credit facts immutable. No existing row changes.

### Rollback

Only before any rewards data matters (it deletes it). The `REWARDS`
notification value stays (Postgres can't drop an enum value; it is unused
without the code).

```sql
BEGIN;
DROP TABLE "loyalty_point_lots", "reward_transactions", "reward_redemptions",
  "travel_credits", "loyalty_accounts", "loyalty_rule_versions" CASCADE;
DROP FUNCTION IF EXISTS "reward_transactions_prevent_mutation"(),
  "loyalty_rule_versions_prevent_mutation"(), "travel_credits_protect_facts"();
DROP TYPE "reward_transaction_type", "reward_origin", "travel_credit_status",
  "travel_credit_reason", "reward_redemption_status";
COMMIT;
```

## Web

- `/rewards` (account area, **Rewards** in the side navigation): demo notice;
  balance and its value; tier with an accessible progress bar to the next
  tier and when the tier is kept until; travel credit total; **On the way**
  (estimates) and **Expiring soon**; credit list; points by month (a table of
  months with activity — no decorative chart); paginated, filterable history;
  **How rewards work** from the server's rules. Loading, empty and error
  states with retry.
- Checkout: the Rewards panel on `/trips/:reference/pay` ([Checkout](#checkout)).
- Admin: [Admin](#admin).

## Tests

```bash
npm run test --workspace @wayora/api   # rules (unit) + rewards integration (TEST_DATABASE_URL)
npm run test --workspace @wayora/web   # dashboard, checkout, admin views
```

- `apps/api/test/rewards-rules.test.ts`: earning (rounding, tier, category,
  currency, campaigns in and out of window), tiers (upgrade, renewal, hold,
  one- and multi-step downgrade, determinism), redemption limits (balance,
  per-booking max, coverage, minimum, minimum cash, credit with points,
  categories, currencies), rules validation (no float money), dates.
- `apps/api/test/integration/rewards.test.ts` (real PostgreSQL): earning once
  after travel on the paid amount under concurrent settling; nothing for
  unpaid, expired or cancelled bookings; checkout min/max, strict bodies,
  confirmation, idempotent re-apply, payment amount mismatch and the reduced
  payment, earning on cash only; giving back on removal, expiry and
  cancellation; two concurrent checkouts; no change during a payment; credit
  issue once per key, partial use, currency, restore, expiry, revoke; reversal
  never below zero; points expiry, notice and no spending of expired points;
  tier upgrade under a new rule version and downgrade after the hold;
  privacy and access control; support vs admin, reasons, idempotency, audit,
  live mode refused, invalid rules refused; append-only ledger and
  non-negative balance enforced by the database. Every test checks the
  balance = ledger = lots invariant.
- `apps/web/test/rewards.test.tsx`: dashboard figures, progress bar, credit,
  months, history paging and filter, rules; navigation and error recovery;
  checkout confirmation, request body, server-calculated amount to pay and
  payment, server refusals, local validation, maximum, remove; no rewards and
  failed loading; money input without floats; admin read-only for support,
  adjustment with reason and key, ledger list.

## Limitations

- All rewards are demo rewards; live rewards are implemented but switched
  off and untested against a live payment provider (none exists).
- Points aren't earned until the trip ends, so a new demo user sees only
  estimates for a while (admins can add demo points for testing).
- No points-to-credit conversion, gift cards, partner rewards, or tier perks
  beyond the earning rate.
- One currency in the default rules (INR); other currencies neither earn nor
  redeem until a rule version adds them.
- Manual adjustments are approved by the admin who makes them (no second
  approver).
- Rewards notifications are in-app only.
- Redemption amounts aren't itemised on the payment record itself (the
  payment is for the remainder; the redemption row and ledger hold the rest).
