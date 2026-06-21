# OpenFeature full provider surface: explicitly deferred

The SDK is a thin JS/TS HTTP client — `evaluate` and `peekVariant`.
A full OpenFeature-shaped provider is a documented, intentional future extension (ADR-0025).
This file pins exactly what is deferred so implementing agents do not guess.

## Thin SDK scope

- `sdk.evaluate(flagKey, context) -> Promise<VariantValue>` — fires Exposure
- `sdk.peekVariant(flagKey, context) -> Promise<VariantValue>` — no Exposure
- Lazy-fetch-on-first-evaluate init
- Default Variant fallback on error / flag not found
- Single-flag-per-call; batch evaluation is deferred
- In-memory seen-set (LRU, per-instance)
- Client Key / API Key auth (runtime-appropriate)

## Deferred decisions

The following are not part of the thin SDK contract. Do not scaffold, stub, or add TODOs for these in
SDK code unless a separate decision record reopens the surface.

**1. Standard OpenFeature SDK library**
Whether to ship as a native OpenFeature `Provider` (implementing `OpenFeature.setProvider()`,
`client.getBooleanValue()`, etc.) or as a standalone splitch SDK is undecided. ADR-0025
notes "The public OpenFeature data-plane SDK contract is unresolved by design — a separate
surface to be decided on its own." The thin SDK does not conform to the OpenFeature SDK specification.

**2. Language clients beyond JS/TS**
The SDK is JS/TS only. Go, Python, and other language clients are
future work.

**3. OpenFeature hook lifecycle**
OpenFeature defines before/after/error/finally hooks on the evaluation lifecycle. The thin SDK has no
hook system. Adding hooks requires a separate decision on which lifecycle events are relevant
and whether the exposure-on-read model conflicts with OpenFeature's hook ordering.

**4. Batch flag evaluation (`evaluateAll`)**
`evaluateAll([flagKeys])` is a natural optimization (one HTTP call for multiple flags in one
render). The endpoint contract (`POST /evaluate-batch`) is not defined. This is a pure
ergonomic extension — the data-plane safety model is unchanged.

**5. Server-side flag config streaming / SSE**
Streaming updates to flag config (instead of lazy-fetch on first evaluate) would reduce
first-call latency. This is deferred.

**6. Targeting Context schema validation**
OpenFeature defines a typed `EvaluationContext` with well-known fields. The thin SDK constrains
`evaluationContext` to `{ targetingKey: string, [key: string]: unknown }`.
Full schema validation (per-Flag or per-Experiment attribute typing) is deferred.

**7. OpenFeature `track()` method**
OpenFeature defines a `track(eventName, context, details)` method for metric events. The thin SDK
fires Exposures automatically on `evaluate`; no explicit tracking surface is defined.

## Why deferred

The thin client unblocks data-plane testing and agent-first SDK wiring without
committing to the full OpenFeature surface. The full provider contract should emerge
from real usage patterns — what do callers actually reach for? Premature conformance
risks implementing the wrong interface.

ADR-0025 leaves the data-plane OpenFeature SDK contract unresolved by design. This file is the
single place that records the deferral, so it is never re-discovered as an accidental gap.

## How to reopen

Create an ADR titled "OpenFeature provider contract for the data-plane SDK" that answers:

1. Standard OF SDK library or standalone splitch SDK?
2. Which language first?
3. Hook lifecycle: which stages, what do they enable?
4. `track()` surface: separate from `evaluate` or unified?
5. Batch evaluation: endpoint contract + SDK ergonomics.

The new ADR supersedes this file for the items it resolves.

## Sources

- [ADR-0025](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md) — "OpenFeature SDK contract is unresolved by design, separate surface"
