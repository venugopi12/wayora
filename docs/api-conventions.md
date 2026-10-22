# API conventions

All endpoints live under a version prefix: **`/api/v1`**. Schemas for every
request and response are Zod contracts in `packages/contracts`, shared by the
API (validation) and the web app (runtime response checking).

## Versioning

- Additive changes (new endpoint, new optional field, new error code) stay in `v1`.
- Breaking changes (removing or renaming a field, changing a type or meaning) go
  into a new `/api/v2` router mounted alongside `v1`. `v1` keeps working until
  clients have migrated.
- Clients must ignore unknown fields.

## Response envelopes

**Success (2xx):**

```json
{
  "data": { "...": "..." },
  "meta": { "requestId": "0b6c…" }
}
```

**Error (4xx/5xx):**

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request is invalid.",
    "requestId": "0b6c…",
    "details": [
      { "path": "query.availability", "message": "Invalid option…", "code": "invalid_value" }
    ]
  }
}
```

- `code` is machine-readable and stable. Clients branch on `code`, never on `message`.
- `message` is human-readable and safe to display. Internal details are never exposed
  for 5xx errors outside `NODE_ENV=development`.
- `details` appears only for validation errors. `path` is prefixed with the request
  part: `params.`, `query.` or `body.`.

Use `sendData(res, data, status)` and throw `AppError` (or let validation throw).
Never call `res.json()` with an ad-hoc shape.

## Error codes

| Code                  | HTTP | When                                                         |
| --------------------- | ---- | ------------------------------------------------------------ |
| `BAD_REQUEST`         | 400  | Malformed request not covered below                          |
| `VALIDATION_FAILED`   | 400  | Params/query/body failed schema validation                   |
| `INVALID_JSON`        | 400  | Body is not parseable JSON                                   |
| `UNAUTHENTICATED`     | 401  | Missing/invalid credentials (from the auth phase)            |
| `FORBIDDEN`           | 403  | Authenticated but not allowed                                |
| `NOT_FOUND`           | 404  | Unknown route or resource                                    |
| `CONFLICT`            | 409  | State conflict, idempotency key reuse with a different body  |
| `PAYLOAD_TOO_LARGE`   | 413  | Body over 100 kB                                             |
| `RATE_LIMITED`        | 429  | Rate limit exceeded; see `RateLimit` / `Retry-After` headers |
| `SERVICE_UNAVAILABLE` | 503  | A required dependency is down                                |
| `INTERNAL_ERROR`      | 500  | Unexpected failure (logged with the request ID)              |

Search and offers (details in [search.md](search.md#errors)):

| Code                   | HTTP | When                                                     |
| ---------------------- | ---- | -------------------------------------------------------- |
| `SEARCH_EXPIRED`       | 410  | The search session expired, is unknown or unreadable     |
| `OFFER_NOT_FOUND`      | 404  | The offer id can't be a Wayora offer                     |
| `OFFER_NOT_IN_SEARCH`  | 404  | The offer isn't part of the named search                 |
| `CATEGORY_MISMATCH`    | 409  | The category doesn't match the search or the offer       |
| `OFFER_UNAVAILABLE`    | 410  | The provider reports the offer gone                      |
| `PROVIDER_TIMEOUT`     | 504  | Providers didn't answer in time                          |
| `PROVIDER_UNAVAILABLE` | 503  | Providers are unavailable (outage, open circuit breaker) |
| `SEARCH_FAILED`        | 502  | Providers failed for other reasons                       |

Demo bookings (details in [bookings.md](bookings.md#errors)):

| Code                      | HTTP | When                                                    |
| ------------------------- | ---- | ------------------------------------------------------- |
| `PRICE_CHANGED`           | 409  | The price the visitor accepted isn't the server's price |
| `BOOKING_NOT_CANCELLABLE` | 409  | Already cancelled, failed, or the trip has started      |
| `IDEMPOTENCY_IN_PROGRESS` | 409  | The same `Idempotency-Key` is still being processed     |
| `IDEMPOTENCY_KEY_REUSED`  | 422  | The `Idempotency-Key` was used with a different body    |

## Validation

Handlers validate with `validateRequest`, which returns typed, parsed values and
reports all failing fields at once:

```ts
router.get('/categories/:slug', (req, res) => {
  const { params } = validateRequest(req, { params: categoryParamsSchema });
  // params.slug is typed as TravelCategorySlug
});
```

- Query schemas use `.strict()` so unknown parameters are rejected rather than ignored.
- JSON bodies are limited to 100 kB.
- Express 5 forwards errors thrown in async handlers to the error middleware; no wrapper needed.

## Request IDs and logging

- Every response carries `X-Request-Id`. A well-formed inbound value (8–128 chars of
  `A-Z a-z 0-9 . _ : -`) from a load balancer is reused; otherwise a UUID is generated.
- The same ID is in the response `meta`/`error`, in every log line for that request
  (`requestId`), and should be quoted in support conversations.
- Logs are structured JSON (pino). Authorization headers, cookies and fields such as
  `password`, `token`, `cardNumber` and `cvv` are redacted.

## Health endpoints

| Endpoint                   | Use                        | Behaviour                                                           |
| -------------------------- | -------------------------- | ------------------------------------------------------------------- |
| `GET /api/v1/health`       | Liveness probe             | 200 whenever the process can serve HTTP. Never touches dependencies |
| `GET /api/v1/health/ready` | Readiness probe, status UI | Probes dependencies in parallel with a timeout each                 |

Readiness `status`:

| Status     | HTTP | Meaning                                                   |
| ---------- | ---- | --------------------------------------------------------- |
| `ready`    | 200  | Every essential dependency is up                          |
| `degraded` | 200  | Essentials are up; an optional dependency (Redis) is down |
| `unready`  | 503  | An essential dependency (PostgreSQL) is down              |

Dependency `state` is `up`, `down` or `disabled` (intentionally not configured).
Health endpoints are exempt from rate limiting and are not access-logged.

## Rate limiting

- Applies to `/api/*` except health. Default 120 requests per minute per client IP.
- Responses include IETF draft-8 `RateLimit` and `RateLimit-Policy` headers.
- Counters live in Redis so limits hold across API instances. If Redis is down the
  API falls back to per-process memory counters: limiting continues, it is not disabled.
- Behind a proxy, set `TRUST_PROXY` so client IPs are read correctly.
- Extra limits: searches per IP (`SEARCH_RATE_LIMIT_MAX`), sign-in attempts
  (docs/auth.md), and booking writes per signed-in user (`BOOKING_RATE_LIMIT_MAX`).

## CORS

Only origins listed in `CORS_ORIGIN` receive CORS headers. Credentials are allowed
for those origins (ready for cookie sessions). Allowed request headers:
`Content-Type`, `Authorization`, `Idempotency-Key`, `X-Request-Id`. Exposed
response headers: `X-Request-Id`, `RateLimit`, `RateLimit-Policy`, `Retry-After`,
`Idempotent-Replayed`.

## Conventions for new endpoints

- Paths: plural nouns, kebab-case (`/booking-items`), IDs as path params.
- JSON fields: camelCase. Timestamps: ISO 8601 UTC strings (`2026-10-20T03:15:45.636Z`).
- Money: `{ "amountMinor": "149950", "currency": "INR" }`, an integer string in minor
  units plus an ISO 4217 code (`moneySchema`). Never floats.
- Lists: search results and bookings use numbered pages (`?page=&pageSize=`,
  with a `pagination` object), because their UIs page by number and the lists
  are small per user. Cursor pagination (`?cursor=&limit=`, `meta.nextCursor`)
  remains the plan for large or fast-changing lists.
- Mutating endpoints that create money-relevant state (bookings, orders, payments) must
  require an `Idempotency-Key` header, backed by the `idempotency_keys` table
  (`POST /bookings` is the reference implementation: bookings.md#idempotency).
