# OpenFeature full provider surface: explicitly deferred

The SDK is a thin JS/TS HTTP client — `evaluate` and `peekVariant`.
A full OpenFeature-shaped provider is a documented, intentional future extension (ADR-0025).
This file pins exactly what is deferred so implementing agents do not guess.

## Thin SDK scope

- `sdk.evaluate(flagKey, context) -> Promise<VariantValue>` — fires Exposure
- `sdk.evaluateDetails(flagKey, context) -> Promise<ResolutionDetails>` — fires Exposure; OpenFeature details shape (ADR-0036)
- `sdk.peekVariant(flagKey, context) -> Promise<VariantValue>` — no Exposure (API Key only)
- `sdk.verify(flagKey, context) -> Promise<ResolutionDetails>` — no Exposure; setup confirmation, all tiers (ADR-0037)
- `idType` defaults to `'user'` in the SDK; overridable per call (ADR-0036)
- Lazy-fetch-on-first-evaluate init
- **Fail-loud** Default Variant fallback on failure: returned with `reason: ERROR` + `errorCode`, loud log/hook, never silent (ADR-0036)
- Single-flag-per-call; batch evaluation is deferred
- In-memory seen-set (LRU, per-instance)
- Client Key / API Key auth (runtime-appropriate)

The SDK speaks the OpenFeature `ResolutionDetails` shape (`value`, `variantName`, `reason`,
`errorCode?`, `errorMessage?`) and the standard `reason` / error-code enums. Conforming to
_that shape_ is **not** deferred — it is the contract (ADR-0036). What remains deferred is the
full OpenFeature _provider/client API_ below.

## Deferred decisions

The following are not part of the thin SDK contract. Do not scaffold, stub, or add TODOs for these in
SDK code unless a separate decision record reopens the surface.

**1. Standard OpenFeature SDK library**
Whether to ship as a native OpenFeature `Provider` (implementing `OpenFeature.setProvider()`,
`client.getBooleanValue()`, etc.) or as a standalone splitch SDK is undecided. ADR-0025
notes "The public OpenFeature data-plane SDK contract is unresolved by design — a separate
surface to be decided on its own." The thin SDK does not implement the full OpenFeature
_provider/client API_ — but it **does** conform to the OpenFeature `ResolutionDetails` type and
the standard `reason` / error-code enums (ADR-0036), so adopting the full provider later is a
shape-compatible extension, not a rewrite.

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

**6. Targeting Context _attribute typing_ validation**
OpenFeature defines a typed `EvaluationContext` with well-known fields. The thin SDK constrains
`evaluationContext` to `{ targetingKey: string, idType?: string, [key: string]: unknown }`.
Per-Flag / per-Experiment **attribute-type** validation (e.g. enforcing `plan: string`) is
deferred. (The `ResolutionDetails` _output_ shape and the `reason`/error enums are **not**
deferred — they are in scope per ADR-0036.)

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
- [ADR-0036](../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md) — ResolutionDetails + reason/error enums are in scope (partially reopens this file)
- [ADR-0037](../../adr/0037-client-side-configuration-verification-tiered-by-credential.md) — verify accessor
