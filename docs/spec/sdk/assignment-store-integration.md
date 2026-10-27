# SDK integration with the Assignment Store

How the evaluate path consumes the Assignment Store (holdover pre-load, ordering, fallback).
The Evaluation Worker consumes the Assignment Store. The HTTP SDK does not access KV or Durable
Objects directly.

## Assignment Store interface (from architecture seam)

```
interface AssignmentStore:
  getAll({ appId, idType, targetingKey, identityVersion? })
    -> Promise<Map<experimentId: string, { runId: string; variant: string }>>
  put({ appId, experimentId, idType, targetingKey, runId, variant,
        identityVersion?, sourceCreatedAtMs? }) -> Promise<{ status, assignment }>
  putHashed({ appId, experimentId, idType, targetingKeyHash, runId, variant,
              identityVersion?, sourceCreatedAtMs? }) -> Promise<{ status, assignment }>
```

The evaluate policy calls only `getAll`. Exposure-pipeline orchestration hosted by the Evaluation Worker calls
`put` after Event Ingest durably accepts the Exposure; the per-Entity Durable Object resolves concurrent
apparent first-touch writes (ADR-0064). The SDK never accesses the store, and Event Ingest never owns this call.

`getAll` is a **per-Entity batch read**: its logical key is `(appId, idType, targetingKey)` — note it
does **not** take `experimentId`. One round-trip returns every Experiment's holdover for this
Entity as `Map<experimentId, {runId, variant}>`, so the evaluate path reads holdovers once
per request, not once per flag. The Map key is an `experimentId` string; the evaluate path
accesses `held.get(experimentId)`. The Durable Object that serializes `put` is addressed by
`(appId, idType, targetingKeyHash)` and stores entries per Experiment. One Entity's Experiment
writes share a serializer so their read-merge-writes cannot overwrite the same KV blob. The
Assignment Store derives `targetingKeyHash` before touching KV or Durable Objects. Ticket
redemption calls `putHashed` because a ticket contains only the pseudonym, never the raw key.

## Evaluate-path ordering (no superposition)

The Worker executes in this order for every `evaluate` call:

```
1. Validate credential (Client Key or API Key via KV)
2. Load Provider Flag Configuration for `flagKey` (version-aware cache; committed changes
   propagate within five seconds)
3. Determine if flagKey is controlled by a live Experiment; get experimentId and liveRunId
4. Validate request idType against the Experiment's pinned idType
5. held = AssignmentStore.getAll({appId, idType: validatedIdType, targetingKey})
   [KV read, edge-local, all experiments]

6. if experimentId in held:
     variant = held[experimentId].variant      // holdover: replay prior Variant
     // no Exposure fires, no Assignment Store write: already counted under held[experimentId].runId
   else:
     variant = assign(liveRun, targetingKey)        // pure hash (ADR-0001)
     // Atomically seal Evaluation claim + retry-stable Exposure in Event Ingest outbox
     // Seal failure returns fail-loud and performs no Assignment Store write
7. For a fresh Exposure, await AssignmentStore.put → durable first-touch winner → KV write-through
   Return VariantValue only after the write and identity revalidation succeed
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

- **Replay, no re-compute:** holdover always returns `held[exp].variant` verbatim.
  `assign()` is never called for a holdover Entity. This is correct even if the new Run's
  assignment config differs — the holdover Entity keeps its prior Variant (sticky experience,
  ADR-0006).
- **No new Exposure for holdovers:** the pipeline must NOT fire a new Exposure for a
  holdover read. The holdover Entity is still counted under `held[exp].runId` (its original
  Run), not the live Run. The holdover is invisible to the new Run's analysis denominator.
- **No Assignment Store write on holdover read:** the Worker does not call `put` for a
  holdover. The entry already exists; the DO's `putIfAbsent` would be a no-op anyway, but
  the Worker skips the round-trip.

## Assignment Store read failure

A KV infrastructure read failure or a present-but-malformed blob raises `AssignmentStoreError`.
The evaluate path returns `reason: ERROR` with `INTERNAL_SERVER_ERROR`, logs the failure, and
produces no Exposure decision. It never treats a failed production KV read as an empty holdover map.
Conflicting records across retained identity epochs fail the same way.

A KV miss is different: it returns an empty map and allows the normal new-Entity path. The shared
evaluator still warns and falls through for an untyped error from another adapter; production
`KvAssignmentStore` wraps infrastructure and parse failures in the typed error.

## Transient boundary window (ADR-0009, ADR-0064)

For up to ~60s after a Run-boundary first-touch write (DO → KV write-through), a concurrent
cross-POP read may miss the holdover in KV and compute a fresh `assign()`. Because `assign()`
is deterministic within one frozen Run (ADR-0001), same-Run repeats agree. Across a Run boundary,
a returning Entity may temporarily receive a fresh Variant instead of its prior one, and its
Exposure can count in the new Run (SPL-812). See the propagation window in
[holdover-and-replay-policy.md](../evaluation/holdover-and-replay-policy.md); different Runs are not
guaranteed to produce the same Variant.

## Write path: not SDK's concern

The `put` call that creates holdover entries flows:

```
evaluate() → atomically seal Evaluation claim + Exposure outbox
           → await AssignmentStore.put → durable winner + KV write-through → return success
           → Queue/Tinybird delivery proceeds asynchronously
```

The SDK client is not involved in this write path. The Evaluation Worker reads holdovers via
`getAll` and establishes them through Exposure
orchestration. An Assignment Store failure after the Exposure seal returns `503 SERVICE_UNAVAILABLE`;
the accepted Exposure remains durable. Even after a successful KV write, there is a lag before the
holdover is readable at other POPs (the DO to KV propagation). During this lag,
a second evaluate call from a different POP may re-compute `assign()` (new Entity path) and
fire a second raw Exposure — both raw Exposures resolve to first-touch in the pipeline.
The sticky experience converges once KV propagates.

## Seam boundary

- **Port:** `AssignmentStore.getAll({ appId, idType, targetingKey }) -> Promise<Map<experimentId, {runId, variant}>>`
- **Left side:** the evaluate Worker (consumer)
- **Right side:** Workers KV (read replica of first-touch records)
- **Failure contract:** KV read/parse failure → fail-loud error and no Exposure; missing entry →
  normal new-Entity path
- **Deletion test:** passes — KV is the real read adapter; an in-memory map (test fake) is
  the test-time substitute; both implement the same `getAll` interface

## Sources

- [ADR-0007](../../adr/0007-assignment-store-is-a-sibling-seam-not-behind-the-provider.md)
- [ADR-0008](../../adr/0008-assignment-store-is-dumb-storage-policy-on-the-evaluate-path.md)
- [ADR-0009](../../adr/0009-assignment-store-substrate-kv-read-do-write.md)
- [ADR-0006](../../adr/0006-run-boundary-sticky-experience-counted-in-old-run.md)
- [architecture/assignment-store-seam.md](../../architecture/assignment-store-seam.md)
