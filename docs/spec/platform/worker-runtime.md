# Worker runtime: contract-mounted request guard

Status: planned before domain implementation.
Vocabulary follows [CONTEXT.md](../../../CONTEXT.md).

## Problem

Several Splitch Workers need the same HTTP edge behavior: request IDs, Zod parsing, principal
resolution, scope checks, rate-limit class selection, idempotency header handling, and
`ErrorResponse` rendering. If each Worker hand-writes that chain, the first implementation can ship
fast but the seams will drift: a new endpoint can have a Zod route definition yet miss scope checks,
use a different error status, or skip a rate-limit class.

`@splitch/contracts` already owns the authored route schemas. That route contract must also become
load-bearing at runtime.

## Decision

Add an internal package:

```
packages/worker-runtime/   @splitch/worker-runtime
```

`@splitch/worker-runtime` mounts route contracts from `@splitch/contracts` onto Hono apps through one
request guard. The package is shared plumbing, not a new capability boundary.

## Route contract metadata

Each route contract in `@splitch/contracts` carries:

| Field              | Meaning                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `id`               | Stable route identifier for tests, MCP/CLI derivation, and guard assertions                                             |
| `owner`            | Owning deploy unit: `control-plane-api`, `evaluation-api`, `event-ingest-api`, `analysis-api`, or `auth-api`            |
| `method`           | HTTP method                                                                                                             |
| `path`             | Canonical path template                                                                                                 |
| `input`            | Zod request schema for params, query, headers, and body                                                                 |
| `output`           | Zod success response schema                                                                                             |
| `auth`             | Auth requirement: public, control-plane token, Client Key, API Key, internal Worker, or mixed data-plane key            |
| `scopes`           | Required control-plane scopes, empty for public/data-plane routes                                                       |
| `rateLimit`        | Rate-limit class, such as `none`, `control-plane-actor`, `client-key`, `api-key`, or `anonymous-registration`           |
| `idempotency`      | `none`, `optional`, or `required`                                                                                       |
| `rawBodyByteLimit` | Optional raw UTF-8 byte cap. Mutating JSON routes get 32 KiB (public/data-plane) or 1 MiB (control-plane) when omitted. |
| `errors`           | Allowed `ErrorCode` values for the route                                                                                |

Contracts stay pure: schemas, metadata, inferred types, and route definitions only. They do not
import Hono app instances, repositories, Cloudflare bindings, or runtime helpers.

## Request guard

The registrar API is conceptually:

```typescript
createRegistrar(deps).mount(contract, handler);
```

`deps` contains Worker-local adapters:

- auth resolvers for the auth kinds the Worker actually mounts
- Cloudflare rate-limit bindings or edge-control helpers used by that Worker
- optional repository/data-access resolver owned by that Worker
- observability hooks and default response headers

The guard order is fixed for every mounted route:

1. Attach request ID and observability context.
2. Enforce a raw-body byte limit before buffering or parsing JSON. Mutating
   routes use the contract's `rawBodyByteLimit` when present (including a
   smaller or larger explicit cap). Otherwise the registrar applies 32 KiB for
   untrusted/public/data-plane writes and 1 MiB for `control-plane-token`
   writes, so Flag Configuration bodies that are already schema-legal above
   32 KiB still parse. An oversized `Content-Length` is rejected without
   reading the body; an oversized chunked body stops during the stream. GET
   routes do not buffer a body. No mutating registrar route silently opts into
   an unbounded buffer.
3. Parse params, query, headers, and body with the route contract's Zod schemas.
4. Resolve the principal through the Worker-provided auth resolver.
5. Apply the route's rate-limit class. Missing or throwing rate-limit bindings fail closed for guarded routes.
6. Enforce scopes and `app_id` / `environment_id` co-scope where the contract requires them.
7. Validate idempotency headers for mutating routes. Durable idempotency claims remain in the owning data-access layer.
8. Call the route handler with parsed input and the resolved principal.
9. Render guard failures through the shared `ErrorResponse` shape and status map.

Rate limits run before scope checks so floods of unauthorized-but-authenticated requests are still
throttled. Route handlers do not render ad hoc guard errors and do not choose HTTP statuses for
shared error codes.

The Event Ingest Worker additionally owns a weighted Ingest Admission Gate after canonical event
validation and idempotency lookup but before new claims or queue publication. That gate charges
canonical row count and serialized bytes by `(app_id, environment_id, ingest_stream)`. It cannot use
the generic route `RateLimiter`, which runs before the request has canonical rows and exposes no
weighted cost or one strongly coordinated counter across Cloudflare locations. Event Ingest
implements the gate as one SQLite Durable Object per scope with atomic row and byte token buckets.
Both gates must pass; this capability-specific control and its binding stay in Event Ingest and do
not move queue or Tinybird ownership into `@splitch/worker-runtime`.

## What the runtime owns

- Hono path mounting from route contracts
- Zod request parsing at the HTTP edge
- Auth resolver dispatch and principal typing
- Scope and App/Environment co-scope enforcement
- Route-declared rate-limit class application
- Idempotency header validation and replay hook plumbing
- Shared `ErrorResponse` status mapping and JSON response helpers
- Request ID propagation and safe default headers (`X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`). The registrar always merges this
  baseline; `wrapWorkerHandler` stamps it on every Worker fetch response. Existing
  CORS, session, redirect, and route-specific security headers are never overwritten.

## What the runtime does not own

- Organization, App, Flag, Experiment, Run, Metric, or Segment invariants
- Provider resolution, Assignment Store reads/writes, Exposure creation, or Tinybird delivery
- D1, KV, Durable Object, Queue, or Tinybird bindings
- Repository query construction or transaction boundaries
- MCP protocol handling or tool derivation
- Control Panel SSR loaders or TanStack Query state
- Marketing routes

Handlers stay inside their owning capability Worker. The runtime wraps handlers; it does not become
a service layer.

## Worker participation

| Worker                   | Uses runtime for                                                                      | Keeps local                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Control Plane API Worker | management routes, scopes, idempotency, `ErrorResponse` rendering                     | D1/KV writes, run lifecycle, promotion, policy gates, audit writes           |
| Evaluation Worker        | Client Key/API Key evaluate routes, API-Key-only peek, and dry-run control-plane auth | Provider reads, Assignment Store orchestration, Exposure creation            |
| Event Ingest Worker      | event intake validation, internal auth, rate-limit/error shape                        | Queueing, sharded Durable Object dedup, Tinybird writes                      |
| Analysis Worker          | control-plane-authenticated result reads and Tinybird scope injection                 | Tinybird pipe calls, statistics/result interpretation                        |
| Auth API Worker          | auth-door route validation, anonymous-registration edge checks                        | token issuance, token revocation, trusted IdP validation, provisional create |
| MCP Worker               | not for MCP JSON-RPC transport; it calls the Control Plane SDK instead                | PRM/auth.md handshake, MCP registry, session transport                       |

The MCP Worker can import `@splitch/contracts` for tool schemas and `@splitch/control-plane-sdk` for
calls, but it does not mount control-plane route contracts or bind D1/KV/Tinybird.

## Import rules

Dependency direction:

```
@splitch/contracts
        ^
@splitch/worker-runtime
        ^
capability Workers
```

`@splitch/worker-runtime` may import `@splitch/contracts`. `@splitch/contracts` must never import
`@splitch/worker-runtime`. Apps may import the runtime to mount their own routes, but apps still
must not import another app's source.

Dependency-cruiser should gain rules when the package lands:

- `worker-runtime-does-not-import-apps`: runtime helpers cannot import deploy units.
- `worker-runtime-does-not-own-storage`: runtime helpers cannot import D1 schema modules, Tinybird
  clients, Provider adapters, or capability-specific repositories.
- Capability-specific isolation rules should keep MCP, Control Panel, Marketing, Evaluation, Event
  Ingest, and Analysis from importing bindings or packages they do not own.

## Tests

The runtime package owns unit tests for guard behavior once, with fake auth resolvers and fake
rate-limit bindings:

- missing auth resolver fails at boot for a mounted route
- malformed input returns `VALIDATION_ERROR`
- missing or throwing rate-limit binding fails closed for guarded routes
- insufficient scope returns the canonical error body and status
- idempotency header states match the route contract
- shared `ErrorCode` values map to one HTTP status table

Each capability Worker still tests its domain handlers and one happy-path mount smoke test. It should
not duplicate the full guard matrix per route.

## Done

- Specs name `@splitch/worker-runtime` before endpoint implementation starts.
- Route contracts are specified as runtime enforcement metadata, not documentation-only schemas.
- Capability Workers keep their trust and storage boundaries.
- Shared guard tests become the primary coverage surface for auth/scope/rate-limit/error behavior.

## Sources

- [contracts-and-validation.md](./contracts-and-validation.md)
- [monorepo-and-toolchain.md](./monorepo-and-toolchain.md)
- [multi-tenant-isolation.md](./multi-tenant-isolation.md)
- [../../architecture/system-architecture.md](../../architecture/system-architecture.md)
- [../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md](../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md)
- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
