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
- **Fail-loud** fallback behavior: `evaluate`/`verify` failure fallbacks return the Default Variant with `reason: ERROR` + `errorCode`; peek failures and Default Variant fallbacks return the canonical error envelope instead (ADR-0036).
- Single-flag-per-call; batch evaluation is deferred
- In-memory seen-set (LRU, per-instance)
- `sdk.track(eventName, { targetingKey, idType, eventId, fields, dimensions })` for Metric Events
- `sdk.web.track(eventName, webEvent)` for explicit schema-defined Web Events
- `sdk.web.instrument({ captures }) -> () => void` for scoped automatic browser signals and cleanup
- `sdk.web.flush() -> Promise<WebEventBatchResult>` for acknowledged Web Event delivery
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

**4. Batch flag evaluation (`evaluateAll`)** — **RESOLVED by ADR-0048.**
`sdk.evaluateAll(context)` and `POST /api/sdk/evaluate-all` return the Precomputed Evaluations for
one context (all Flags, non-exposing, Exposure Tickets redeemed on first read). See
[evaluate-all-endpoint.md](./evaluate-all-endpoint.md). The resolution went further than the
"pure ergonomic extension" imagined here: the safety model gained the ticket redemption seam.

**5. Server-side flag config streaming / SSE** — **RESOLVED by ADR-0048** (mechanism differs).
Freshness for payload-backed clients is ETag revalidation polling on `evaluate-all` (default ~60s;
[browser-client.md](./browser-client.md)); a data-free WebSocket nudge in the ADR-0019 shape is the
planned accelerator (tracked in SPL-337), with polling as the permanent fallback. Config never
streams to clients — only "revalidate now" signals.

**6. Targeting Context _attribute typing_ validation**
OpenFeature defines a typed `EvaluationContext` with well-known fields. The thin SDK constrains
`evaluationContext` to `{ targetingKey: string, idType?: string, [key: string]: unknown }`.
Per-Flag / per-Experiment **attribute-type** validation (e.g. enforcing `plan: string`) is
deferred. (The `ResolutionDetails` _output_ shape and the `reason`/error enums are **not**
deferred — they are in scope per ADR-0036.)

**7. Full OpenFeature `track()` compatibility**
The thin SDK defines a standalone, stateless top-level `track()` surface exclusively for Metric
Events. Adapting it to OpenFeature's client/context/details lifecycle remains deferred with the full
Provider surface. The namespaced `web.track()` accessor is Splitch-specific and does not overload
the OpenFeature or Metric Event surface.

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
4. How does the existing standalone `track()` surface map to OpenFeature context/details?
5. Batch evaluation: endpoint contract + SDK ergonomics.

The new ADR supersedes this file for the items it resolves.

## Sources

- [ADR-0025](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md) — "OpenFeature SDK contract is unresolved by design, separate surface"
- [ADR-0036](../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md) — ResolutionDetails + reason/error enums are in scope (partially reopens this file)
- [ADR-0037](../../adr/0037-client-side-configuration-verification-tiered-by-credential.md) — verify accessor
