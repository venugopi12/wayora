# Travel assistant

Phase 21 adds a travel assistant (`/assistant`). Signed-in users can ask in plain
language for:

- destination ideas
- a day-by-day itinerary
- activities for their group
- a budget split, or ideas to cut costs
- a packing list
- a calmer version of a plan they've made

It works with the user's real plans. It reads a plan only after checking the
user's access. Its suggestions go into the planner and budget only when the user
reviews and confirms them.

What it is, honestly:

- **Its answers are suggestions, never facts.** It has no live travel data:
  no prices, availability, opening hours, schedules, travel times or weather.
  Itinerary durations are planning estimates. Budget amounts are rough
  estimates labelled as such.
- **It changes nothing by itself.** Every change is a separate, confirmed user
  action, authorized like any other edit (see [Applying](#applying)). It never
  books, pays, refunds, settles or touches a provider reservation.
- **It says where an answer came from.** Each reply carries its source: "AI"
  for a language model, or "Demo · rule-based, not AI" for the built-in demo.
  "From your plan" blocks are figures Wayora calculated from saved data.
- **It does not stream.** A reply arrives whole. While waiting, the page says
  so; there is no typing indicator and no simulated streaming.
- **History is saved.** Conversations are stored per user (see
  [Conversations](#conversations)) until the user deletes them.

## Providers

Before Phase 21 there was no AI integration in Wayora. The assistant adds a
small, server-side provider interface (`apps/api/src/modules/assistant/provider.ts`).
A provider turns one request into raw text that should be `{"blocks":[…]}`. That
text is never trusted: it is validated and enriched by the server.

| `AI_PROVIDER` | What answers                                                                                                                         | Network            | Notes                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `demo`        | The **demo assistant**: deterministic rules over Wayora's curated catalog of 12 sample destinations and the plan's own data. Not AI. | none               | Default in development and test. It is used by the automated tests, so they never need a live model. Production logs a warning if it's on. |
| `anthropic`   | A language model through the **Anthropic Messages API** (`POST /v1/messages`, `anthropic-version: 2023-06-01`, not streamed)         | the provider's API | Needs `AI_API_KEY` and `AI_MODEL`; the server refuses to start without them.                                                               |
| `none`        | Nothing: the assistant is off                                                                                                        | none               | Default in production. The page says the assistant isn't available, and everything else works as usual.                                    |

The Anthropic adapter has been verified only against a fake HTTP endpoint in
the tests, covering:

- the request shape
- the key sent in a header only
- the status → error mapping
- truncated, empty and non-JSON replies

It has not been run against the live service: this repository has no provider
credentials, and the build environment can't reach the provider. No model is
assumed. Use a model your account can access, and check its output with the
tests' expectations in mind (JSON only, the block shapes below).

**Support suggestions (Phase 27)**: `AssistantProvider` has an optional
`complete({ system, messages }, options)` for plain-text requests from other
features. The Anthropic adapter implements it with the same transport and
safeguards; the demo provider doesn't (support then uses labelled templates).
See [support.md](support.md#ai-assistance).

**Adding a provider**: implement `AssistantProvider` (`generate(input, { signal,
maxOutputTokens })` → `{ output, usage }`) and add it to
`createAssistantProvider` (`modules/assistant/index.ts`). Throw
`AssistantProviderError` with a kind (`timeout`, `rate_limited`, `overloaded`,
`network`, `auth`, `bad_request`, `bad_response`). Never put credentials or
provider output into the error message.

## Configuration

| Variable                 | Default                                | Meaning                                                                                                                                                               |
| ------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI_PROVIDER`            | `demo` (dev/test), `none` (production) | `none`, `demo` or `anthropic`                                                                                                                                         |
| `AI_API_KEY`             | —                                      | The provider key. Server-side only; never put it in a `VITE_*` variable. Kept in a true private field, redacted from logs (`*.apiKey`, `AI_API_KEY`), never returned. |
| `AI_MODEL`               | —                                      | The model id; required for a live provider                                                                                                                            |
| `AI_BASE_URL`            | the provider's own                     | Another origin, e.g. a gateway; `https://` in production                                                                                                              |
| `AI_TIMEOUT_MS`          | 25000                                  | Time budget per reply, retries included (1000–45000)                                                                                                                  |
| `AI_MAX_ATTEMPTS`        | 2                                      | Attempts per reply (1–3). Only rate-limit, overload and network errors are retried.                                                                                   |
| `AI_MAX_OUTPUT_TOKENS`   | 2048                                   | Output bound per reply (256–8192)                                                                                                                                     |
| `AI_RATE_LIMIT_MAX`      | 6                                      | Assistant requests per user per minute                                                                                                                                |
| `AI_DAILY_REQUEST_LIMIT` | 50                                     | Assistant requests per user per 24 hours (cost cap)                                                                                                                   |

Configuration errors name the variable only, never its value.

## How a message is answered

The steps, from the user's message to the stored reply:

1. **Request.** `POST /assistant/conversations/:id/messages` carries `{ text, intent? }` and an `Idempotency-Key`.
2. **Checks.** The conversation must be the user's. If it is about a plan, the user needs current view access to that plan. The service also checks the size limits, the 24-hour cap and that no other reply in this conversation is in progress (`pending_until`).
3. **Intent.** The intent is the hint from a suggested prompt or, if there is none, a deterministic keyword match (`intent.ts`). It decides which context is needed.
4. **Context.** `context.ts` builds the minimal context from saved data.
5. **Provider call.** `callProvider` makes the call with one overall timeout and bounded, transient-only retries. The prompt is built by `prompt.ts`; the demo provider needs none.
6. **Validation.** `parse.ts` validates every block on its own. Invalid blocks are dropped. If none is left, the reply is refused and nothing is stored.
7. **Enrichment.** `enrich.ts` adds:
   - block ids
   - catalog matches
   - exact budget totals in minor units
   - real activity ids and versions for suggested moves
8. **Storage.** One transaction stores the user's message, the validated reply blocks and the provider's id, label and model. The idempotency key is completed in the same transaction.
9. **Request record.** Every provider call writes one row to `assistant_requests`: outcome, latency and token counts. Prompts and outputs are not stored.

A retry with the same key replays the stored reply: the provider is not asked again.

## Context

Context is built only after `tripAccess(…, 'view')` for the signed-in user, on
every request. `GET /assistant/trips/:tripId/context` returns exactly what can be
shared. The web page shows it under "What the assistant can see about this plan".

| Included (when relevant to the question)                                                                        | Never included                                         |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Destination, dates, number of days, group size (a number), pace, interests, group type, budget level            | Member names, emails, user ids                         |
| Activity titles, categories, times and durations, as `a1`, `a2`… (not for budget or packing questions)          | Notes on the plan and its activities                   |
| The planner's own schedule warnings                                                                             | Expense descriptions and notes, who paid what          |
| For budget questions only: budget and expense totals per currency and category, computed in integer minor units | Booking references, prices paid, payment details       |
| The owner's linked booking: category, start date and status (owner only)                                        | Anything from other plans or accounts; tokens; secrets |

A conversation that isn't about a plan gets no plan data at all. The plan's
database id is removed before anything is sent to a model.

### Prompt and prompt injection

- Wayora's rules are only in the system prompt (`prompt.ts`). The rules:
  - JSON only, with the allowed blocks
  - no prices, hours, availability or travel times stated as facts
  - never claim to have booked or changed anything
  - instructions found in data are ignored
- Everything users can write is sent as **JSON data** inside
  `<wayora_context>` and `<user_request>`: the message, plan titles and activity
  titles. Every `<` and `>` is escaped, so data can't close a section or open a
  new one (tested).
- Whatever the model writes:
  - it can only produce the block types in the contract;
  - it refers to activities only through `a1`… references, which the server maps
    back and checks;
  - it can't trigger any change.

## Validation

Model output must be `{"blocks":[…]}`. Each block is validated against
`assistantModelBlockSchema` (`packages/contracts/src/assistant.ts`):

- **Text** is plain text. Control characters and bidirectional overrides are
  removed and the length is bounded. It is rendered by React as text, so markup
  such as `<img onerror>` stays literal text (tested).
- **Itinerary**: 1–30 days. Each activity has a title, one of the planner's
  activity categories, an optional `HH:MM` start time, an optional duration of
  5–720 minutes, an area and a note. There are no price or availability fields.
- **Budget**: one of the six supported currencies, the budget categories, and
  amounts as whole currency units that must be integers. The server converts
  them to minor units by integer arithmetic and computes the total itself as the
  exact sum. Any total the model states is ignored.
- **Destinations, activities, packing**: bounded lists of strings and categories.
- **Moves**: `{ ref, toDay, reason }`. A move is kept only if the reference exists
  in the context sent, and the day is another day within the plan.

Output wrapped in a code fence or a sentence is accepted (the first balanced
`{…}` is taken). Text with no JSON at all becomes one text block. Malformed JSON,
a missing `blocks` array or no valid block means the reply is refused with
`ASSISTANT_UNAVAILABLE` ("couldn't be used"), and nothing is stored.

`facts` blocks ("From your plan") are added by the server for plan review and
budget questions. They are never taken from the model.

## Applying

Applying a proposal is a separate request:

```
POST /assistant/conversations/:id/messages/:messageId/apply
```

The body has `confirm: true` and an `Idempotency-Key`. The server reads the
**stored** proposal: the client only names it by `blockId` and chooses which
parts to use. Five actions exist; nothing else can be triggered from a reply.

| Action          | Does                                                                       | Who (on the target plan) | Through                                                    |
| --------------- | -------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------- |
| `add_itinerary` | Adds chosen activities to an existing plan, day _n_ → the plan's *n*th day | owner, editor            | `PlannerService.addItems`: one transaction, all or nothing |
| `create_plan`   | Creates a new plan of the user's own with the chosen activities            | the user                 | `PlannerService.createWithItems`                           |
| `add_activity`  | Adds one suggested activity to a chosen day                                | owner, editor            | `PlannerService.addItems`                                  |
| `apply_budget`  | Sets the plan's budget to the proposal                                     | owner, editor            | `BudgetService.putBudget`                                  |
| `move_activity` | Moves an activity to the suggested day                                     | owner, editor            | `PlannerService.updateItem`                                |

Rules for every action:

- **Same checks as editing by hand.** Each action applies the planner's and
  budget's own checks:
  - role: viewers get 403, non-members 404
  - dates: days outside the plan are refused; past start dates are refused
  - per-day and per-trip limits
  - history entries ("… (from an assistant suggestion)")
  - live updates
- **Nothing existing is replaced.** Applying only adds activities or sets the
  budget target. Existing activities, expenses, settlements and linked bookings
  are never changed or removed (tested).
- **Version checks.** A budget proposal needs the budget version the user saw. A
  suggested move carries the activity's version from when it was suggested, so
  an activity changed since is refused (`PLAN_OUT_OF_DATE`). Conflict detection
  works exactly as in the planner.
- **Read-only check first.** Before an itinerary is added to an existing plan,
  `POST …/messages/:messageId/check` shows:
  - where each chosen activity would land (or that it falls after the plan ends)
  - the planner's own warnings that involve the proposed activities (overlaps,
    long days…)
  - that existing activities stay
- **Never a booking.** A curated catalog id is kept only when it matches the
  plan's destination and isn't planned yet. AI suggestions never become bookings.
- **Recorded once.** Each applied action is recorded in `assistant_actions`, so
  the reply shows "Added to a plan". A retry with the same key records nothing
  more.

## Budget assistant

- Figures about a plan come from saved rows, computed by Wayora in integer minor
  units, **per currency, never converted**. They appear in the "From your plan"
  block. The model is never asked to calculate them.
- Budget proposals are estimates. Their total is computed by the server.
- The demo splits a stated amount (e.g. "Split ₹20,000…") by fixed shares, using
  integer arithmetic, with the remainder put in "Other". It reads amounts like
  "₹15,000", "15k" and "1.5 lakh" by string and integer arithmetic.
- Cost-cutting answers cite the plan's own biggest categories and give general
  ideas. They never touch expenses.
- There is no exchange-rate source. Proposals are in one currency, and changing a
  budget's currency is shown as "not converted".
- Applying a budget proposal needs confirmation, the current version, and editor
  rights. Recorded expenses are never changed (tested).

## Conversations

- Tables: `assistant_conversations` (owner, optional plan, title, `pending_until`)
  and `assistant_messages`. A message holds either the user's text, or the
  validated blocks with the provider's id, label and model. Nothing else is
  stored: no prompts, provider output, reasoning or tokens.
- **Private to their creator**, even on a shared plan: other members don't see
  them.
- **Reading or sending needs current access to the plan.** Removing a member
  closes their conversations about that plan at once. They are listed as "Plan no
  longer available", and the member can still delete them.
- **Deletion.**
  - Deleting a conversation deletes its messages and applied-action records.
  - Deleting a plan deletes conversations about it.
  - Deleting an account deletes everything (cascade).
  - Request records lose their conversation link.
- **Limits.** 50 conversations per user and 200 messages per conversation
  (`ASSISTANT_LIMIT_REACHED`). The newest 50 messages are returned, with
  `?before=` for older ones. Messages are at most 2,000 characters; the last 12
  are sent with a new one. The title is the first message, shortened to 60
  characters.

## API

All endpoints are under `/api/v1/assistant`. A session is required, and
responses are `no-store`.

| Method | Path                                           | Notes                                                                                       |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| GET    | `/status`                                      | `available`, `source` (provider, label, simulated), `streaming: false`, limits, `usedToday` |
| GET    | `/conversations?page=&pageSize=`               | Your conversations                                                                          |
| POST   | `/conversations`                               | `{ tripId? }` (view access needed); `Idempotency-Key`; 201                                  |
| GET    | `/conversations/:id?before=`                   | Messages, oldest first; `tripAccess` (your role on the plan)                                |
| DELETE | `/conversations/:id`                           | Allowed even after losing access to the plan                                                |
| POST   | `/conversations/:id/messages`                  | `{ text, intent? }`; `Idempotency-Key`; 201 `{ userMessage, reply }`; AI limits             |
| POST   | `/conversations/:id/messages/:messageId/check` | `{ blockId, tripId, selected }`, read-only                                                  |
| POST   | `/conversations/:id/messages/:messageId/apply` | One of the five actions; `confirm: true`; `Idempotency-Key`                                 |
| GET    | `/trips/:tripId/context`                       | Exactly what the assistant can see about a plan                                             |

Request bodies are strict, so unknown fields are refused. Writes need a trusted
`Origin`.

Errors:

| Code                      | Status | Meaning                                                      |
| ------------------------- | ------ | ------------------------------------------------------------ |
| `ASSISTANT_UNAVAILABLE`   | 503    | No provider; the provider failed; or the answer was unusable |
| `ASSISTANT_TIMEOUT`       | 504    | The provider didn't answer in time                           |
| `ASSISTANT_BUSY`          | 409    | A reply is already in progress in this conversation          |
| `ASSISTANT_LIMIT_REACHED` | 409    | Too many conversations or messages                           |
| `RATE_LIMITED`            | 429    | The per-minute limit or the 24-hour cap was reached          |

The usual `NOT_FOUND`, `FORBIDDEN`, `VALIDATION_FAILED` and `PLAN_OUT_OF_DATE`
also apply. Provider errors are never passed on: no status codes, provider
messages or keys.

## Reliability and cost

- **Bounds.** One overall timeout per reply (`AI_TIMEOUT_MS`, at most 45 s).
  Output is capped (`AI_MAX_OUTPUT_TOKENS`); input is bounded too (a
  2,000-character message, 12 history messages shortened to 1,500 characters
  each, at most 120 activities).
- **Retries.** At most `AI_MAX_ATTEMPTS` attempts. Only rate-limit, overload and
  network failures are retried, with a short pause, and only while time remains.
  A timeout or an unusable answer is never retried.
- **Duplicates.**
  - The `Idempotency-Key` on sends: a double click or a retry replays the stored
    reply.
  - `pending_until` allows one reply at a time per conversation; its lock outlives
    the timeout, and it is cleared afterwards, also on failure.
- **Limits.** Per-user limits per minute (`AI_RATE_LIMIT_MAX`) and per 24 hours
  (`AI_DAILY_REQUEST_LIMIT`, counted in `assistant_requests`). No new Redis or
  queue infrastructure was needed: the existing rate-limit stores are used.
- **Logs.** Logs record the provider, model, intent, outcome, latency, attempts,
  dropped blocks and token counts. They never include prompts, messages, plan
  data or keys.
- **Admin health.** Platform health (`/admin/health`) shows a "Travel assistant"
  check:
  - the provider (and whether it's the demo)
  - failed requests in the last hour (degraded if any)
  - not configured when it's off

  It makes no paid provider call.

- **Failure handling.** If the assistant fails or is off, plans, budgets and the
  rest of Wayora are unaffected.

## Web

- `/assistant` starts a new conversation. It is created on the first message,
  so empty conversations aren't stored.
- `/assistant?trip=<id>` starts one about a plan, via **Ask the assistant** on the
  plan page. `/assistant/:id` opens a saved one. Conversations are listed beside
  the chat (in a row on small screens).
- **Suggested prompts.** The example requests appear as buttons. The plan-specific
  ones ("Make my itinerary less hectic", "Help us reduce our group trip
  expenses") appear only in a conversation about a plan.
- **Reply cards.**
  - Itinerary preview, with estimated durations: "Review and add to a plan…"
    opens a dialog where you untick activities, choose a plan or a new plan, see
    the check results, and confirm.
  - Activity cards, each with "Add to a plan…".
  - Budget proposal table: "Use as this plan's budget…" shows what it replaces,
    then you confirm.
  - Destination cards, linking to the sample destination pages.
  - Packing checklist: ticks stay on screen only and aren't saved.
  - Suggested moves, each needing confirmation.
- Viewers see suggestions without any apply buttons, with a note on why.
- **Keyboard and screen readers.**
  - Enter sends; Shift+Enter starts a new line.
  - The waiting state is a status message, and replies are announced.
  - Focus stays in the composer.
  - Every control is labelled, dialogs trap focus, and scrolling respects
    reduced motion.

## Data model and migration

Migration `20261030000000_travel_assistant` is additive. It adds:

- the `assistant_conversations`, `assistant_messages`, `assistant_requests` and
  `assistant_actions` tables
- two enums
- CHECKs:
  - a message is either user text, or blocks (a JSON array) with a provider
  - titles are non-empty
  - numbers are non-negative
  - only the five action names, with block ids like `b2`

Apply it with `npm run db:migrate:deploy`.

### Rollback

```sql
BEGIN;
DROP TABLE IF EXISTS "assistant_actions";
DROP TABLE IF EXISTS "assistant_requests";
DROP TABLE IF EXISTS "assistant_messages";
DROP TABLE IF EXISTS "assistant_conversations";
DROP TYPE IF EXISTS "assistant_request_outcome";
DROP TYPE IF EXISTS "assistant_message_role";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261030000000_travel_assistant';
COMMIT;
```

This deletes every conversation. Plans, items added from proposals and budgets
stay. Then deploy the Phase 20 API and web. Tested: the rollback leaves exactly
the Phase 20 schema, and re-applying works.

## Tests

```bash
# Unit, no services:
# - provider configuration and missing credentials
# - timeouts and bounded retries
# - the Anthropic adapter against a fake HTTP endpoint (status mapping, truncated/empty/non-JSON replies, key only in a header)
# - prompt-injection framing
# - output validation (malformed, invalid fields, markup kept as text)
# - enrichment (exact budget totals, moves)
# - intents
# - the deterministic demo
npm test -w @wayora/api -- assistant-unit
# Integration (PostgreSQL; see docs/auth.md#running-the-tests):
# - conversation ownership, plan membership, viewer/editor/owner, cross-user denial
# - minimal context
# - itinerary proposals (confirmation, invalid days, conflicts, existing activities and bookings kept, new plans)
# - budget proposals (persisted figures, currencies kept apart, minor units, versions, expenses untouched)
# - moves with conflict detection
# - provider timeout, error and unusable output storing nothing
# - Idempotency-Key, busy conversations
# - daily and per-minute limits; conversation and message caps
TEST_DATABASE_URL=postgresql://…/wayora_test npm test -w @wayora/api -- integration/assistant
# Web:
# - loading, unavailable, waiting, error and retry states
# - history; source labels; text never rendered as HTML
# - itinerary preview, apply and cancel; new plan
# - budget proposal; viewer view
# - starting from a plan, context disclosure
# - packing checklist; missing conversations
npm test -w @wayora/web -- assistant
```

All provider tests use deterministic fakes or the demo. No live credentials are
needed or used.

## Limitations

- **No live AI was exercised.** In this environment the assistant ran with the
  rule-based demo (and scripted test providers). The Anthropic adapter is tested
  only against a fake endpoint. Answer quality with a real model is unmeasured.
- **The demo knows only Wayora's 12 sample destinations.** For anything else it
  says so instead of inventing places.
- **No live data.** There are no prices, availability, opening hours, weather or
  routing; nothing is travel-time-validated.
- **Not streamed.** Replies take up to `AI_TIMEOUT_MS` and arrive whole.
- **Intent matching is keyword-based.** It is used to pick the context and to
  drive the demo. A model still sees the request in full, but gets only the
  context chosen for that intent.
- **Limited editing actions.** The assistant can't edit or delete existing
  activities, change dates, split expenses or record payments. Moves are its only
  change to existing activities.
- **Time-based caps.** The 24-hour cap is per user and counted from stored
  requests, not per token. Tokens are recorded when the provider reports them.
