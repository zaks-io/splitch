# Contracts and validation: Zod-first, derived everywhere, schema-versioned KV

Zod is the single authored source of truth for all contract shapes. Nothing else is hand-authored.
This file pins the authoring discipline, package split, KV schema-version envelope, and error shape.

## Authoring rule: Zod is the one source

```
Authored (in tree):       Zod schemas + @hono/zod-openapi route definitions
                          + route metadata (auth, scopes, rate-limit, idempotency, errors)
                          → z.infer<...>        (TypeScript types, compile-time)
                          → hc<AppType>()       (typed HTTP client, compile-time)
                          → OpenAPI document    (generated at build/runtime, never committed)
                          → MCP tool schemas    (derived at build/startup, never committed)
                          → @splitch/worker-runtime request guard (runtime enforcement)
```

No generated artifact is committed to the repo. Only Zod schemas live in the tree. Agents that
hand-edit a generated artifact or "fix a drift" by editing the generated output are inverting the
source-of-truth discipline — the Zod source is the fix target.

## Package split

**`@splitch/contracts`**

- Zod leaf schemas (glossary nouns: `VariantSchema`, `TargetingRuleSchema`, `RunSchema`, ...)
- `@hono/zod-openapi` route definitions (input + output composed from leaf schemas)
- Route metadata for runtime enforcement: auth requirement, scopes, rate-limit class,
  idempotency policy, and allowed error codes
- `z.infer` types re-exported for consumers
- Dependencies: `zod`, `@hono/zod-openapi` only
- Consumers: `@splitch/worker-runtime`, capability Workers, `@splitch/control-plane-sdk`, CLI/MCP,
  control panel, marketing site

**`@splitch/worker-runtime`**

- Contract-mounted Hono request guard
- Depends on `@splitch/contracts` and Hono runtime types
- Owns shared request ID, input parsing, auth resolver dispatch, scope/rate-limit/idempotency guard,
  and canonical `ErrorResponse` status rendering
- Does not own repositories, storage bindings, domain invariants, Provider logic, Tinybird queries,
  or MCP protocol handling
- Consumers: Control Plane API Worker, Evaluation Worker, Event Ingest Worker, Analysis Worker,
  Auth API Worker

**`@splitch/control-plane-sdk`**

- Hono `hc<AppType>()` HTTP client (type-inferred, zero codegen)
- Depends on `@splitch/contracts`
- Consumers: control panel, MCP server, and the published SDK control-plane entry

**`@splitch/sdk/control-plane`**

- Published bundle and declaration interface over `@splitch/contracts` and
  `@splitch/control-plane-sdk`
- Consumer: `@splitch/cli`; the CLI has no direct private implementation-package imports
- Declares Hono/Zod runtime packages, but no private `@splitch/*` dependency

The split keeps schema-only consumers (marketing site, MCP schemas) free of transport code.

The deletion test passes for both: `contracts` has 4+ real consumers; `control-plane-sdk` has 3+ real
consumers. Neither is speculative indirection.

`@splitch/worker-runtime` passes a different deletion test: without it, every capability Worker must
hand-write the same auth/scope/rate-limit/idempotency/error-envelope chain and keep it in sync with
route metadata. That duplicated guard logic is the tech-debt path this spec rejects.

## Schema shapes: leaf reuse, distinct envelopes

The shared, reused-everywhere unit is the leaf schema (glossary noun). Request, response, and
storage shapes are distinct compositions of leaves.

```
// leaf (shared, reused)
VariantSchema = z.object({ name: z.string(), value: JsonValueSchema, isDefault: z.boolean() })

// request envelope (distinct — only mutable fields)
CreateFlagRequest = z.object({ key: z.string(), variants: z.array(VariantSchema), ... })

// response envelope (distinct — includes server-assigned fields)
FlagResponse = z.object({ id: z.string(), key: z.string(), ..., createdAt: z.date() })

// storage shape (distinct — includes internal fields not on wire)
FlagRecord = z.object({ id: z.string(), app_id: z.string(), schemaVersion: z.number(), ... })
```

Run immutability (ADR-0002/0003) forces this split: a create-Run input and a patch-Run input are
different shapes (patch must reject assignment-config fields on a live Run).

## Validation discipline

| Boundary                   | Rule                                                                       |
| -------------------------- | -------------------------------------------------------------------------- |
| HTTP edge (Worker input)   | Zod-parse all untrusted input — non-negotiable; ADR-0023's invariant home  |
| KV reads (hot path + cold) | Zod-parse all, including Assignment Store and flag config on evaluate path |
| D1 reads                   | Trusted — column schema + migrations enforce structure; no re-parse        |
| Tinybird query results     | Parse at the control-plane endpoint before returning to callers            |

**KV hot-path validation trade-off:** latency is accepted in exchange for loudness. A malformed
KV blob fails loud (returns error, falls back to D1) rather than flowing a half-valid object into
evaluation. Optimize only when measured (p99 latency data shows material impact).

## KV schema-version envelope

All KV blobs carry a `schemaVersion` field:

```
KVEnvelope<T> {
  schemaVersion: literal(CURRENT_KV_SCHEMA_VERSION)   // PINNED to the current version
  data:          T                                    // the payload; Zod-validated
}
```

The envelope `schemaVersion` is **pinned to the current version** (`z.literal`), not merely
bounded below: a blob written at any other version — old or future — FAILS the envelope parse.
The version is gated, so an unknown version can never be mistaken for current and flow into
evaluation as if valid (fail-loud, ADR-0025/0036).

**On a failed parse (unknown version OR corrupt payload), the recovery is the READER's, not the
schema's** — and it differs by binding:

- **Control-plane / DO readers (have a D1 binding):** fall back to D1 (one extra hop; rebuilds KV
  from the authoritative source) and log the schema mismatch as a warning. Not silent — operators
  can detect drift and schedule a KV backfill. This is what enables rolling upgrades: the writer
  bumps the version, old readers rebuild from D1, no synchronized cutover.
- **Evaluation edge reader (no D1 binding):** there is nothing to fall back TO, so it **fails loud
  with `INTERNAL_SERVER_ERROR`** — the evaluate path returns the Default Variant with
  `reason: ERROR` + the code and fires no Exposure (see [evaluation/provider-port.md](../evaluation/provider-port.md)).
  A half-valid or wrong-version blob never reaches `assign()`.

**On KV write:** always write with `CURRENT_KV_SCHEMA_VERSION`.

## Route metadata as runtime input

A route contract is not documentation for a handler to remember. It is mounted through
`@splitch/worker-runtime`, which enforces:

- input parsing from the route's Zod schemas
- auth kind and Worker-provided resolver
- required scopes and App/Environment co-scope
- declared rate-limit class
- a conservative raw-body byte limit on mutating JSON routes (smaller explicit route caps are preserved)
- idempotency header policy for mutating routes
- allowed `ErrorCode` values and their shared HTTP status mapping

Adding an endpoint without route metadata is invalid. Adding route metadata that no Worker can mount
fails during boot or tests. See [worker-runtime.md](./worker-runtime.md).

## Error shape

One canonical `ErrorResponse`, extensible by `code`:

```
ErrorResponse {
  code:     string   // shared enum; e.g. 'RUN_FROZEN', 'FLAG_NOT_FOUND', 'VALIDATION_ERROR'
  message:  string   // human-readable
  details:  unknown  // typed per-code extension; always present ({} for codes with no detail)
}
```

Specific errors extend the base shape. Example:

```
RunFrozenError = ErrorResponse & {
  code: 'RUN_FROZEN'
  details: {
    frozenFields: string[]   // field names that cannot be edited on a live Run
    currentRunId: string
  }
}
```

Zod parse failures and domain-invariant failures (frozen Run, invalid Targeting Rule) return the
same shape. No parallel, unrelated error shape exists. Every consumer (`hc` client, CLI, MCP) has
one guaranteed error-parsing path.

## MCP tool schema derivation

Each `@hono/zod-openapi` route's Zod input schema becomes the MCP tool's `inputSchema`; the output
schema becomes `outputSchema`. The schema an agent reads to call a tool is byte-for-byte the schema
the Worker enforces. Adding an endpoint creates a new MCP tool mechanically — no hand-written MCP
schemas (ADR-0023).

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md](../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md)
- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
