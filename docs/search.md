# Travel search, results and offers (Phases 9–11)

One search engine for all seven categories (flights, hotels, trains, buses,
metro, cabs, holiday packages), fed by **provider adapters** that translate
between suppliers and Wayora's shared contracts. Today every adapter is a
**demo provider** serving fixed fixtures. Nothing is live or priced by a
supplier; offers can only be booked as demo bookings ([bookings.md](bookings.md)).

> **Demo data.** All search results come from Wayora's built-in sample
> fixtures. Carriers, trains, bus operators, hotels and packages are fictional
> and named "Demo"/"(demo)". Prices and times are illustrative, availability
> is never checked, and bookings are demo bookings only (no reservation,
> ticket or payment). The API says so in every
> response (`disclaimer`, a `DEMO_DATA` warning, `source: "demo"` on every
> result), and the web app shows it on every page and card.

## Architecture

```text
apps/web  features/search/*            form + URL state + results (React Query)
   │  POST /api/v1/search/:serviceType   (services/search.ts)
   ▼
apps/api  modules/search/search.routes.ts   validate with the category's contract
          modules/search/search.service.ts  orchestration (one implementation)
             ├─ ProviderRegistry            which providers are enabled for the category
             ├─ concurrency.ts              bounded parallelism + per-call timeouts
             ├─ resilience.ts               deadline, retries with jitter, circuit breakers
             ├─ errors.ts                   failures → stable client codes; log scrubbing
             ├─ contract re-validation      every result, per provider (+ integrity.ts)
             ├─ merge + de-duplicate        by an adapter-supplied key
             ├─ refine.ts                   filters, sorting (all categories)
             └─ sessions.ts                 search sessions: Redis (memory in local dev)
          modules/providers/provider.ts     SearchProvider interface
          modules/providers/demo/*          seven demo adapters (fixtures)
packages/contracts/src/search/*             requests, results, places, statuses
```

- The search service never sees a supplier format: adapters return the
  normalized result types, and the service validates them again at runtime.
- Categories differ only in **contracts**, **adapters**, a **filter/sort
  table** (`refine.ts`) and, on the web, a **config entry** and a **result
  card**. There is no per-category orchestration.
- No microservices, no new dependencies.

## Contracts (`@wayora/contracts`)

### Requests

One strict Zod schema per category, combined as a discriminated union on
`serviceType` (`searchRequestSchema`, `searchRequestSchemas[type]`). Unknown
fields are rejected; defaults are applied (`currency: "INR"`, `page: 1`,
`pageSize: 10`, `sortBy`: the category's `DEFAULT_SORT`, zero children…).
Filters are listed under [Filters](#filters).

| Category | Required                                                      | Optional                                          |
| -------- | ------------------------------------------------------------- | ------------------------------------------------- |
| flights  | `origin`, `destination` (airports), `departureDate`, `adults` | `returnDate`, `children`, `infants`, `cabinClass` |
| hotels   | `destination` (city), `checkIn`, `checkOut`, `adults`         | `rooms`, `children`                               |
| trains   | `origin`, `destination` (stations), `departureDate`, `adults` | `children`                                        |
| buses    | `origin`, `destination` (cities), `departureDate`, `adults`   | `children`                                        |
| metro    | `origin`, `destination` (stations of one city)                | `passengers`                                      |
| cabs     | `pickup`, `dropoff` (same city), `pickupAt`                   | `passengers`                                      |
| holidays | `destination`, `departureDate`, `adults`                      | `children`                                        |

Rules checked before any provider runs: places exist and are of the right
kind (`airport:BLR`, `station:SBC`, `city:goa`, `metro:blr-mg-road`,
`locality:…`, `destination:kerala`); the two ends differ (and are in the
same city for metro and cabs); dates are real, not past, within 365 days;
return ≥ departure; hotel stays 1–30 nights; party limits per category (e.g.
≤ 9 seated flight passengers, ≤ 1 infant per adult, ≥ 1 adult per room);
`page` ≤ 100, `pageSize` ≤ 50; currency in `INR, USD, EUR, GBP, AED, SGD`.

**Dates and time zones.** Travel dates are calendar dates (`YYYY-MM-DD`) in
the local time of the place. Instants (`pickupAt`, departure/arrival times,
`generatedAt`) are ISO 8601 with an explicit offset, e.g.
`2026-11-12T06:15:00+05:30`; results use the place's local offset. The web
form converts a cab pick-up time to the pick-up place's offset.

**Places.** `SEARCH_PLACES` is reference data (public IATA and station codes)
matching the demo coverage, not inventory. Live suppliers will need a
place-lookup service instead.

### Results and response

Results are a discriminated union (`searchResultSchema`) with category
fields only; nothing is an untyped record. Every result has:
`id` (`<providerId>:<offerRef>`), `providerId`, `source` (`demo` | `live`),
`title`, `price` (or `null`), optional `availability` (**only when a
provider reports it; demo data never does**), `offerRef` (the provider's
own reference for a later revalidation step), and `validUntil`.

Money is `{ amountMinor: "<integer string>", currency }`: minor units as a
string, compared with `BigInt`, never floats. A `price` is a `total` (with
an optional per-adult/night/passenger figure) or a `range` (cab estimates).
**Currencies are never converted or combined**: results priced in another
currency are flagged (`CURRENCY_NOT_CONVERTED`), sorted after comparable
ones, and excluded from a price filter with a `PRICE_FILTER_CURRENCY` warning.

Response envelope (`searchResponseSchema`): `searchId`, `serviceType`,
`results`, `pagination`, `providerStatuses`, `dataSource`
(`demo`/`live`/`mixed`/`none`), `disclaimer`, `warnings`, `generatedAt`,
`expiresAt`.

Provider statuses: `success` (≥ 1 valid result), `empty` (answered, nothing
matched), `timeout`, `unavailable`, `error` (failed or only invalid data),
each with a safe `message`.

`facets` (Phase 10) lists the filter choices present in the search's results:
see [Facets](#facets).

### Filters

Every filter refers to a field the normalized result for that category
actually carries; there are no rating, review, discount or availability
filters because no result has those fields. Filters are applied by the API to
the whole stored provider round (before paging), so they never cause new
provider calls during a search's lifetime. Price limits are integer minor
units in the request currency.

| Category | Filters (request `filters` keys)                                                                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| flights  | `maxStops`, `departureWindows`, `arrivalWindows` (outbound, local time), `carriers` (any segment), `maxDurationMinutes` (each direction), `minPriceMinor`/`maxPriceMinor` (whole party) |
| hotels   | `propertyTypes`, `amenities` (all required), `areas`, `breakfastIncluded`, `minNightlyPriceMinor`/`maxNightlyPriceMinor` (per night, all rooms)                                         |
| trains   | `classes`, `trains` (train numbers), `departureWindows`, `arrivalWindows`, `maxDurationMinutes`                                                                                         |
| buses    | `busTypes`, `operators`, `amenities` (all required), `departureWindows`, `arrivalWindows`, `maxDurationMinutes`, `minPriceMinor`/`maxPriceMinor`                                        |
| metro    | `maxTransfers`, `lines` (line ids; any leg), `maxDurationMinutes`                                                                                                                       |
| cabs     | `vehicleTypes`, `minCapacity`, `minPriceMinor`/`maxPriceMinor` (an estimate range matches if it overlaps)                                                                               |
| holidays | `minNights`, `maxNights`, `interests` (any), `minPriceMinor`/`maxPriceMinor` (whole party)                                                                                              |

Lists match **any** selected value, except amenities, which must **all** be
present. Different filters combine with AND. A result without a price never
matches a price limit; results priced in another currency are left out and
counted (`PRICE_FILTER_CURRENCY`), never converted. Inverted ranges
(`min > max`) are rejected with `400`. Holidays have no destination filter
because a holiday search is already for one destination.

### Sorting

| Category | Options (default first)                                                   |
| -------- | ------------------------------------------------------------------------- |
| flights  | `recommended`, `price-asc`, `price-desc`, `duration-asc`, `departure-asc` |
| hotels   | `price-asc`, `price-desc`                                                 |
| trains   | `departure-asc`, `duration-asc`, `price-asc`, `price-desc`                |
| buses    | `departure-asc`, `duration-asc`, `price-asc`, `price-desc`                |
| metro    | `transfers-asc` (then shortest), `duration-asc`                           |
| cabs     | `price-asc`, `price-desc`, `capacity-desc`                                |
| holidays | `price-asc`, `price-desc`, `duration-asc`, `duration-desc` (nights)       |

- **Flights `recommended`** is the only ranking: fewest stops, then lowest
  price, then shortest journey (longest direction). It uses only fields every
  flight result has; there is no hidden score. Other categories default to a
  plain, labelled order (departure for timetabled transport, price
  otherwise).
- **Ties** always fall back to the same chain: lowest price, earliest
  departure, shortest journey, then result id, so equal results keep a stable
  order.
- **Missing values are never zero:** a result with no comparable price
  (none, or another currency) sorts after every comparable one, in both
  price directions.
- `DEFAULT_SORT` in `@wayora/contracts` is the single source of these
  defaults; the web marks the default option "(default)".

### Facets

`facets` on every search response, built from the **unfiltered** round so
choices don't vanish as filters are applied (counts are of that set):

- `price`: lowest and highest comparable price in the request currency, with
  its `basis` (`night` for hotels, `total` otherwise; cab ranges use the low
  end), or `null`;
- `durationMinutes`: journey range (longest direction for return flights), or
  `null` for hotels and holidays;
- `options`: values found in the results, with labels and counts:
  `stops`, `carriers`; `propertyTypes`, `amenities`, `areas`; `classes`,
  `trains`; `operators`, `busTypes`, `busAmenities`; `lines`, `transfers`;
  `vehicleTypes`, `capacities`; `interests`, `nights`. Keys with no values are
  omitted.

## API

| Method | Path                                                       | Notes                                                               |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| POST   | `/api/v1/search/:serviceType`                              | `flights`, `hotels`, `trains`, `buses`, `metro`, `cabs`, `holidays` |
| GET    | `/api/v1/search/:serviceType/sessions/:searchId/offer?id=` | One validated offer of a stored search (offer pages)                |
| GET    | `/api/v1/providers`                                        | Safe provider metadata (no credentials, URLs or config values)      |

Public (no session; nothing user-specific), JSON only, 100 kB body limit,
per-IP `SEARCH_RATE_LIMIT_MAX` searches per minute on top of the general
limit (offer lookups count only against the general limit), the Phase 8
`Origin` check on `POST`, `Cache-Control: no-store`. The category
comes from the path; `serviceType` in the body is optional and must match.

| Status | When                                                                     |
| ------ | ------------------------------------------------------------------------ |
| 200    | At least one provider answered (results may be empty or partial)         |
| 400    | `VALIDATION_FAILED` with per-field `details`                             |
| 403    | Request from an origin not in `CORS_ORIGIN`                              |
| 404    | Unknown category                                                         |
| 429    | Search rate limit                                                        |
| 502    | `SEARCH_FAILED`: every provider failed (errors, unusable data, or mixed) |
| 503    | `PROVIDER_UNAVAILABLE`: every provider unavailable (incl. open breakers) |
| 503    | `SERVICE_UNAVAILABLE`: no enabled provider, or the session store is down |
| 504    | `PROVIDER_TIMEOUT`: every provider timed out                             |

See [Errors](#errors) for every code and its wording.

Example (real output, trimmed):

```bash
curl -X POST localhost:4000/api/v1/search/hotels \
  -H 'Content-Type: application/json' \
  -d '{"destination":"city:goa","checkIn":"2026-11-10","checkOut":"2026-11-13","adults":2,"sortBy":"price-asc","pageSize":1}'
```

```json
{
  "data": {
    "searchId": "fba29176-b3af-4361-94ec-c2614d72e3d4",
    "serviceType": "hotels",
    "results": [
      {
        "serviceType": "hotels",
        "id": "demo-hotels:goa-red-roof/2026-11-10/2026-11-13/1",
        "providerId": "demo-hotels",
        "source": "demo",
        "title": "Red Roof Homestay (demo), Palolem",
        "price": {
          "kind": "total",
          "total": { "amountMinor": "1170000", "currency": "INR" },
          "perUnit": { "amount": { "amountMinor": "390000", "currency": "INR" }, "unit": "night" }
        },
        "offerRef": "goa-red-roof/2026-11-10/2026-11-13/1",
        "validUntil": "2026-10-21T11:34:32.239Z",
        "property": {
          "name": "Red Roof Homestay (demo)",
          "propertyType": "homestay",
          "area": "Palolem",
          "cityName": "Goa"
        },
        "roomType": "Family room",
        "checkIn": "2026-11-10",
        "checkOut": "2026-11-13",
        "nights": 3,
        "rooms": 1,
        "guests": 2,
        "amenities": ["wifi", "parking"],
        "breakfastIncluded": false
      }
    ],
    "pagination": { "page": 1, "pageSize": 1, "totalResults": 3, "totalPages": 3 },
    "providerStatuses": [
      {
        "providerId": "demo-hotels",
        "providerName": "Wayora demo hotels",
        "kind": "demo",
        "status": "success",
        "resultCount": 3,
        "durationMs": 1,
        "message": null
      }
    ],
    "dataSource": "demo",
    "disclaimer": "Demo data: these results come from Wayora’s built-in sample fixtures, …",
    "warnings": [{ "code": "DEMO_DATA", "message": "Demo data: …" }],
    "generatedAt": "2026-10-21T11:14:32.240Z",
    "expiresAt": "2026-10-21T11:16:32.240Z"
  },
  "meta": { "requestId": "70e4b8d7-46e7-440c-b75e-da50001d60d9" }
}
```

A validation failure:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request is invalid.",
    "details": [
      { "path": "body.checkIn", "message": "That date has already passed.", "code": "custom" },
      { "path": "body.adults", "message": "Enter 1 or more.", "code": "too_small" }
    ],
    "requestId": "…"
  }
}
```

### Offer lookup

```bash
curl 'localhost:4000/api/v1/search/hotels/sessions/fba29176-b3af-4361-94ec-c2614d72e3d4/offer?id=demo-hotels%3Agoa-red-roof%2F2026-11-10%2F2026-11-13%2F1'
```

returns `{ searchId, serviceType, result, disclaimer, generatedAt, expiresAt,
validation }` (`offerResponseSchema`), read from the server's stored session.
The query is strict: only `id`. Any other parameter (a price, currency,
provider reference…) is a `400`; nothing the client sends about an offer is
ever used. See [Offer validation](#offer-validation) for the checks and
their error codes.

## Search sessions

A search session is one completed provider round: the validated, normalized
offers plus provider statuses and round warnings (no request data, nothing
about the visitor). Paging, sorting and filtering within its lifetime re-read
it instead of calling providers again, and offer pages read their offer from
it, so the price a visitor sees is always the server's copy.

**Storage: Redis** (`sessions.ts`, `RedisSearchSessionStore`), using the
API's existing Redis client and `REDIS_URL`:

| Key                                | Value                              | TTL       |
| ---------------------------------- | ---------------------------------- | --------- |
| `wayora:search:<searchId>`         | the session (versioned JSON)       | time left |
| `wayora:search:reuse:<requestKey>` | `searchId` of the reusable session | the same  |

- **Lifetime:** `SEARCH_SESSION_TTL_SECONDS` (60–1800, default **600**). Both
  keys are written in one `MULTI` with `PX` = time until `expiresAt`, so Redis
  removes them on its own; reads also check `expiresAt` (clock skew between
  instances). Offers are valid only within this lifetime.
- **Across restarts and instances:** any API process sharing the Redis reads
  any session; a restart loses nothing while the TTL lasts.
- **`searchId`:** a random UUID per provider round. Concurrent searches never
  share one; identical requests reuse a complete round.
- **Reuse:** only **complete** rounds (every provider answered) get a reuse
  pointer, so "Try again" after a partial failure really asks again. The
  request key is a SHA-256 of everything that changes provider answers
  (category, route, dates, party, cabin/class, currency, each provider's
  `id@version`); filters, sort and page are excluded.
- **Every read is validated** against a schema (shared result contracts plus
  the integrity rules below). Bad JSON, an unknown version, a wrong shape, a
  mixed-currency price, a forged offer id or a mismatched `searchId` → the
  entry is deleted, a warning is logged, and the session counts as missing
  (`SEARCH_EXPIRED`).
- **Redis unavailable:** commands fail fast (no offline queue, 2 s command
  timeout); search and offer requests answer `503 SERVICE_UNAVAILABLE`
  ("Search is temporarily unavailable…"), checked **before** providers are
  called. There is **no fallback to process memory**: a session one instance
  can't share would break offer pages behind a load balancer. The cause is
  logged (scrubbed); clients never see Redis details.
- **Store selection:** `SEARCH_SESSION_STORE=redis|memory`; unset means
  `redis` when `REDIS_URL` is set. **Production refuses to start** unless it
  resolves to `redis` with `REDIS_URL`. `memory` (`MemorySearchSessionStore`:
  per process, 200 entries, least recently used evicted) is for local
  development without Redis and for tests; the server logs a warning when it
  is used.
- **No database tables:** searches are public and short-lived.
- **Size:** a session is the provider round (tens of results, typically well
  under 100 kB). Readiness still treats Redis as non-essential: accounts keep
  working without it; search reports 503.

## Offer validation

`GET …/sessions/:searchId/offer?id=` checks, in order:

| #   | Check                                                                             | Failure                              |
| --- | --------------------------------------------------------------------------------- | ------------------------------------ |
| 1   | `id` has Wayora's shape `<providerId>:<offerRef>` and names a registered provider | `404 OFFER_NOT_FOUND`                |
| 2   | that provider serves the requested category                                       | `409 CATEGORY_MISMATCH`              |
| 3   | the session exists, is readable and hasn't expired                                | `410 SEARCH_EXPIRED`                 |
| 4   | the session is for the requested category                                         | `409 CATEGORY_MISMATCH`              |
| 5   | the offer is part of this session                                                 | `404 OFFER_NOT_IN_SEARCH`            |
| 6   | the stored offer passes the integrity rules                                       | `410 SEARCH_EXPIRED` (logged)        |
| 7   | revalidation, if the provider supports it (below)                                 | `410 OFFER_UNAVAILABLE`, `503`/`504` |

- "Offer belonging to a different search" is `OFFER_NOT_IN_SEARCH`: offer ids
  are stable across searches, so an id from search A is accepted through
  search B only if B's own results contain it. Sessions are not indexed by
  offer, so a well-formed id that never existed answers the same way.
- **Integrity rules** (`integrity.ts`, plus the shared price schema), applied
  when provider results are accepted **and** whenever a session is read:
  category matches the search, `providerId` matches the adapter,
  `id === providerId + ':' + offerRef`, one currency per price (total and
  per-unit; range min and max), range not inverted, integer minor units.
- **Never trusted from the client:** prices, discounts, totals, currencies,
  provider references. The endpoint accepts none; the response is the stored
  offer (or the provider's revalidated one).
- `validation` in the response says how current the offer is:
  `session` (as searched; not rechecked: all demo offers), `confirmed`
  (rechecked now, unchanged, `checkedAt`), or `price-changed` (rechecked now;
  `result.price` is the new price, `previousPrice` the one the search showed).

## Provider revalidation

Adapters may implement `revalidate(offer, { signal, now })` and declare
`operations.revalidate: 'supported'`. It must be a read-only, idempotent
supplier call by `offer.offerRef`. The answer is validated
(`{ status: 'available', price } | { status: 'unavailable' }`):

- same price (exact integer comparison) → `confirmed`,
- different price in the **same currency**, valid for the contract →
  `price-changed`; the session is updated (best effort) so the results page
  shows the new price too,
- `unavailable` → `410 OFFER_UNAVAILABLE`,
- another currency, a float, a missing price or a malformed answer → refused
  (`503 PROVIDER_UNAVAILABLE`), never shown,
- timeout / failure → `504 PROVIDER_TIMEOUT` / `503 PROVIDER_UNAVAILABLE`,
  through the same deadline, retries and breaker as search.

**Today no adapter supports it:** all seven are demo fixtures and keep
`revalidate: 'unsupported'`, so every offer is `validation.status: 'session'`
and is valid only within the session lifetime. Wayora does **not** simulate
repricing. The flow above is exercised by a test-only adapter
(`apps/api/test/search-offers.test.ts`). **Real supplier revalidation is
required before any real booking or payment step.** Demo bookings (Phase 12,
[bookings.md](bookings.md)) use the session copy and are labelled as such.

## Errors

All failures use the standard envelope `{ error: { code, message, requestId,
details? } }`. Clients branch on `code`; `message` is Wayora's own wording.

| Code                   | Status | When                                                               |
| ---------------------- | ------ | ------------------------------------------------------------------ |
| `SEARCH_EXPIRED`       | 410    | Session expired, unknown, or unreadable. Search again              |
| `OFFER_NOT_FOUND`      | 404    | Offer id isn't Wayora's shape or names no registered provider      |
| `OFFER_NOT_IN_SEARCH`  | 404    | Well-formed offer id that isn't in this session                    |
| `CATEGORY_MISMATCH`    | 409    | Path category differs from the session's or the offer provider's   |
| `OFFER_UNAVAILABLE`    | 410    | Provider reports the offer gone (revalidation)                     |
| `PROVIDER_TIMEOUT`     | 504    | Every provider timed out (search), or the offer check did          |
| `PROVIDER_UNAVAILABLE` | 503    | Every provider unavailable / breaker open; offer check failed      |
| `SEARCH_FAILED`        | 502    | Every provider failed for other or mixed reasons                   |
| `SERVICE_UNAVAILABLE`  | 503    | No enabled provider for the category, or the session store is down |

`errors.ts` is the only place provider and store failures become these codes.
**Nothing from a supplier reaches a client:** not its message, response body,
status line, URL, credentials or stack; `ProviderError` messages are for
logs only, and provider statuses carry fixed texts ("This provider took too
long to answer." etc.). Server logs carry `requestId`, `providerId`,
`operation`, outcome and the error's class plus a **scrubbed** message
(`scrub()`: URLs keep scheme, host and path but lose user info and query
strings; bearer/basic credentials and `key=value` pairs for secret-looking
keys are masked; 300 characters max), on top of the logger's redaction
paths.

## Timeouts, retries and circuit breakers

`resilience.ts`, applied to every provider call (search and revalidation):

- **Deadline:** one budget per search or offer check
  (`SEARCH_DEADLINE_MS`, default 8 000, max 14 000, below the web client's
  15 s). Each attempt's limit is the provider's `timeoutMs`, cut to what is
  left of the deadline; a provider that ignores its abort signal is still
  abandoned at the limit.
- **Retries:** only **transient** failures (timeouts; `ProviderError` with
  `transient`, the default for `unavailable`) of **idempotent, read-only**
  operations. Permanent errors (`ProviderError('error')`, e.g. bad
  credentials or a rejected request) and unknown exceptions are never
  retried; non-idempotent operations are never retried (demo booking creation
  is not a provider call; it is protected by an idempotency key instead,
  [bookings.md](bookings.md#idempotency)). Attempts: `SEARCH_PROVIDER_MAX_ATTEMPTS` (default 2, i.e. one
  retry; max 4). Backoff: full jitter over `base × 2^(n-1)`, capped at
  `8 × SEARCH_PROVIDER_RETRY_BASE_MS` (default base 200 ms). A retry is
  skipped if the wait plus a meaningful attempt would pass the deadline.
  Retries are logged with the attempt and delay.
- **Circuit breaker per provider:** after
  `SEARCH_BREAKER_FAILURE_THRESHOLD` (default 5) consecutive failed calls the
  breaker **opens** and the provider is skipped instantly (status
  `unavailable`) instead of costing every search a full timeout. After
  `SEARCH_BREAKER_COOLDOWN_SECONDS` (default 30) it goes **half-open**: one
  trial call; success **closes** it, failure reopens it. A call abandoned by
  the client frees the trial slot. Breakers are per API process (each
  instance learns from its own calls; they don't depend on Redis), and one
  provider's breaker never affects another's.
- **Partial results** are kept: failed providers become statuses, other
  providers' results are returned.

## Adapters

```ts
interface SearchProvider {
  id: string; // stable, used in result ids and logs
  name: string;
  kind: 'demo' | 'live';
  version: string; // part of the cache key; bump on mapping changes
  serviceTypes: SearchServiceType[];
  operations: { search; revalidate; book: 'supported' | 'unsupported' };
  timeoutMs: number; // per call (each attempt), within the deadline
  requiredConfig: string[]; // env var NAMES; provider disabled if any is missing
  search(request, { signal, now }): Promise<{ results: ProviderResult[] }>;
  revalidate?(offer, { signal, now }): Promise<RevalidationOutcome>; // optional, read-only
}
```

- `ProviderResult` is a normalized result plus an optional `dedupeKey`
  (same underlying offer across providers). Omit it when no reliable key
  exists; such results are never merged.
- Throw `ProviderError('unavailable' | 'error', message, { transient })` for
  failures you understand. Mark only failures worth retrying soon as
  `transient` (429, 502/503, dropped connections; default for
  `unavailable`); bad credentials and rejected requests must not be. The
  message is **logged (scrubbed), never shown**: clients get fixed wording.
  Any other exception is a non-retried `error`; only its class and scrubbed
  message are logged, never payloads.
- Pass `signal` to outbound requests; it fires at `timeoutMs` or when the
  client goes away.
- `singleCategoryProvider({...})` narrows the request type for one-category
  adapters (all demo adapters use it).

**Registration** is explicit (`apps/api/src/app.ts`): the registry is built
from `searchProviders` (default `DEMO_PROVIDERS`). A provider is **disabled**
when listed in `SEARCH_DISABLED_PROVIDERS`, when it is a demo provider and
demo data is off, or when any `requiredConfig` name is unset. Disabled
providers are listed by `GET /providers` with a plain-words reason, and never
queried.

## Orchestration

For each request: validate → resolve enabled providers for the category →
reuse a live complete session for the same request, or query providers with
**bounded concurrency** (4) through the [resilience layer](#timeouts-retries-and-circuit-breakers)
→ validate every result against the category contract, the adapter's
`providerId`/`source` and the [integrity rules](#offer-validation) → merge in
provider order and de-duplicate by `dedupeKey` (cheaper wins, same currency
only) → store the round as a [session](#search-sessions) → filter → sort (see
[Sorting](#sorting)) → page, and compute facets from the unfiltered round.

- **Partial failure:** failed providers become statuses with fixed messages
  and a `PARTIAL_RESULTS` warning; other providers' results are returned.
- **All providers failed:** `PROVIDER_TIMEOUT` (504), `PROVIDER_UNAVAILABLE`
  (503) or `SEARCH_FAILED` (502) by cause, never an empty "success".
- **Zero results** from healthy providers is a normal `200` with `empty`
  statuses.
- **Malformed provider data:** invalid results are dropped and counted
  (`INVALID_PROVIDER_RESULTS`); a provider with only invalid results gets
  `error`.
- Failed rounds are stored (offers stay readable) but never reused, so the
  client's "Try again" really asks again.
- Logs: `requestId`, category, `searchId`, store, per-provider
  status/count/duration, reuse, retries, breaker skips. No request bodies,
  traveller details or supplier payloads.

## Configuration (`apps/api/.env`)

All validated at startup (`config/env.ts`); invalid values stop the API with
an actionable message.

| Variable                           | Default                                              | Notes                                                                         |
| ---------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| `SEARCH_DEMO_PROVIDERS`            | unset: on in development/test, **off in production** | `true`/`false` to override                                                    |
| `SEARCH_DISABLED_PROVIDERS`        | empty                                                | Comma-separated provider ids, e.g. `demo-cabs`                                |
| `SEARCH_RATE_LIMIT_MAX`            | `30`                                                 | Searches per IP per minute                                                    |
| `SEARCH_SESSION_STORE`             | `redis` if `REDIS_URL` is set, else `memory`         | Production: must be `redis` (needs `REDIS_URL`)                               |
| `SEARCH_SESSION_TTL_SECONDS`       | `600`                                                | 60–1800. Session lifetime; old name `SEARCH_CACHE_TTL_SECONDS` still accepted |
| `SEARCH_DEADLINE_MS`               | `8000`                                               | 500–14000. Budget per search / offer check, retries included                  |
| `SEARCH_PROVIDER_MAX_ATTEMPTS`     | `2`                                                  | 1–4. Attempts per provider call (transient failures only)                     |
| `SEARCH_PROVIDER_RETRY_BASE_MS`    | `200`                                                | 0–2000. Backoff base; cap is 8×                                               |
| `SEARCH_BREAKER_FAILURE_THRESHOLD` | `5`                                                  | 1–100. Consecutive failed calls that open a provider's breaker                |
| `SEARCH_BREAKER_COOLDOWN_SECONDS`  | `30`                                                 | 1–600. Open time before one trial call                                        |

With demo providers off and no live adapters (the production default), every
category answers `503` "search isn't available right now", and the web page
shows that state.

## Demo fixtures

| Category | Coverage                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Flights  | BLR, DEL, BOM, HYD, GOI; nonstops and one-stop connections (60–240 min layover); weekday schedules; return trips; economy, premium economy and business (no first class) |
| Hotels   | Goa, Jaipur, Bengaluru, Kochi; nightly rate × rooms × nights; rooms too small for the party excluded                                                                     |
| Trains   | SBC, MAS, NDLS, CSMT, SC, PUNE, JP; fictional "D"-numbered trains with class fares                                                                                       |
| Buses    | Bengaluru, Hyderabad, Chennai, Pune; fictional operators; boarding points                                                                                                |
| Metro    | Bengaluru Purple/Green and Delhi Yellow/Blue line stations (real line order), estimated times and fares, interchanges                                                    |
| Cabs     | Airport and city trips in Bengaluru, Delhi, Mumbai; formula-based price ranges by vehicle type                                                                           |
| Holidays | Kerala, Goa, Jaipur, Bali; 3–7 night packages with inclusions and interests                                                                                              |

Deterministic: no randomness and no clock-dependent prices; only
`validUntil` depends on the current time. Unmatched searches return no
results rather than invented ones.

## Web

### Results pages (`/flights` … `/holidays`)

`features/search/routes.tsx` composes:

| Piece                                     | Role                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `SearchForm` + `config.ts`                | Category fields, validated with the request contract; swap, counters                           |
| `results/SearchSummary`                   | One-line summary once a search runs, with **Edit search** (form reopens, Cancel returns focus) |
| `results/SearchResultsLayout`             | Data (via `useSearchResults`), layout and every state                                          |
| `results/FilterPanel`                     | Filter controls from config + facets; desktop sidebar and mobile sheet                         |
| `results/MobileFilterDrawer`              | "Filters (n)" button → `Sheet` (from `@wayora/ui`); "Show n results" closes, focus returns     |
| `results/ActiveFilterChips`               | One removable chip per active value, plus Clear all                                            |
| `results/SortControl`, `SearchPagination` | Sort (default labelled), pages                                                                 |
| `results/ProviderStatusNotice`            | Which demo providers answered; failed providers with a retry                                   |
| `results/SearchStates`                    | Card-shaped loading skeleton; empty (none / filtered / past last page); error with retry       |
| `cards/*ResultCard`                       | One card per category, sharing `ResultCardShell` (demo badge, price + basis, View details)     |
| `filters.ts`, `params.ts`, `summary.ts`   | URL codec for filters/sort/page, search params, summary text: typed and unit-tested            |
| `useSearchResults.ts`                     | React Query: keyed by the full request; keeps results visible while refining                   |

Only filters with choices in the current results are shown (from `facets`);
counts are shown next to options. The API does the filtering, sorting and
paging (over its stored round), so a filter change is one cheap request and
never a provider call within the session lifetime; identical requests are
also served from the client cache.

### URL state

```text
/flights?from=airport:BLR&to=airport:DEL&depart=2026-11-10&adults=2
        &airlines=KDA&stops=0&depart-times=morning&minPrice=5000&maxPrice=8000
        &maxDuration=180&sort=price-desc&page=2
```

- Search fields must be valid or nothing is searched (the problems are shown).
  Filters, sort and page are refinements: invalid values are dropped, the URL
  is tidied (history entry replaced) and a notice says so.
- Values are compact: lists comma-separated, prices whole currency units
  (sent as minor units), durations minutes, toggles `1`. Defaults (sort,
  page 1) are left out.
- History: a new search **pushes** an entry; filters and sort **replace** the
  current one; pages **push** (so Back steps through pages). Unrelated query
  parameters are kept. No personal data goes in the URL.
- A new search keeps the filters and sort but goes back to page 1.
- Requests are keyed by the full request, so a late answer can't replace a
  newer one, and a replaced request is aborted. While filters, sort or page
  change, the previous results stay visible (dimmed, `aria-busy`) with
  "Updating results…"; a new search shows the skeleton.
- After submitting, focus moves to the Results heading; result counts and
  loading changes are announced through a polite live region.

### Offer details

```text
/offers/:serviceType/:resultId?sid=<searchId>&from=<results query>
```

- The page validates the category and id, then reads the offer from the
  server (`GET …/sessions/:searchId/offer?id=`). The price and every detail
  come from the server's stored search, never from the URL or the results
  page.
- Category sections show only fields in the result. Things a traveller would
  expect but the source doesn't supply (baggage, fare rules, cancellation
  policy, seat availability, intermediate stops, timetables, step-free access,
  luggage space, exclusions, day-by-day itinerary) are listed as "Not provided
  in this offer".
- One state per API error code, each with a way forward:
  - **Expired** (`SEARCH_EXPIRED`, or no `sid`) and **not part of that
    search** (`OFFER_NOT_IN_SEARCH`): **Refresh this offer** re-runs the
    original search (from `from`) and looks the same id up in the new
    session; if it's no longer there, or the provider says it's gone, the
    page says so. A refresh that fails (provider down, network) shows why and
    can be tried again.
  - **Link that can't work** (`OFFER_NOT_FOUND`, `CATEGORY_MISMATCH`): a
    "Search <category>" button.
  - **Gone** (`OFFER_UNAVAILABLE`): back to results.
  - **Temporary** (`PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`,
    `SEARCH_FAILED`, `SERVICE_UNAVAILABLE`, `RATE_LIMITED`): the API's
    message, the request reference, **Try again** and back to results.
  - Network failures: "We couldn't load this offer" with **Try again**.
  - Invalid route parameters: "This offer link isn't valid" (the page's
    `<h1>`).
- **Nothing retries on its own** (offer and search queries have
  `retry: false`); every retry is a button press.
- **How current the price is** (`validation`): demo offers say "Not
  rechecked with any supplier; shown for this search until HH:MM"; a
  confirmed offer says when it was checked; a changed price shows a "The
  price has changed" alert with the old and new price.
- **Back to results** (and the breadcrumb) return to the category path plus
  the preserved `from` query (search, filters, sort, page). `from` is only
  ever used as query parameters on that fixed path, so it can't redirect
  elsewhere. Browser Back works too.
- Priced demo offers show **Book this demo offer**, a link to the demo
  checkout carrying only ids (`/book/:serviceType/:resultId?sid=&from=`;
  [bookings.md](bookings.md)). Live or unpriced offers say why they can't be
  booked.

### Expired results

When the session's `expiresAt` passes (`useExpired`, device clock), the
results page shows "These results have expired" (a polite status, not an
alert) with **Refresh results**, which re-runs the same search (new session).
Its offers could no longer be opened anyway; the server stays the authority.

### Demo labelling

Every results page has a "Demo data only" notice and a "Demo search" badge;
the provider notice names the demo providers; every card has a "Demo data"
badge, "Demo total"/"Demo estimate, not a quote" price labels and "Demo
offer: demo booking only."; offer pages repeat the disclaimer. Live results would
show none of these (driven by `source` and `disclaimer`).

## Adding a real supplier

1. Write an adapter in `apps/api/src/modules/providers/<supplier>/` with
   `kind: 'live'`, a stable `id`, `requiredConfig` naming its env vars, and
   `operations` declaring only what it implements.
2. Map the supplier's request and response to the shared contracts inside the
   adapter. Set `availability` only when the supplier reports it; never
   invent ratings or discounts. Provide a `dedupeKey` only if it is reliable.
3. Call only the supplier's fixed, configured endpoint (never URLs from
   requests), pass `signal`, and throw `ProviderError` with the right `kind`
   and `transient` flag (messages are logged, scrubbed, never shown).
4. Add its credentials to `apps/api/.env` (server only, never `VITE_*`) and
   register it in `app.ts` alongside or instead of `DEMO_PROVIDERS`.
5. Test it with recorded, sanitized fixtures; the search service tests show how
   to simulate timeouts and failures with test-only providers.
6. Implement `revalidate` (read-only price/availability check by
   `offerRef`) and declare `revalidate: 'supported'`; the offer endpoint then
   rechecks every offer it serves (see [Provider revalidation](#provider-revalidation)).
7. Set `timeoutMs` to the supplier's realistic latency and review the
   deadline, retry and breaker settings for it.

**Still needed before real bookings** (demo bookings exist since Phase 12;
real ones need): supplier
contracts and credentials in a secrets manager; revalidation immediately
before payment, with an explicit price-change confirmation step; a supplier
booking call that is never retried blindly (the demo flow's idempotency keys
are the model); orders and payments; supplier webhooks; per-supplier egress allow-lists; currency
conversion rules; and load testing of the breaker and retry settings against
real latencies.

## Tests

```bash
npm run test --workspace @wayora/contracts   # request/result validation
npm run test --workspace @wayora/api         # providers, orchestration, sessions, offers, API
TEST_REDIS_URL=redis://localhost:6379/15 npm run test --workspace @wayora/api   # + real Redis
npm run test --workspace @wayora/web         # results, filters, URL state, offer pages
```

- Contracts: valid requests for every category, missing fields, dates and
  ranges, party sizes, currencies, unsupported types, pagination, filters,
  result shapes.
- Providers: registration, enable/disable, determinism, filtering, empty
  results, normalization (every demo result validates).
- Orchestration (test-only stub providers in `apps/api/test`, no fault flags
  in production code): single, multiple, partial, all-failed, empty, timeout
  (including a provider that ignores aborts), invalid output and
  impersonation, de-duplication, filters/sort/paging, currencies, bounded
  concurrency, cache, abort, demo labelling.
- Filtering and sorting (`apps/api/test/search-refine.test.ts`, on the real
  demo fixtures): every filter per category, combined filters, filters that
  eliminate everything, price both ways, duration, departure, flights
  `recommended`, missing prices last in both directions, deterministic ties,
  facets per category, empty facets.
- API: every category end to end, status codes, production default, disabled
  providers, rate limit, `Origin` check, `/providers` safety; offer lookup
  (beyond the page, unknown/expired/wrong category, validation, partial
  rounds readable but not reused, not rate-limited), facets independent of
  filters.
- Sessions (`search-sessions.test.ts`, fake Redis with a controllable clock):
  key names and TTLs, nothing about the request stored, restart and second
  instance, expiry, missing sessions, concurrent searches, malformed and
  tampered entries (deleted and logged), Redis down (503, no fallback, no
  details, providers not called), failed writes, clock skew; memory store
  expiry and eviction. `search-sessions-redis.test.ts` repeats the restart,
  TTL (`PTTL`, real expiry), cross-instance concurrency and unreachable-Redis
  cases against a real Redis when `TEST_REDIS_URL` is set (unique key prefix,
  cleaned up; required in CI).
- Offers (`search-offers.test.ts`): revalidation confirmed / price changed
  (session updated) / unavailable / timeout / invalid answers; supplier
  errors with credentials, URLs and bodies never reach responses or logs
  (logs keep `requestId` and `providerId`); scrubbing; exact price
  comparison. `search-api.test.ts`: every offer error code in order, tampered
  query parameters rejected, `validation` on demo offers, error codes for
  total failure, production store guard, environment rules.
- Resilience (`search-resilience.test.ts`): backoff bounds, transient vs
  permanent vs unknown errors, non-idempotent never retried, per-attempt
  timeout and deadline, no backoff past the deadline, abort during backoff,
  breaker closed → open → half-open → closed/open with a fake clock, trial
  slot release, provider isolation, retries logged with the request id.
- Web (`search.test.tsx`, `search-filters.test.ts`, `offers.test.tsx`): every
  service page; validation, submission, summary, edit/cancel focus;
  restoration of search, filters and sort; invalid links and tidied
  refinements; loading, empty, filtered-empty, error, network, partial and
  retry; results kept while refining; cancellation of replaced searches;
  facet-driven filter options; filters, chips, chip removal, clear all,
  price-range validation; default sort labelling; paging and Back; the mobile
  filter sheet; a card per category; URL codec units; offer pages from cards
  and back with context, server price, category details and "not provided"
  fields, invalid links, expiry and refresh, refresh miss, network retry,
  `from` safety; Phase 11: an error state per offer code, no automatic
  retries, refresh failures, demo "not rechecked" note, changed and
  confirmed prices, provider-failure messages on results, expired results
  with refresh.

## Limitations and future work

- Demo data only; no live suppliers, so no real revalidation (the flow
  exists and is tested with a test-only adapter); bookings are demo bookings
  ([bookings.md](bookings.md)).
- The place directory is a fixed list sized to the demo; no free-text place
  search or geocoding (metro and cabs don't accept coordinates).
- No currency conversion: demo prices are INR; other display currencies show
  a "not converted" note.
- Metro has no timetable (journey times are estimates, no departure times).
- Sessions need Redis outside local development; if Redis is down, search
  answers 503 (by design, no in-memory fallback).
- `OFFER_NOT_IN_SEARCH` can't tell "from another live search" from "never
  existed" (sessions aren't indexed by offer).
- Circuit breakers are per API process, not shared between instances.
- The "results expired" notice uses the device clock.
- Facets and filters cover the fields the contracts have; there are no
  ratings, images, accessibility or baggage data, so no filters or details
  for them.
- No side-by-side comparison view or result-density toggle; the cards are
  designed to be compared in the list.
- Pagination is numbered pages (no infinite scroll); no virtualization, which
  the result volumes don't need.
