# API domain modules

The API is a **modular monolith**: one deployable, many domain modules with
hard boundaries. Each module owns its routes, service logic, and (later) its
data access. Modules talk to each other only through exported service
functions — never by importing another module's internals or querying another
module's tables directly.

## Module layout

```text
modules/<domain>/
├── <domain>.routes.ts    # HTTP layer: validation + response shaping only
├── <domain>.service.ts   # business logic, framework-agnostic
├── <domain>.repository.ts# (when needed) Prisma access for this module's tables
└── index.ts              # (when needed) the module's public surface
```

Request/response schemas live in `@wayora/contracts` so the web app shares them.

## Status

| Module          | Path                    | Phase 1 status                                        |
| --------------- | ----------------------- | ----------------------------------------------------- |
| system (health) | `modules/system`        | **Implemented** — liveness and readiness              |
| catalog         | `modules/catalog`       | **Implemented** — example module, travel categories   |
| identity        | `modules/identity`      | Planned — users, travellers, authentication, sessions |
| flights         | `modules/flights`       | Planned — search, fare rules, PNR                     |
| hotels          | `modules/hotels`        | Planned — inventory, rate plans                       |
| trains          | `modules/trains`        | Planned — availability, class, PNR status             |
| buses           | `modules/buses`         | Planned — operators, seat layouts                     |
| metro           | `modules/metro`         | Planned — city tickets                                |
| cabs            | `modules/cabs`          | Planned — quotes, dispatch                            |
| holidays        | `modules/holidays`      | Planned — packages, itineraries                       |
| orders          | `modules/orders`        | Planned — orders, bookings, idempotency               |
| payments        | `modules/payments`      | Planned — PSP integration, webhooks, refunds          |
| notifications   | `modules/notifications` | Planned — email/SMS/push via worker jobs              |

Planned modules intentionally have no code yet: placeholder endpoints would be
fake functionality. See `docs/architecture.md` for the boundaries each one owns
and how to add one.
