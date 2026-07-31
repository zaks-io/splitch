# Assignment Store port — durable holdover memory

The Assignment Store is **dumb storage and zero policy**. It answers exactly one question:
"what Variant did this Entity see, and under which Run?" The evaluate policy module owns the holdover
predicate, replay-vs-assign decision, and write intent. Exposure-pipeline orchestration, hosted by the
same Evaluation Worker, owns write timing after durable Event Ingest acceptance.

## Port interface

```
interface AssignmentStore {
  // Eager pre-load: one edge-local read fetches all holdovers for this Entity.
  // Returns a map keyed by experimentId (string). Empty map if Entity has no holdovers.
  getAll(appId: string, idType: string, targetingKey: string): Map<string, HoldoverRecord>

  // First-touch write: called by Exposure orchestration after durable Event Ingest acceptance.
  // Durable Object ensures exactly one winner per key across concurrent POPs.
  put(appId: string, experimentId: string, idType: string, targetingKey: string, runId: string, variant: string): void
}

interface HoldoverRecord {
  runId: string    // which Run owns this Entity's Exposures
  variant: string  // what Variant to replay for sticky experience
}
```

## Key shape

Logical key: `(appId, experimentId, idType, targetingKey)` — four components, all required.
Physical key: `(appId, experimentId, idType, targetingKeyHash)`, derived inside the substrate before
touching KV or Durable Objects. Callers never pass the hash.

| Component      | Type   | Why load-bearing                                                                                                                                                                                                                |
| -------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appId`        | string | Isolation boundary; prevents cross-App key collisions                                                                                                                                                                           |
| `experimentId` | string | Scopes to one Experiment                                                                                                                                                                                                        |
| `idType`       | string | Guards against Targeting Key _value_ collisions across Entity types (e.g. a session ID string that equals a user ID string). Mirrors Statsig's `<userID>:<idType>` keying. Explicit even when an Experiment has one Entity type |
| `targetingKey` | string | The Entity identifier within the Experiment's idType                                                                                                                                                                            |

`getAll` takes `(appId, idType, targetingKey)` without `experimentId` — one call returns
holdovers for **all Experiments** this Entity has been exposed in, as a map keyed by
`experimentId`. This single read pre-loads the evaluate path's entire holdover context.

## Value shape

`HoldoverRecord { runId, variant }` — both fields are load-bearing:

- **`runId`** — which Run owns this Entity's Exposures. Without it, ADR-0006's
  "counted in the old Run" is unimplementable. The Exposure pipeline stamps new Exposures
  with the stored `runId` for holdovers (they remain attributed to the original Run).
- **`variant`** — what Variant to replay for sticky experience. `assign()` cannot recompute
  it once the Run's frozen config is archived.

## Read model (eager pre-load)

One `getAll` call at request start pre-loads all holdovers into an in-memory map before
any flag is resolved. Each per-flag decision is then a map lookup: `O(1)`, no I/O.
Chosen over lazy per-Experiment fetch because the hot path across five edge runtimes
benefits from front-loaded round-trips.

Substrate: Workers KV, edge-local (~10ms hot reads, eventually consistent). No Durable
Object is touched on the read path.

## Write model (first-touch only)

`put()` is called by **Exposure-pipeline orchestration hosted in the Evaluation Worker**, not by the
evaluate policy module or public SDK accessor. The policy module resolves and hands off the Exposure.
After Event Ingest durably seals it, the orchestration schedules `put()` at apparent first-touch.

Substrate: one Durable Object per `(appId, experimentId, idType, targetingKeyHash)`. The DO's
`get-then-put-if-absent` is atomic (single-threaded, globally unique per key), so two
concurrent POPs cannot both win first-touch. On commit, the DO write-throughs to KV.

## Holdover write failure contract

- **DO is truth.** `putIfAbsent` is the authoritative first-touch winner.
- **KV write-through failure is self-healing.** A KV miss causes the next `evaluate()` to
  recompute `assign()` deterministically (same Variant for a new Entity; same Variant for a
  returning holdover if KV misses until propagation). No dataset corruption — the DO still
  holds the one true first-touch winner.
- **Raw-log append is independent, at-least-once.** Retried with the wire-level `dedup_key`
  (per-physical-row idempotency key; see [../pipeline/exposure-event-contract.md](../pipeline/exposure-event-contract.md)).
- **No distributed transaction on the hot path.** Experience (DO) and analysis (log) each
  self-correct.

## Policy-free contract

The store does not:

- Call `assign()`
- Decide whether to replay or assign
- Branch on runId or Variant values
- Know anything about Runs, Targeting rules, or Exposures

These are evaluate-path concerns (see [evaluate-path-orchestration.md](./evaluate-path-orchestration.md)).

## Seam boundary

**What's on this side (Assignment Store):** logical `(appId, idType, targetingKey)` → `(runId, variant)` memory, stored physically by `targetingKeyHash`. Get/put.

**What's on the other side (Evaluation Worker):** evaluate policy owns the holdover predicate, replay
decision, Exposure firing, and write intent; Exposure orchestration owns write timing after durable
Event Ingest acceptance.

**Deletion test:** two real adapters exist in the wild — Statsig `IUserPersistentStorage`,
GrowthBook `StickyBucketService`. Both are swappable ports the evaluation engine consults,
never baked into the resolver. Seam is real.

## Sources

- [../../adr/0007-assignment-store-is-a-sibling-seam-not-behind-the-provider.md](../../adr/0007-assignment-store-is-a-sibling-seam-not-behind-the-provider.md)
- [../../adr/0008-assignment-store-is-dumb-storage-policy-on-the-evaluate-path.md](../../adr/0008-assignment-store-is-dumb-storage-policy-on-the-evaluate-path.md)
- [../../adr/0009-assignment-store-substrate-kv-read-do-write.md](../../adr/0009-assignment-store-substrate-kv-read-do-write.md)
- [../platform/privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md)
- [../../architecture/assignment-store-seam.md](../../architecture/assignment-store-seam.md) (interface, load model)
