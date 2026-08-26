# Internal contract topology and the published SDK interface

How the private contracts and Control Plane SDK implementation packages are split, how the published
SDK exposes them, and which consumers import from where. The internal split keeps schema-only
consumers free of transport code. The published SDK gives independently released packages one
versioned dependency spine. (ADR-0025 and its 2026-08-26 amendment.)

---

## Package split

### `@splitch/contracts`

**What it exports:**

- All Zod leaf schemas (every glossary noun: `Flag`, `Variant`, `Run`, `Experiment`, `Environment`,
  `Metric`, `Exposure`, `EvaluationContext`, `Segment`, `ClientKey`, `APIKey`, etc.)
- `z.infer<>` types derived from those schemas (never hand-written types)
- `@hono/zod-openapi` route definitions for every control-plane endpoint
- `ControlPlaneRpcApp` — the contract-owned Hono RPC App type for `hc<ControlPlaneRpcApp>()` (derived
  from the route registry; resolves the SDK↔Worker typing tension without importing `apps/*`)
- `ErrorResponse` discriminated union + `ErrorCode` enum
- `TestEvaluationReason` discriminated union

**Dependencies:** `zod`, `@hono/zod-openapi`, `hono` (for the exported RPC App type). No transport
runtime. No `fetch`. No `node-fetch`.

**Build step:** None. Zod schemas + types are source. Consumed directly as TypeScript.

**Deletion test (4+ real consumers):**

1. Control Plane API Worker: imports route definitions to mount handlers; uses Zod schemas for
   request validation at the HTTP edge.
2. Worker runtime: imports route definitions plus auth/scope/rate-limit/idempotency metadata to
   mount a uniform request guard for Hono Workers.
3. MCP server: imports Zod schemas to derive `inputSchema`/`outputSchema` for every tool.
4. CLI: imports types for type-safe argument construction; imports error schema for error parsing.
5. Marketing site / docs: imports types for example shapes in documentation; imports no transport.

### `@splitch/control-plane-sdk`

**What it exports:**

- Hono `hc<ControlPlaneRpcApp>()` typed client using the **contract-owned** App type from
  `@splitch/contracts` (not the Worker implementation in `apps/*`)
- Thin wrappers: auth header injection, credential management, error parsing (unwraps `ErrorResponse`)
- Re-exports `@splitch/contracts` types for convenience

**Dependencies:** `@splitch/contracts`, `hono` (for `hc` only). Optionally `node-fetch` polyfill
for non-browser environments. No other transport frameworks.

**Build step:** Builds to ESM + CommonJS for Node.js consumers (CLI, MCP server). Browser consumers
(control panel) import ESM directly.

**Consumers:**

- Published SDK control-plane entry — bundles the typed client for CLI consumers.
- MCP server — calls the control-plane API via the typed client; never imports Worker code directly.
- Control panel (TanStack Start) — uses the typed client for SSR/RSC data fetching.

### `@splitch/sdk/control-plane`

This is the published package interface over the two private modules above. Its JavaScript and
declarations are built into the `@splitch/sdk` tarball, so they contain no imports of private
workspace packages. It declares the Hono/Zod packages its schema interface requires.

Published CLI code imports contracts, route discovery, and typed transport only through this
subpath. Monorepo-only consumers may continue importing the private authoring modules directly when
they need narrower build graphs.

---

## Consumer import map

| Consumer                 | Imports from contracts                | Imports from SDK          | Imports Worker directly |
| ------------------------ | ------------------------------------- | ------------------------- | ----------------------- |
| Control Plane API Worker | yes (route defs + Zod schemas)        | no (or rarely, self-call) | —                       |
| Worker runtime           | yes (route defs + guard metadata)     | no                        | no                      |
| MCP server               | yes (Zod schemas for tool derivation) | yes (API calls)           | no                      |
| CLI                      | through `@splitch/sdk/control-plane`  | through the same subpath  | no                      |
| Control panel            | yes (types for forms/display)         | yes (data fetching)       | no                      |
| Marketing site           | yes (types for examples)              | no                        | no                      |

---

## `hc` client: type-inferred, zero codegen

`@splitch/control-plane-sdk` wraps `hc<ControlPlaneRpcApp>()` where `ControlPlaneRpcApp` is exported
by `@splitch/contracts` and derived from the same Zod route inputs as the route registry. A contract
change that adds, removes, or renames a route fails `tsc` immediately in every consumer — the client
cannot drift from the authored routes by construction, and the SDK never imports `apps/*` (dependency-cruiser).

No codegen step. No OpenAPI-to-client generation. `hc` + `z.infer` cover every internal consumer.
The OpenAPI document is served from a Worker route or produced in CI for documentation; it is never
a committed file that agents or humans would edit.

---

## What is NOT built

- No independently published contracts or Control Plane SDK implementation package. The supported
  npm interface is the versioned `@splitch/sdk/control-plane` subpath.
- No OpenAPI → codegen client. The deletion test found no external consumer that would need it.
  Building it would be speculative indirection. (ADR-0025.)
- No shared MCP tool definition file committed to the repo. MCP schemas derive at startup from
  `@splitch/contracts` schemas. See [mcp-tool-derivation.md](./mcp-tool-derivation.md).
- No per-Worker hand-written auth/scope/rate-limit/error guard chains. Capability Workers mount
  route contracts through `@splitch/worker-runtime`; domain invariants still live in the Worker.

---

## Seam contract

**Port:** `@splitch/contracts` ↔ all consumers.
**What's on each side:**

- Left (contracts): Zod schemas, inferred types, route definitions, and guard metadata. Zero runtime I/O.
- Right (consumers): Workers, servers, CLIs that import and use the schemas.
  **Failure contract:** A schema change that removes a required field fails `tsc` in every consumer
  that references the field; zero runtime surprises.
  **Deletion test:** 5 real consumers listed above. Removing `@splitch/contracts` would require
  hand-writing validation and guard metadata in the Worker, hand-writing types in the CLI, and
  hand-writing MCP schemas in the MCP server. All three would diverge. The package earns its keep.

**Port:** `@splitch/control-plane-sdk` ↔ CLI, MCP server, control panel.
**What's on each side:**

- Left (SDK): typed HTTP methods, auth wrappers, error unwrapping.
- Right (consumers): call SDK methods, receive typed results.
  **Failure contract:** A Worker route change breaks `tsc` in the client, which breaks `tsc` in all
  consumers. One fix propagates everywhere.
  **Deletion test:** 3 real consumers. Removing `@splitch/control-plane-sdk` would push raw `fetch` + manual
  error parsing into CLI, MCP server, and control panel separately — immediate divergence risk.

Both seams pass the deletion test. Neither is speculative indirection.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
