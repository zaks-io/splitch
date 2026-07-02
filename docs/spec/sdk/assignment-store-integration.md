# SDK integration with the Assignment Store

How the evaluate path consumes the Assignment Store (holdover pre-load, ordering, fallback).
The SDK is a **consumer** of the Assignment Store, never a writer — reads only.

## Assignment Store interface (from architecture seam)

```
interface AssignmentStore:
  getAll(appId: string, idType: string, targetingKey: string)
    -> Map<experimentId: string, { runId: string; variantName: string }>
  put(appId: string, experimentId: string, idType: string, targetingKey: string, runId: string, variantName: string)
    -> void
```

The SDK only calls `getAll`. The `put` is called by the **Exposure pipeline Worker** after
confirming first-touch via the per-key Durable Object (ADR-0009). The SDK never writes.

`getAll` is a **per-Entity batch read**: its logical key is `(appId, idType, targetingKey)` — note it
does **not** take `experimentId`. One round-trip returns every Experiment's holdover for this
Entity as `Map<experimentId, {runId, variantName}>`, so the evaluate path reads holdovers once
per request, not once per flag. The Map key is an `experimentId` string; the evaluate path
accesses `held[experimentId]`. (The per-key Durable Object that serializes `put` is keyed by
the full logical `(appId, experimentId, idType, targetingKey)` — write granularity differs from
read granularity, by design: ADR-0008/0009.) The Assignment Store substrate derives
`targetingKeyHash` before touching KV or Durable Objects; the SDK never sends the hash.

## Evaluate-path ordering (no superposition)

The Worker executes in this order for every `evaluate` call:

```
1. Validate credential (Client Key via KV)
2. Load Provider flag config for flagKey (KV cache; ~60s propagation window)
3. Determine if flagKey is controlled by a live Experiment; get experimentId and liveRunId
4. Validate request idType against the Experiment's pinned idType
5. held = AssignmentStore.getAll(appId, validatedIdType, targetingKey)   [KV read, edge-local, all experiments]

6. if experimentId in held:
     variant = held[experimentId].variantName      // holdover: replay prior Variant
     // no Exposure fires, no Assignment Store write: already counted under held[experimentId].runId
   else:
     variant = assign(liveRun, targetingKey)        // pure hash (ADR-0001)
     // Exposure fires → pipeline → DO.putIfAbsent → KV write-through
7. Return VariantValue for resolved variantName
```

Each step has exactly one outcome — no superposition. The holdover branch returns the prior
Variant without re-computing `assign()`, preserving sticky experience across Run boundaries
even if the new Run's salt differs.

## idType cardinality: why it is a required request field

The Assignment Store key includes `idType` to guard against Targeting Key value collisions
across Entity types (e.g., a `session` id that happens to equal a `user` id). It is a
**required field on the wire** (`EvaluateRequest`), carried through to the `getAll` call; the
Worker neither derives nor defaults it (ADR-0007). The SDK client applies a `'user'` default
**before** assembling the request when the caller omits `idType` (ADR-0036), so the wire field
is always populated — the defaulting is a client ergonomic, not a server behavior.

An Experiment pins one idType at Run creation. The SDK presents the idType the caller
provided; the Worker validates it matches the Experiment's pinned idType and returns a
`400 VALIDATION_ERROR` if not.

## Holdover invariants

- **Replay, no re-compute:** holdover always returns `held[exp].variantName` verbatim.
  `assign()` is never called for a holdover Entity. This is correct even if the new Run's
  assignment config differs — the holdover Entity keeps its prior Variant (sticky experience,
  ADR-0006).
- **No new Exposure for holdovers:** the pipeline must NOT fire a new Exposure for a
  holdover read. The holdover Entity is still counted under `held[exp].runId` (its original
  Run), not the live Run. The holdover is invisible to the new Run's analysis denominator.
- **No Assignment Store write on holdover read:** the Worker does not call `put` for a
  holdover. The entry already exists; the DO's `putIfAbsent` would be a no-op anyway, but
  the Worker skips the round-trip.

## Fallback: Assignment Store read failure

`getAll` reads Workers KV, which is edge-local and fast. If the KV read fails before a blob
is returned (transient platform error), the evaluate path falls through to `assign()` as if
there were no holdover. This may briefly break sticky experience for a returning Entity but
is self-healing on the next request. Without the KV data, the Worker cannot distinguish a
holdover from a new Entity. Acceptable trade: a transient KV failure causes at most one
mismatched experience, which converges.

A present-but-malformed Assignment Store blob is different: schema or JSON corruption fails
loud with `INTERNAL_SERVER_ERROR`, logs the parse failure, and produces no Exposure decision.
Corruption is never treated as an empty holdover map.

On KV miss (not failure — the Entity has no prior entry), `assign()` runs normally and the
Exposure pipeline creates the first-touch Assignment Store entry.

## Transient boundary window (accepted, self-healing — ADR-0009)

For up to ~60s after a Run-boundary first-touch write (DO → KV write-through), a concurrent
cross-POP read may miss the holdover in KV and compute a fresh `assign()`. Because `assign()`
is deterministic (ADR-0001), the result is the same Variant the DO just stored. The analysis
denominator (raw log, pipeline dedup) is unaffected. This window is **cosmetic and
self-healing**, bounded to returning Entity × Run boundary × cross-POP × within propagation.

## Write path: not SDK's concern

The `put` call that creates holdover entries flows:

```
evaluate() Exposure fires → Worker appends raw log → pipeline → DO.putIfAbsent → KV write-through
```

The SDK client is not involved in this write path. The SDK reads holdovers via `getAll`;
it relies on the pipeline to establish them. This means there is a lag between an Exposure
firing and the holdover being readable in KV (the DO → KV propagation). During this lag,
a second evaluate call from a different POP may re-compute `assign()` (new Entity path) and
fire a second raw Exposure — both raw Exposures resolve to first-touch in the pipeline.
The sticky experience converges once KV propagates.

## Seam boundary

- **Port:** `AssignmentStore.getAll(appId, idType, targetingKey) -> Map<experimentId, {runId, variantName}>`
- **Left side:** the evaluate Worker (consumer)
- **Right side:** Workers KV (read replica of first-touch records)
- **Failure contract:** KV error → fall through to `assign()` (self-healing, may momentarily
  break holdover); missing entry → normal new-Entity path
- **Deletion test:** passes — KV is the real read adapter; an in-memory map (test fake) is
  the test-time substitute; both implement the same `getAll` interface

## Sources

- [ADR-0007](../../adr/0007-assignment-store-is-a-sibling-seam-not-behind-the-provider.md)
- [ADR-0008](../../adr/0008-assignment-store-is-dumb-storage-policy-on-the-evaluate-path.md)
- [ADR-0009](../../adr/0009-assignment-store-substrate-kv-read-do-write.md)
- [ADR-0006](../../adr/0006-run-boundary-sticky-experience-counted-in-old-run.md)
- [architecture/assignment-store-seam.md](../../architecture/assignment-store-seam.md)
