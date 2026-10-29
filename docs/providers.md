# Travel providers and live inventory readiness (Phase 22)

**Where things stand:** Wayora has **no live travel supplier integrated**.
Every search result in every category comes from Wayora's labelled demo
providers. Nothing in this repository calls a real airline, hotel, rail, bus,
metro, cab or holiday supplier. No real inventory is shown, nothing is
reserved, no ticket or PNR is issued, and no money moves.

Phase 22 makes the codebase **ready** for a first supplier without inventing
one. It adds:

- a supplier toolkit: HTTP, credentials and exact money conversion
- optional normalized fields for supplier detail: flight fare and baggage, hotel cancellation policy
- per-call observability
- provider health in the admin dashboard
- honest supplier labels in the web app
- a checkout that refuses supplier offers

All of it is tested end to end through a **test-only fictional supplier**.
No real supplier's API was available to build against: there was no
documentation, sandbox or credentials. Writing an adapter from guessed
endpoints would have produced code that looks finished and isn't, so none was
written.

Related: [search.md](search.md) (search, sessions, offer validation,
resilience), [bookings.md](bookings.md), [admin.md](admin.md#platform-health),
[security.md](security.md).

## Architecture

```
web ──► POST /api/v1/search/:type ──► SearchService ──► ProviderRegistry
                                         │                 ├─ live adapters   (createLiveProviders: none yet)
                                         │                 └─ DEMO_PROVIDERS  (labelled fixtures)
                                         ├─ resilience: deadline, per-call timeout,
                                         │   retries (reads only, backoff + full jitter),
                                         │   circuit breaker per provider
                                         ├─ validation of every result against the contracts
                                         ├─ search session (server-side, expires)
                                         └─ search_events (per-provider outcome, duration, attempts)

GET /search/:type/sessions/:id/offer ──► stored result ──► provider.revalidate (if supported)
POST /bookings ──► refuses any result whose source isn't 'demo'
```

All of this is one module inside the API (`apps/api/src/modules/providers`),
not a separate service. A supplier is one adapter file that implements
`SearchProvider` ([search.md#adapters](search.md#adapters)) using the
toolkit below.

| File                                | What it is                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `providers/provider.ts`             | The `SearchProvider` interface and `ProviderError` (Phase 9)                                     |
| `providers/registry.ts`             | Registration; disables providers that are unconfigured, switched off, or demo with demo data off |
| `providers/live/index.ts`           | `createLiveProviders(config)`: where real adapters are registered. **Returns `[]` today**        |
| `providers/http.ts`                 | `ProviderHttpClient`: JSON over HTTPS with safe error mapping                                    |
| `providers/credentials.ts`          | `readProviderConfig`, `ProviderSecret`: server-side settings and secrets that can't leak         |
| `providers/normalize.ts`            | `supplierMoney`, `currencyDigits`: exact decimal-to-minor-unit conversion                        |
| `providers/demo/*`                  | Demo adapters (labelled fixtures, `kind: 'demo'`)                                                |
| `apps/api/test/fixture-supplier.ts` | **Test-only** fictional supplier ("Fixture Air", `.test` domain) and its fake server             |

## Categories and providers

| Category | Real supplier API | What serves results        | Revalidation         | Booking through Wayora |
| -------- | ----------------- | -------------------------- | -------------------- | ---------------------- |
| Flights  | None              | `demo-flights` (fixtures)  | Not supported (demo) | Demo booking only      |
| Hotels   | None              | `demo-hotels` (fixtures)   | Not supported (demo) | Demo booking only      |
| Trains   | None              | `demo-trains` (fixtures)   | Not supported (demo) | Demo booking only      |
| Buses    | None              | `demo-buses` (fixtures)    | Not supported (demo) | Demo booking only      |
| Metro    | None              | `demo-metro` (fixtures)    | Not supported (demo) | Demo booking only      |
| Cabs     | None              | `demo-cabs` (estimates)    | Not supported (demo) | Demo booking only      |
| Holidays | None              | `demo-holidays` (fixtures) | Not supported (demo) | Demo booking only      |

`GET /api/v1/providers` lists what is registered at runtime, with `kind`,
operations and why a provider is disabled.

**Supported booking operations with a supplier: none.** Every adapter
declares `book: 'unsupported'`. The booking API refuses any offer whose
`source` isn't `demo` (`503 SERVICE_UNAVAILABLE`, "Booking this offer isn’t
available yet."). It creates no booking row and no reference, and makes no
supplier call. The web checkout shows the same refusal before asking for any
details.

## Features still using demo data

- Search results, prices and availability in all seven categories.
- Offer details, including flight segments, hotel rooms and holiday inclusions.
- Bookings: demo bookings, with no supplier reservation, ticket or PNR ([bookings.md](bookings.md)).
- Payments: a demo payment provider, unless a real one is configured ([payments.md](payments.md)).
- Trip status and disruptions: simulated ([trips.md](trips.md)).
- The travel assistant: rule-based demo answers unless an AI provider is configured ([assistant.md](assistant.md)).
- Destination content: curated, not supplier data ([discover.md](discover.md)).

## Supplier toolkit

### HTTP (`ProviderHttpClient`)

```ts
const http = new ProviderHttpClient({ providerId: 'acme-air' });
const { body } = await http.requestJson({
  url: `${config.ACME_BASE_URL}/v2/offers`, // from configuration only, never from a request
  query: { from: 'BLR', to: 'DEL' },
  headers: { authorization: `Bearer ${config.ACME_API_KEY.reveal()}` },
  signal, // from the search service: per-attempt timeout and client disconnects
  acceptStatuses: [404], // optional: statuses the adapter handles itself
});
```

- **Status mapping**:
  - 408, 425, 429, any 5xx, and dropped connections → `unavailable`, transient (eligible for a retry).
  - 401 and 403 → `error`, not transient (credentials).
  - Other 4xx → `error`, not transient (a request the supplier rejects).
- **Body handling**:
  - Error bodies are never read.
  - Successful bodies must be JSON and within a size limit (2 MB by default). Otherwise → `error`.
  - Malformed JSON → `error`.
- **Redirects** are refused (`redirect: 'error'`).
- **Messages** carry only the provider id, method, path and status. They never include the query
  string, headers, credentials or the supplier's text. They are logged after scrubbing and never
  shown to users: clients get fixed wording per error code
  ([search.md#errors](search.md#errors)).
- **No retries**: the client never retries by itself. The search service retries only transient
  failures of read operations (`search`, `revalidate`).

### Configuration and credentials

```ts
const SPEC = { plain: ['ACME_BASE_URL'], secret: ['ACME_API_KEY'] } as const;
const config = readProviderConfig(SPEC, process.env, { requireHttps: true }); // null if incomplete
// requiredConfig: requiredNames(SPEC)
```

- Settings come from the **API's environment only**. Never put them in `VITE_*` variables: those
  end up in the browser bundle.
- `apps/api/.env.example` lists names with **empty placeholders**. It holds no values and none are
  committed.
- A provider whose required setting is missing or blank is **disabled** ("Not configured."). The API
  still starts: suppliers are optional.
- URL settings (`*_URL`, `*_BASE_URL`, `*_ORIGIN`) must be absolute `http(s)` URLs with no embedded
  user or password. Use `requireHttps` in production.
- Secrets are wrapped in `ProviderSecret`. JSON, string conversion and `util.inspect` all print
  `[redacted]`. Only `reveal()`, at the point of building a header, returns the value. The logger
  also redacts `authorization` headers and key fields.

### Normalization

- **Money**:
  - `supplierMoney(amount, currency)` converts a decimal string (`"4520.50"`) or a safe integer into
    integer minor units, using the currency's own digits (INR 2, JPY 0, KWD 3).
  - It uses string and BigInt arithmetic, never `Number * 100`.
  - It refuses (returns `null`) floats, exponents, negatives, more non-zero decimals than the
    currency has, and codes that aren't known ISO currencies.
  - A refused amount means the offer is **dropped and counted** (`INVALID_PROVIDER_RESULTS`),
    never rounded.
- **Currency**: prices stay in the supplier's currency. Wayora has no FX rates, so nothing is
  converted, and results in different currencies are never merged, summed or compared as one
  (`CURRENCY_NOT_CONVERTED`).
- **Ids**:
  - Result ids are `<providerId>:<offerRef>`.
  - The server looks offers up only in its own stored search session. Ids, prices and
    availability sent by the browser are never trusted.
  - An id naming an unknown provider is `OFFER_NOT_FOUND`. An id not in that search is
    `OFFER_NOT_IN_SEARCH`.
- **Validation**: adapters validate the supplier's payload with a schema before mapping it. The
  search service then validates every mapped result against the shared contracts. Anything that
  fails either check is dropped, never repaired.
- **Missing fields stay missing.** The contracts gained optional supplier-only fields:
  - flights: `fare { name, refundable, changeable, checkedBaggage, cabinBaggage }`, where a
    baggage allowance has `pieces` and/or `weightKg`, and each unknown is `null`;
  - hotels: `cancellationPolicy` (`free-cancellation` until a deadline with an offset, or
    `non-refundable`).

  Demo providers never set these. The offer page shows "Not provided in this offer" for any
  missing field.

## Offer validation and revalidation

Unchanged from Phase 11 ([search.md#offer-validation](search.md#offer-validation)), now exercised
with a live adapter in tests.

- **Offer lookup**: the offer endpoint reads the result from the stored session. An expired session
  answers `SEARCH_EXPIRED`.
- **Providers with `revalidate`**: the offer is rechecked read-only at that moment, with one of
  these outcomes:
  - `confirmed`;
  - `price-changed`, with the previous price kept and shown;
  - `OFFER_UNAVAILABLE`, when the supplier says the offer is gone;
  - `PROVIDER_UNAVAILABLE`, when the answer is inconsistent (for example, a different currency).
- **Providers without `revalidate`** (all demo providers): the page says the price was "not
  rechecked" and is "shown for this search until …".
- **Price changes during booking**: a booking must carry the price the user accepted
  (`acceptedPrice`). A different server price is `PRICE_CHANGED`, so the user confirms again.
- **Snapshot**: the booking stores an immutable `offerSnapshot`.
- **Supplier offers**: none of this applies yet, because they are refused before booking (above).

## Failures, retries and health

- **Timeouts, retries and breakers** ([search.md](search.md#timeouts-retries-and-circuit-breakers)):
  - Each attempt has the provider's `timeoutMs`, inside the search deadline.
  - Transient failures of reads are retried (`SEARCH_PROVIDER_MAX_ATTEMPTS`) with exponential
    backoff and full jitter.
  - A circuit breaker per provider pauses calls after repeated failures.
  - Booking and payment calls are never retried blindly; no supplier booking call exists.
- **Error codes for users**:
  - `PROVIDER_TIMEOUT` (504);
  - `PROVIDER_UNAVAILABLE` (503: temporarily unavailable);
  - `SEARCH_FAILED` (502: unusable answer, or credentials refused);
  - `SERVICE_UNAVAILABLE` (no provider enabled);
  - partial results with `PARTIAL_RESULTS` when some providers failed.
- **Logs**:
  - One `Provider call finished` line per provider call.
  - Fields: `providerId`, `kind`, `serviceType`, `operation` (`search`/`revalidate`), `outcome`,
    `durationMs`, `attempts`, `resultCount`, `invalidCount`, plus the request's `requestId`.
  - Never logged: credentials, request parameters, traveller data or supplier payloads.
  - At start-up the API logs which providers are registered and enabled, by id and kind.
- **Analytics**: `search_events.providers` (existing jsonb column, no migration) now records
  `attempts` per provider next to status and duration.
- **Admin → Platform health → Search providers** shows each provider's:
  - kind (Demo/Supplier), categories, enabled state or reason;
  - circuit breaker state;
  - calls and failures in the last hour.

  Status rules:
  - not enabled → "Not configured";
  - breaker open → "Down";
  - breaker half-open → "Degraded";
  - **no calls in the last hour → "Unknown"**, never "Up";
  - any failures → "Degraded";
  - otherwise "Up".

  Breaker state is per API process ([search.md#limitations-and-future-work](search.md#limitations-and-future-work)).

## Web labelling

- **Results from a supplier** carry a plain "Supplier offer" badge. They have:
  - no logo, "live" pulse or "real-time" wording;
  - a footer that says "Supplier price, may change. Can’t be booked on Wayora yet.".
- **Demo results** keep the "Demo data" badge, demo totals and the demo disclaimer. Mixed results
  label each card separately.
- **The offer page** shows:
  - fare type, checked and cabin baggage, change and refund rules, and hotel cancellation policy
    when the supplier sent them, otherwise "Not provided in this offer";
  - how current the price is ("not rechecked …" or "Checked with the provider at …");
  - for supplier offers, that booking isn't available.
- **States**:
  - expired search, offer gone, price changed, provider temporarily unavailable, no results;
  - no provider available, partial results.

  Each keeps its own wording ([search.md#web](search.md#web)).

## Adding a real supplier

Before writing code, you need from the supplier:

- **Commercial access**: a signed agreement, and API credentials for a **sandbox** and later
  production.
- **Their API documentation**: authentication scheme, endpoints, request and response schemas,
  error codes, rate limits, offer expiry and revalidation (or price-check) semantics.
- **Booking rules**, if bookings are in scope: order creation, ticketing, cancellation,
  idempotency, webhooks. Booking is **out of scope** until these, real payments and a
  reconciliation process exist ([search.md#adding-a-real-supplier](search.md#adding-a-real-supplier)).

Then:

1. Create `apps/api/src/modules/providers/live/<supplier>.ts` exporting `create<Supplier>Provider(config)`.
   - Use `readProviderConfig` with a spec of the supplier's settings (for example
     `<SUPPLIER>_BASE_URL`, `<SUPPLIER>_API_KEY`) and `requireHttps` in production.
   - Use `ProviderHttpClient` for every call.
   - Set `kind: 'live'`, a stable `id`, the `serviceTypes` it really covers, a realistic
     `timeoutMs`, `requiredConfig: requiredNames(spec)`, and `operations` with
     `book: 'unsupported'`.
2. Validate the supplier payload with a zod schema, then map it to the contracts:
   - `source: 'live'`, `id: '<providerId>:<offerRef>'`, `validUntil` from the supplier's offer
     expiry;
   - money via `supplierMoney`;
   - fare, baggage and cancellation fields only when sent. Drop offers you can't map.
3. Implement `revalidate` if the supplier has a price check, and declare `revalidate: 'supported'`.
4. Register it in `createLiveProviders` (`providers/live/index.ts`).
5. Add empty placeholders for its settings to `apps/api/.env.example`, document them here, and set
   real values only in the deployment's secret store.
6. Test it like `apps/api/test/live-providers.test.ts`:
   - use recorded, **sanitized** sandbox fixtures served by a fake `fetch`;
   - cover mapping, normalization, missing configuration, invalid answers, timeouts, transient
     failures and retries, error mapping, expiry, price and availability changes, currency and ids.

   Run it against the sandbox manually before enabling it anywhere.

7. Update the categories table above and [deployment.md](deployment.md). Turn demo providers off
   (`SEARCH_DEMO_PROVIDERS=false`) only where real coverage replaces them.

## Testing

| Test file                                          | What it covers                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/test/live-providers.test.ts`             | HTTP status mapping, query and headers, non-JSON, malformed, oversized and cut-off answers, aborts; configuration (missing, blank, unsafe URLs) and secret redaction; money conversion; no live provider registered; the fixture supplier through search (mapping, normalization, labels, logs, invalid offers, currencies, retry, 401, 503, timeout, HTML, mixed results) and offer checks (confirmed, price changed, other currency, gone, ids, categories, expiry) |
| `apps/api/test/integration/live-providers.test.ts` | A live offer is never booked (no row, no reference, no supplier call); admin health per provider: unknown → up → degraded → down (breaker open) → not configured                                                                                                                                                                                                                                                                                                      |
| `packages/contracts/test/search.test.ts`           | The optional fare, baggage and cancellation fields                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `apps/web/test/offers.test.tsx`                    | Supplier vs demo labels on cards (alone and mixed), supplier fare terms and cancellation deadline on the offer page, no booking link                                                                                                                                                                                                                                                                                                                                  |
| `apps/web/test/bookings.test.tsx`                  | Checkout refuses a supplier offer before asking for details                                                                                                                                                                                                                                                                                                                                                                                                           |
| `apps/web/test/admin.test.tsx`                     | The Search providers health table (demo labelled, unknown when there are no calls)                                                                                                                                                                                                                                                                                                                                                                                    |

The fixture supplier is fictional: it is never registered by the app, uses the reserved `.test`
domain, and its "credentials" are test strings. It proves the plumbing, **not** compatibility with
any real supplier.

## Limitations

- No live inventory, real booking, payment processing or ticket issuance via a supplier.
- No FX conversion; supplier currencies are shown as sent.
- Breaker state and "calls in the last hour" come from this API process's breakers and from
  `search_events` (best-effort writes). With several API instances, breaker state can differ
  between them.
- Provider health is derived from real calls only. There is no synthetic probe, because a probe
  would cost supplier quota and could mislead.
- No per-supplier egress allow-list yet; deploy-time network policy should restrict outbound
  hosts once a supplier exists.
