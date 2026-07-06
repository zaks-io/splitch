# Zod contract architecture: packages, derivation chain, error shape

Pins the Zod-first contract spine so implementing agents know which package owns what and
how types, clients, and MCP schemas derive from one source. Avoids any second authored representation.

## Package split

```
@splitch/contracts
  Authored here:
    - Leaf Zod schemas (Environment, Flag, FlagConfig, Variant, TargetingRule, Experiment, Run, Segment, Metric, ...)
    - Request/response Zod schemas (distinct from leaf; no fusion with storage shapes)
    - @hono/zod-openapi route definitions with explicit `operationId`
  Derived here (compile-time):
    - TypeScript types via z.infer (never hand-written)
    - OpenAPI document (generated; never committed to repo)
    - `ControlPlaneRpcApp` — the Hono RPC App type for `hc<ControlPlaneRpcApp>()` (contract-owned;
      derived from the same route inputs as the registry; not imported from `apps/*`)
  Dependencies: zod, @hono/zod-openapi, hono (types only for the RPC App export)

@splitch/control-plane-sdk
  Contains: Hono `hc<ControlPlaneRpcApp>()` instance
  Derives: per-route input/output types from `ControlPlaneRpcApp` exported by `@splitch/contracts`
  Dependencies: `@splitch/contracts`, hono/client
```

The OpenAPI document and MCP tool schemas are build-time outputs, never committed files.
Agents fight committed generated files; this eliminates the inversion risk (ADR-0025).

## Derivation chain

```
Zod schema (authored, @splitch/contracts)
  → z.infer → TypeScript type (compile-time)
  → @hono/zod-openapi → OpenAPI route def
    → OpenAPI doc (build-time; served at /.well-known/openapi.json)
    → MCP tool inputSchema/outputSchema (derived at MCP server startup)
  → Worker Zod.parse() → runtime validation (same schema that authored the type)
  → hc<ControlPlaneRpcApp>() → typed client method (type-inferred from contract-owned App type; no codegen step)
```

## Schema composition rules

**Leaf schemas** are reusable across request, response, and storage shapes:

- `VariantSchema` — `{ name: string, value: z.union([z.boolean(), z.string(), z.number(), z.object({...})]), isDefault: z.boolean() }`
- `TargetingRuleSchema` — `{ ruleId: string, name: string, priority: number, conditions: Condition[], allocation?: AllocationMap }`
- `ConditionSchema` — `{ attribute: string, operator: z.enum(['eq','neq','gt','lt','in','not_in','contains']), value: unknown }`
- `AllocationMapSchema` — `z.record(z.string(), z.number())` (Variant name -> percentage; enforced sum=100 in Worker)
- `MetricRefSchema` — `{ metricId: string, isGoal: boolean, isGuardrail: boolean }`

**Request schemas** compose leaves; never expose storage internals:

- `CreateFlagRequestSchema` — has `variants: VariantSchema[]` (not `flagId`, not `createdAt`)
- `CreateRunRequestSchema` does not exist separately — Runs are created implicitly by Start
- Per-Environment request/response schemas (Experiment, Run, credential) carry `environmentId`
  co-scoped with `appId`, matching the `/apps/{appId}/envs/{environmentId}/…` routes (ADR-0027)

**Response schemas** include computed/server-set fields:

- `FlagResponseSchema` — has `flagId`, `createdAt`, `updatedAt` + all request fields

**Storage shapes are NOT exported** from `@splitch/contracts`. They live in the Worker/repository
package. The seam: request shapes -> Worker -> storage shape (the Worker adds `flagId`, `createdAt`, etc).

**PATCH schemas** use Zod `.partial()` on mutable fields only. For Run: `.omit({ salt, allocation,
variantSet, targetingKeyField, targetingRules, segmentIds, activationMetricId })` makes the
frozen assignment config un-expressible at parse time (ADR-0002/0003 invariant enforced structurally).

## Error shape

Single base error schema, extended per code:

```typescript
// Base (every endpoint; every failure mode)
const ErrorResponseSchema = z.object({
  code: z.string(), // shared enum value; see codes below
  message: z.string(), // human-readable; agent-actionable
  details: z.unknown().optional(),
});

// Extended example — RUN_FROZEN carries the frozen fields list
const RunFrozenErrorSchema = ErrorResponseSchema.extend({
  code: z.literal("RUN_FROZEN"),
  details: z.object({
    frozenFields: z.array(z.string()),
    currentRunId: z.string(),
    attemptedChange: z.string(),
  }),
});
```

**Error codes are defined once, not here.** The canonical `ErrorCode` enum, every per-code
detail shape, and the HTTP-status mapping live in
[../contracts/error-responses.md](../contracts/error-responses.md) — the single source. This
doc owns only the Zod _shape_ (one base `ErrorResponse`, narrowed by `code`), shown above; it
deliberately does not restate the code list, so the two cannot drift.

The OAuth-flow doors (ID-JAG unknown issuer, claim `interaction_required`) are a **separate**
namespace with OAuth-shaped bodies (lowercase `error`), not the `ErrorResponse` union; they live
in [auth-doors.md](./auth-doors.md) and [access-control-matrix.md](./access-control-matrix.md).

Zod parse failures and domain-invariant failures return the same `ErrorResponse` shape. No
parallel error format exists.

## Validation contract

- Every HTTP input at the Worker boundary: Zod-parsed (non-negotiable)
- Every KV read: Zod-parsed (schemaless JSON; version skew possible; fail loud)
- D1 rows: trusted as structurally sound (not re-parsed)

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
