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

## CORS

Only origins listed in `CORS_ORIGIN` receive CORS headers. Credentials are allowed
for those origins (ready for cookie sessions). Allowed request headers:
`Content-Type`, `Authorization`, `Idempotency-Key`, `X-Request-Id`.

## Conventions for new endpoints

- Paths: plural nouns, kebab-case (`/booking-items`), IDs as path params.
- JSON fields: camelCase. Timestamps: ISO 8601 UTC strings (`2026-10-20T03:15:45.636Z`).
- Money: `{ "amountMinor": "149950", "currency": "INR" }`, an integer string in minor
  units plus an ISO 4217 code (`moneySchema`). Never floats.
- Lists (from the first paginated endpoint): cursor pagination with
  `?cursor=&limit=` and `meta.nextCursor`.
- Mutating endpoints that create money-relevant state (orders, payments) must accept an
  `Idempotency-Key` header, backed by the `idempotency_keys` table.
