# Reviews, ratings and travel feedback (Phase 28)

Customers review the hotel stays and holiday packages they completed, and
share feedback about destinations. Wayora's team moderates every review
before it appears. Public pages show only published reviews, with a rating
summary worked out on the server from those reviews alone.

> **Everything is demo today.** Wayora has no live supplier
> ([providers.md](providers.md)), so every booking is a demo booking. Reviews
> written from a booking are labelled **Demo booking**, never "Verified".
> Nothing is seeded: no example reviews, ratings or counts exist until real
> customers write them.

## Contents

- [What can be reviewed](#what-can-be-reviewed)
- [Architecture](#architecture)
- [Data model](#data-model)
- [Eligibility](#eligibility)
- [Writing and editing](#writing-and-editing)
- [Ratings](#ratings) (how public scores are calculated)
- [Moderation](#moderation)
- [Reports](#reports)
- [Helpful votes](#helpful-votes)
- [Public visibility](#public-visibility)
- [Analytics](#analytics)
- [Notifications](#notifications)
- [Photos](#photos)
- [API](#api)
- [Web](#web)
- [Security](#security)
- [Configuration](#configuration)
- [Database](#database) and [rollback](#rollback)
- [Tests](#tests)
- [Limitations](#limitations)

## What can be reviewed

| Subject          | Key                           | Comes from                                                        | Verification                        | Category ratings                                         |
| ---------------- | ----------------------------- | ----------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------- |
| Hotel (property) | `demo-hotels:<property>`      | A completed booking of it                                         | `demo_booking` (`verified_booking`) | Cleanliness, location, service, comfort, value for money |
| Holiday package  | `demo-holidays:<package>`     | A completed booking of it                                         | `demo_booking` (`verified_booking`) | Experience, organisation, value for money                |
| Destination      | the discover slug, e.g. `goa` | Any signed-in customer, about one of the 12 discover destinations | `unverified`                        | None                                                     |

- **The subject comes from the booking.** For hotels and packages it is read
  from the booking's offer snapshot with `reviewSubjectOf`. The client only
  names its booking reference. The property or package part of an offer
  reference is known only for the demo providers (`<property>/…`,
  `<package>/…`). Offer references are otherwise opaque, so another
  provider's offers aren't reviewable until its adapter declares a stable
  property id.
- **Destinations** are validated against the planner catalogue
  (`PLANNER_CATALOG`), which uses the same twelve slugs as the discover pages.
- **Not reviewable:** flights, trains, buses, metro and cabs. Nothing reliably
  records the journey actually travelled (all are demo, with no ticket use or
  boarding data). Planner activities aren't bookable, so they can't be
  reviewed either.

## Architecture

| Piece                                             | Role                                                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/reviews.ts`               | Vocabulary, subjects, aspects, limits, moderation rules, input and response schemas                |
| `apps/api/src/modules/reviews/rules.ts`           | Pure rules: booking eligibility, rating maths, display names, the edit window                      |
| `apps/api/src/modules/reviews/reviews.service.ts` | Submission, editing, public lists, votes, reports, moderation, analytics                           |
| `apps/api/src/modules/reviews/reviews.routes.ts`  | `/reviews` (public reads; customer writes) and `/admin/reviews` (staff)                            |
| `apps/web/src/features/reviews`                   | Stars, summary, review cards, the public section, your reviews, writing and editing, booking panel |
| `apps/web/src/features/admin/ReviewsAdmin.tsx`    | Staff dashboard, queue and review workspace                                                        |

It reuses what exists: the `support` and `admin` roles with
`ROLE_PERMISSIONS`, `requirePermission` (denials audited), `audit_logs`,
`notify()` with its dedupe keys, the per-user rate limiters and the admin
dashboard UI kit.

## Data model

**`reviews`**: one row per review. Never deleted.

- **Facts that never change:** `user_id` (from the session), `subject_type`,
  `subject_key`, `booking_id`, `verification`, `travel_from`, `travel_to` and
  `created_at`.
- **Content:** `subject_name` (when written), `rating` (1–5), the aspect
  columns, `title`, `body` and `visited_month`.
- **State:** `status`, `moderation_note`, `published_at`, `edited_at` and
  `status_changed_at`.
- **Counters:** `version` (bumped by the author's edits) and `revision`
  (bumped by every edit and moderation decision; a stale change is refused).

Uniqueness:

- one review per booking (`reviews_booking_id_key`);
- one destination feedback per customer per destination
  (`reviews_one_feedback_per_subject`).

**`review_revisions`**: every version the author wrote. Append-only.

**`review_events`**: the history: submitted, edited, moderated and reports
dismissed, with the actor, from and to status, and reason. Append-only.

**`review_reports`**: one per customer per review. Its facts are immutable
and it is resolved once (`open` → `actioned` or `dismissed`).

**`review_votes`**: one helpful vote per customer per review (primary key).

Database CHECKs mirror the rules:

- rating and aspect ranges;
- aspects allowed for the subject type;
- a booking for hotels and packages, never for destinations;
- verification matches the booking link;
- text lengths;
- a published review has `published_at`.

Triggers block deletes, keep the facts immutable, enforce the status
transitions, make removal final, and send an edited review back to
`pending`.

## Eligibility

A booking review is allowed only when all of these hold (`bookingEligibility`):

1. The booking belongs to the signed-in customer. Anyone else's booking
   answers `404`, exactly like a missing one.
2. It is a hotel or holiday package, and its property or package has a
   reliable identity (see above).
3. Its status is `confirmed`, which for demo bookings means the demo payment
   succeeded. `pending`, `held`, `failed` and `expired` aren't eligible, and
   neither is `cancelled` ("Cancelled bookings can't be reviewed").
4. It has no refund rows. A refund exists only after cancellation, so a
   refunded booking can't be reviewed.
5. For a non-demo booking only, the supplier reservation is `confirmed`.
   None exist yet.
6. The stay or trip is over: today, in India, is at least the day after its
   end date (or the start date when it has no end date). Earlier, the state
   is `not_yet`, with the date it opens.
7. It has no review yet.

Verification:

- `demo_booking` for demo bookings;
- `verified_booking` only for a completed, supplier-confirmed real booking
  (none can exist today);
- `unverified` for destination feedback, which has no booking.

The client never sends verification, the subject, the author or a status:
strict schemas refuse unknown fields with `400`.

**After the review:** a booking review counts publicly only while its
booking is still `confirmed` (see [Ratings](#ratings)). Today a completed
stay can't be cancelled, so this is a safeguard rather than a common path.

Submission locks the booking row (`SELECT … FOR UPDATE`) and relies on the
unique index, so two submissions at once create one review (the other gets
`409`).

## Writing and editing

- **Content:**
  - overall rating, required, 1–5 whole stars;
  - category ratings, optional, 1–5, only the subject's own;
  - title, one line, 4–100 characters;
  - review, 30–3,000 characters;
  - for destinations, an optional visit month (not in the future, not before
    2000).
- **Text:** normalized (NFC, line endings) and trimmed. Control characters
  are refused. It is stored and rendered as plain text, never as HTML, and
  links aren't made clickable.
- **Moderation:** every new review starts `pending`.
- **Editing:**
  - The author may edit for **30 days** after writing it
    (`REVIEW_EDIT_DAYS`), while it is `pending`, `published` or `rejected`.
  - An edit creates a new version, keeps the old one in `review_revisions`,
    and sends the review back to `pending`, so a published review is hidden
    until it is moderated again.
  - Flagged and removed reviews can't be edited.
  - Edits carry the `revision` they were made on.
- **No deleting:** authors can't delete reviews. They can edit, or ask
  support.
- **Neutral by design:** the form asks for an honest rating ("low ratings are
  published like any other"). Nothing rewards a review: no points, credit or
  coupons are tied to reviewing.

## Ratings

The public rating of a subject is calculated on every read, in the database,
from **counted reviews**:

> A review is counted when its status is `published` **and** it has no
> booking, or its booking's status is still `confirmed`.

So pending, flagged, rejected and removed reviews never count, and an edited
review stops counting until it is published again. Every change shows up on
the next read; no stored average can go stale.

- **Count:** the number of counted reviews.
- **Distribution:** counted reviews per star (1–5). Always shown.
- **Average:** the sum of the overall ratings divided by the count, rounded
  half up to one decimal (in integer tenths), shown only from
  `MIN_REVIEWS_FOR_AVERAGE` = **3** counted reviews. Below that, the page
  shows the count, the distribution and each review, and says when an
  average will appear.
- **Category averages:** per aspect, the average of the counted reviews that
  rated it, from **3** ratings of that aspect.
- **Verification breakdown:** counted reviews by verification.
- **What contributes:**
  - Hotels and packages have only booking reviews: `demo_booking` today,
    `verified_booking` later. Both count, and the breakdown says which kind
    they are.
  - Destinations have only `unverified` feedback, and the section says so.
    Kinds are never mixed within one subject, so no unverified review can
    lift a hotel's score.
- The star filter changes the list, never the summary.

## Moderation

Statuses: `pending` → `published` | `rejected` | `flagged` | `removed`.

| Decision    | From                                  | To                | Reason         | Permission               | Author notified         |
| ----------- | ------------------------------------- | ----------------- | -------------- | ------------------------ | ----------------------- |
| Publish     | pending, flagged, rejected            | `published`       | optional       | `admin.reviews.moderate` | yes                     |
| Reject      | pending, flagged                      | `rejected`        | required (≥ 5) | `admin.reviews.moderate` | yes, with the reason    |
| Flag        | pending, published                    | `flagged`         | required       | `admin.reviews.moderate` | no (it's being checked) |
| Remove      | pending, published, rejected, flagged | `removed` (final) | required       | `admin.reviews.remove`   | yes, with the reason    |
| Author edit | pending, published, rejected          | `pending`         | —              | the author               | —                       |

- **Permissions:**
  - `admin.reviews.read`: support and admin;
  - `admin.reviews.moderate`: support and admin;
  - `admin.reviews.remove`: admin only.
  - Every route checks its permission on the server, and the service checks
    removal again.
- **Authorship is separate from moderation:** nobody moderates their own
  review (`403`, and the workspace offers no actions).
- **Stale or invalid changes:** a decision must name the review's current
  `revision`; a stale or replayed one is refused (`409`). Invalid transitions
  are refused (`409`), and the database trigger refuses them too.
- **History:** every decision is a `review_events` row (actor, from, to,
  reason, revision) and an audit row (`review.moderated`). History is never
  deleted.
- **Reasons:** for reject and remove, the author sees the reason on their
  reviews page and in the notification. A flag's reason stays with staff.
- **Guidance in the workspace:** decide on what the review says, not on
  whether the rating is low. Wayora never edits a review.

## Reports

- **Who:** any signed-in customer can report a published, counted review,
  except their own.
- **Reasons:** spam, not a genuine experience, offensive, personal
  information, harassment, not about this place, conflict of interest, and
  something else. "Something else" needs details of at least 10 characters;
  details are at most 500.
- **Limits:** one report per customer per review (unique index; a repeat
  answers `409`), and `REVIEW_REPORT_RATE_LIMIT_MAX` per hour per customer.
- **Privacy:** the reporter is never shown to anyone, staff included. Public
  pages only tell the reporter themselves that they reported it.
- **No automatic effects:** reports never hide, remove or re-rate a review.
  Staff decide.
- **Report queue:** staff see reviews with open reports (`?reported=true`,
  sortable by number of reports), with each report's reason, details and
  date.
  - A moderation decision closes the open reports: `dismissed` when
    publishing, `actioned` otherwise.
  - "Dismiss open reports" (with a reason) keeps the review as it is.

## Helpful votes

- **Rules:** signed-in customers mark a published review "Helpful" once
  (`PUT`) and can take it back (`DELETE`). Repeating is harmless: the primary
  key keeps one vote. They can't vote on their own reviews (`403`).
- **Counts:** the number of vote rows, counted on each read. The client
  never sends a count.
- **Sorting:** "Most helpful" orders by that count, then by date.
- **Limits:** `REVIEW_VOTE_RATE_LIMIT_MAX` per minute per customer.

## Public visibility

- **Where:** the public list shows counted reviews only.
- **What's shown:**
  - the author as first name and last initial ("Asha R."), or "Wayora
    traveller";
  - the verification label;
  - stay dates or the visit month;
  - the published date, whether it was edited, category ratings and helpful
    votes.
- **Never shown:** account ids, emails, booking references or reporter
  identities.
- **Paging and filters:** server-side (`page`, `pageSize` ≤ 50, `sort`, `rating`).
- **Per-viewer fields:** signed-in viewers get `viewer.own`,
  `viewer.votedHelpful` and `viewer.reported` for their own view only.

## Analytics

`GET /admin/reviews/metrics?range=7d|30d|90d`, from stored records only:

| Metric                     | Definition                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------ |
| By status                  | Current count per status, all time                                                   |
| Published, by verification | Counted reviews per verification                                                     |
| Distribution               | Counted reviews per star                                                             |
| Waiting for moderation     | `pending` reviews; the oldest by time in that status; how many have waited over 48 h |
| Open reports               | Open report rows, and how many reviews have at least one                             |
| Written per day            | Reviews created per India date in the range                                          |
| Moderation workload        | Moderation decisions in the range per moderator, and how many published              |

`GET /admin/reviews/subjects` lists per subject:

- counted reviews and their average (shown only from 3, as in public);
- pending and flagged counts.

It is paged in SQL. Every query is bounded by a range, a page, or an
indexed group.

## Notifications

In-app, type `review` (category `reviews`), for the author when their review
is published, not published, or removed. The link goes to "Your reviews". The
dedupe key is `review:<id>:<revision>`, so a replay can't notify twice.
Flags and edits don't notify. There's no email: no email provider exists
([notifications.md](notifications.md#delivery)).

## Photos

**Not supported.** Wayora has no secure file storage: no upload handling,
private object store, content sniffing or scanning (the same finding as
Phase 27, [support.md](support.md#attachments)). Reviews are text-only, and
the form offers no upload.

Adding photos needs private storage with signed, short-lived access,
content-type sniffing (not extensions), size and format limits, image
re-encoding and thumbnails, and moderator removal of individual images.

## API

Customers and the public (`/api/v1/reviews`):

| Method       | Path                                                | Who                     | Notes                                                     |
| ------------ | --------------------------------------------------- | ----------------------- | --------------------------------------------------------- |
| GET          | `/reviews?type=&key=&sort=&rating=&page=&pageSize=` | anyone                  | Counted reviews and the summary                           |
| GET          | `/reviews/mine?page=`                               | signed in               | Your reviews, any status, with moderation notes           |
| GET          | `/reviews/mine/:id`                                 | signed in               | One of yours                                              |
| GET          | `/reviews/bookings`                                 | signed in               | Your confirmed hotel and package bookings and their state |
| GET          | `/reviews/bookings/:reference`                      | owner                   | One booking's state                                       |
| GET          | `/reviews/destinations/:slug`                       | signed in               | Your feedback about it, if any                            |
| POST         | `/reviews`                                          | signed in, rate limited | `createReviewSchema` (strict); 201                        |
| PATCH        | `/reviews/:id`                                      | author, rate limited    | `updateReviewSchema` with `revision`                      |
| PUT / DELETE | `/reviews/:id/helpful`                              | signed in, rate limited | One vote                                                  |
| POST         | `/reviews/:id/reports`                              | signed in, rate limited | `reportReviewSchema`; 201                                 |

Staff (`/api/v1/admin/reviews`):

| Method | Path                                                             | Permission                                                    |
| ------ | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| GET    | `/metrics?range=`                                                | `admin.reviews.read`                                          |
| GET    | `/subjects?type=&page=`                                          | `admin.reviews.read`                                          |
| GET    | `/?status=&type=&verification=&reported=&rating=&q=&sort=&page=` | `admin.reviews.read`                                          |
| GET    | `/:id`                                                           | `admin.reviews.read`                                          |
| POST   | `/:id/moderate`                                                  | `admin.reviews.moderate` (+ `admin.reviews.remove` to remove) |
| POST   | `/:id/reports/dismiss`                                           | `admin.reviews.moderate`                                      |

Errors use the standard envelope:

- `400 VALIDATION_FAILED`
- `401 UNAUTHENTICATED`
- `403 FORBIDDEN` (own review, removal without permission)
- `404 NOT_FOUND`
- `409 CONFLICT` (duplicate review or report, stale revision, transition not
  allowed, edit window closed)
- `422 REVIEW_NOT_ELIGIBLE` (with the reason)
- `429 RATE_LIMITED`

## Web

- **Public:**
  - "Guest reviews" or "Traveller reviews" on hotel and package offer pages,
    when the offer's provider has a stable property id;
  - "Traveller feedback on …" on destination pages, with "Share your
    feedback";
  - each has the summary (average via the existing `RatingBadge` once there
    are 3), distribution, category averages, sort and star filter, paging,
    cards with verification labels, and helpful and report actions for
    signed-in readers.
- **Customers:**
  - **Reviews** in the account menu and side navigation;
  - `/reviews`: bookings ready to review (and when others will be), and your
    reviews with status, moderation notes and an edit link while editable;
  - `/reviews/write?booking=` and `/reviews/write?destination=`: the form,
    with a preview;
  - `/reviews/:id/edit`;
  - "Your review" on hotel and package booking pages.
- **Staff:**
  - **Reviews** in the admin navigation (`admin.reviews.read`);
  - `/admin/reviews`: metrics with definitions and the per-place table;
  - `/admin/reviews/queue`: filters and paging;
  - `/admin/reviews/:id`: content, reports, versions, history, details and
    the decision form showing only the actions the server allows.
- **Accessibility:**
  - star input is a radio group with labelled stars ("4 stars: Good"), and
    no star is preselected;
  - star displays are announced as "4 out of 5 stars";
  - the distribution is a definition list;
  - result counts are announced in a live region.
- **Motion:** review cards fade in with `motion` (off under reduced motion).

## Security

- Server-side checks on every mutation: the author owns the review; the
  booking belongs to the customer and is eligible; ratings are in range;
  moderation permissions; nobody moderates their own review.
- Strict schemas: no client-supplied verification, status, author, subject,
  aggregate or vote count.
- Plain text only; React escapes it, and nothing renders user HTML or links.
- Rate limits on writes, reports and votes.
- Audit: `review.submitted`, `review.edited`, `review.reported`,
  `review.moderated`, `review.reports_dismissed` and
  `admin.access_denied`. Metadata holds no review text.
- Reporter identities stay private; public responses hold no ids, emails or
  booking references.

## Configuration

| Variable                       | Default | Meaning                                         |
| ------------------------------ | ------- | ----------------------------------------------- |
| `REVIEW_RATE_LIMIT_MAX`        | `10`    | Reviews written or edited per customer per hour |
| `REVIEW_REPORT_RATE_LIMIT_MAX` | `10`    | Review reports per customer per hour            |
| `REVIEW_VOTE_RATE_LIMIT_MAX`   | `30`    | Helpful votes (and taking them back) per minute |

Photo storage: none (see [Photos](#photos)).

## Database

Migration `20261107000000_reviews` adds:

- the notification type `REVIEW`;
- the enums `review_subject_type`, `review_status`, `review_verification`,
  `review_event_kind`, `review_actor_kind`, `review_report_reason` and
  `review_report_status`;
- the tables `reviews`, `review_revisions`, `review_events`, `review_reports`
  and `review_votes`, with CHECKs, indexes and foreign keys (`RESTRICT`);
- triggers: no deletes, append-only revisions and history, the review guard
  and the report guard.

Existing data is not changed.

### Rollback

This deletes all review data, so take a backup first. The `REVIEW` value
added to `notification_type` can't be dropped in PostgreSQL; it stays unused.

```sql
BEGIN;
DELETE FROM "notifications" WHERE "type" = 'REVIEW';
DROP TRIGGER IF EXISTS "review_reports_guard" ON "review_reports";
DROP TRIGGER IF EXISTS "reviews_guard" ON "reviews";
DROP TRIGGER IF EXISTS "review_events_append_only" ON "review_events";
DROP TRIGGER IF EXISTS "review_revisions_append_only" ON "review_revisions";
DROP TRIGGER IF EXISTS "review_reports_no_delete" ON "review_reports";
DROP TRIGGER IF EXISTS "reviews_no_delete" ON "reviews";
DROP TABLE IF EXISTS "review_votes";
DROP TABLE IF EXISTS "review_reports";
DROP TABLE IF EXISTS "review_events";
DROP TABLE IF EXISTS "review_revisions";
DROP TABLE IF EXISTS "reviews";
DROP FUNCTION IF EXISTS "review_reports_guard"();
DROP FUNCTION IF EXISTS "reviews_guard"();
DROP FUNCTION IF EXISTS "reviews_append_only"();
DROP FUNCTION IF EXISTS "reviews_prevent_delete"();
DROP TYPE IF EXISTS "review_report_status";
DROP TYPE IF EXISTS "review_report_reason";
DROP TYPE IF EXISTS "review_actor_kind";
DROP TYPE IF EXISTS "review_event_kind";
DROP TYPE IF EXISTS "review_verification";
DROP TYPE IF EXISTS "review_status";
DROP TYPE IF EXISTS "review_subject_type";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261107000000_reviews';
COMMIT;
```

## Tests

- **`apps/api/test/reviews-rules.test.ts`:**
  - the eligibility matrix (India dates, demo vs verified, every booking
    status, refunds, undated bookings, categories, unknown providers);
  - subjects;
  - rating maths and the minimums;
  - names and the edit window;
  - moderation rules;
  - input validation.
- **`apps/api/test/integration/reviews.test.ts`** (real PostgreSQL):
  - submission, ownership and eligibility, including demo labelling and a
    refused client-sent verification, subject, status or user;
  - concurrent duplicates;
  - rating validation;
  - destination feedback;
  - editing (versions, stale revision, window, ownership);
  - aggregates (minimum, exclusions, recalculation after removal);
  - privacy of public responses;
  - sorting, filtering and paging;
  - helpful votes (one per customer, own, unpublished, client counts, rate
    limit);
  - reports (duplicates, own, private, no auto-removal, dismissal, rate
    limit);
  - moderation RBAC (customer, support, admin, own review, transitions,
    stale), with audit;
  - notifications and de-duplication;
  - the queue's filters and paging;
  - analytics;
  - database guards;
  - a hotel review's public view.
- **`apps/web/test/reviews.test.tsx`:**
  - the public section (summary, labels, distribution, sort, filter, paging,
    signed-out prompts), the minimum and empty states;
  - helpful and report for signed-in readers;
  - writing (validation, star input, preview, what is sent), eligibility
    messages, server field errors;
  - your reviews and editing (revision sent);
  - the booking panel;
  - moderation for support staff (no remove, reason needed), own review,
    dashboard and queue, and customers refused.

## Limitations

- **Verification:** with no live supplier, no review can be
  `verified_booking`; booking reviews are demo-booking reviews.
- **Subjects:** only the demo hotel and holiday providers have stable
  property or package ids. Flights, trains, buses, metro, cabs and planner
  activities can't be reviewed.
- **Photos:** not supported (no secure file storage).
- **Authors:** can't delete or withdraw a review; they can edit it for 30
  days, or contact support.
- **Moderation:** manual only; no automated spam or language screening.
  Reports never act on their own.
- **Email:** none; notifications are in-app only.
- **Language:** no translation or per-language reviews.
- **Supplier responses:** owners or suppliers can't reply to reviews.
- **Average shown:** a plain mean of counted reviews, with no weighting by
  recency or verification. Sample size is handled by the 3-review minimum
  and by showing the distribution.
