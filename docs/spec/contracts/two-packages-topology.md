# Two-package topology: @splitch/contracts and @splitch/client

How the contracts package and the HTTP client package are split, what each depends on, and which
consumers import from where. Splitting keeps schema-only consumers (marketing site, Tinybird docs)
free of transport code. (ADR-0025 "two packages".)

---

## Package split

### `@splitch/contracts`

**What it exports:**
- All Zod leaf schemas (every glossary noun: `Flag`, `Variant`, `Run`, `Experiment`, `Environment`,
  `Metric`, `Exposure`, `EvaluationContext`, `Segment`, `SDKCredential`, etc.)
- `z.infer<>` types derived from those schemas (never hand-written types)
- `@hono/zod-openapi` route definitions for every control-plane endpoint
- `ErrorResponse` discriminated union + `ErrorCode` enum
- `TestEvaluationReason` discriminated union

**Dependencies:** `zod`, `@hono/zod-openapi` only. No transport code. No `fetch`. No `node-fetch`.

**Build step:** None. Zod schemas + types are source. Consumed directly as TypeScript.

**Deletion test (4+ real consumers):**
1. Control Plane API Worker — imports route definitions to mount handlers; uses Zod schemas for
   request validation at the HTTP edge.
2. MCP server — imports Zod schemas to derive `inputSchema`/`outputSchema` for every tool.
3. CLI — imports types for type-safe argument construction; imports error schema for error parsing.
4. Marketing site / docs — imports types for example shapes in documentation; imports no transport.

### `@splitch/client`

**What it exports:**
- Hono `hc<AppType>()` typed client inferred from the Control Plane API Worker's exported app type
- Thin wrappers: auth header injection, credential management, error parsing (unwraps `ErrorResponse`)
- Re-exports `@splitch/contracts` types for convenience

**Dependencies:** `@splitch/contracts`, `hono` (for `hc` only). Optionally `node-fetch` polyfill
for non-browser environments. No other transport frameworks.

**Build step:** Builds to ESM + CommonJS for Node.js consumers (CLI, MCP server). Browser consumers
(control panel) import ESM directly.

**Consumers:**
- CLI — calls the control-plane API via the typed client.
- MCP server — calls the control-plane API via the typed client; never imports Worker code directly.
- Control panel (TanStack Start) — uses the typed client for SSR/RSC data fetching.

---

## Consumer import map

| Consumer | Imports from contracts | Imports from client | Imports Worker directly |
|---|---|---|---|
| Control Plane API Worker | yes (route defs + Zod schemas) | no (or rarely, self-call) | — |
| MCP server | yes (Zod schemas for tool derivation) | yes (API calls) | no |
| CLI | yes (types + error schema) | yes (API calls) | no |
| Control panel | yes (types for forms/display) | yes (data fetching) | no |
| Marketing site | yes (types for examples) | no | no |

---

## `hc` client: type-inferred, zero codegen

`@splitch/client` wraps `hc<AppType>()` where `AppType` is the exported type of the Hono app from
the Control Plane API Worker. A Worker change that adds, removes, or renames a route fails `tsc`
immediately in every consumer — the client cannot drift from the Worker by construction.

No codegen step. No OpenAPI-to-client generation. `hc` + `z.infer` cover every internal consumer.
The OpenAPI document is served from a Worker route or produced in CI for documentation; it is never
a committed file that agents or humans would edit.

---

## What is NOT built

- No external/published npm package. Every consumer is in the monorepo.
- No OpenAPI → codegen client. The deletion test found no external consumer that would need it.
  Building it would be speculative indirection. (ADR-0025.)
- No shared MCP tool definition file committed to the repo. MCP schemas derive at startup from
  `@splitch/contracts` schemas. See [mcp-tool-derivation.md](./mcp-tool-derivation.md).

---

## Seam contract

**Port:** `@splitch/contracts` ↔ all consumers.
**What's on each side:**
- Left (contracts): Zod schemas, inferred types, route definitions. Zero runtime I/O.
- Right (consumers): Workers, servers, CLIs that import and use the schemas.
**Failure contract:** A schema change that removes a required field fails `tsc` in every consumer
that references the field — zero runtime surprises.
**Deletion test:** 4 real consumers listed above. Removing `@splitch/contracts` would require
hand-writing validation in the Worker, hand-writing types in the CLI, and hand-writing MCP schemas
in the MCP server — all three would diverge. The package earns its keep.

**Port:** `@splitch/client` ↔ CLI, MCP server, control panel.
**What's on each side:**
- Left (client): typed HTTP client methods, auth wrappers, error unwrapping.
- Right (consumers): call client methods, receive typed results.
**Failure contract:** A Worker route change breaks `tsc` in the client, which breaks `tsc` in all
consumers. One fix propagates everywhere.
**Deletion test:** 3 real consumers. Removing `@splitch/client` would push raw `fetch` + manual
error parsing into CLI, MCP server, and control panel separately — immediate divergence risk.

Both seams pass the deletion test. Neither is speculative indirection.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
