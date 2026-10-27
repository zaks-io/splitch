# Assignment Store: interface, key structure, and failure contract

The single piece of durable per-Entity state on the experiment seam. Enables sticky experience at Run boundaries.

## What it is

The Assignment Store persists `(Experiment, idType, Targeting Key) -> (runId, Variant)`, written once at an Entity's first Exposure and read eagerly on the evaluate path. It is the equivalent of Statsig's **Persistent Assignment** and GrowthBook's **Sticky Bucketing** store.

**It is a sibling seam to the Provider, never behind it.** The Provider is a stateless read-side flag-config resolver. The Assignment Store persists per-Entity experiment state. The evaluate path consults both. (ADR-0007.)

## Interface

```
AssignmentStore.getAll({ appId, idType, targetingKey, identityVersion? })
  -> Map<experimentId, { runId: string; variant: string }>

AssignmentStore.put({ appId, experimentId, idType, targetingKey, runId, variant,
                      identityVersion?, sourceCreatedAtMs? })
  -> { status: "stored" | "existing"; assignment: { runId; variant } }

AssignmentStore.putHashed({ appId, experimentId, idType, targetingKeyHash, runId, variant,
                            identityVersion?, sourceCreatedAtMs? })
  -> { status: "stored" | "existing"; assignment: { runId; variant } }
```

`getAll` returns all holdovers for this Entity across every Experiment in the App in one edge-local
read. It takes no `environmentId`: an Experiment belongs to exactly one Environment (ADR-0027), so
`experimentId` already implies it, and the evaluate path only looks up the controlling Experiment's
entry. Bulk resolution memoizes the read per Entity.

`put` is the first-touch write with put-if-absent semantics: a second put for the same Entity and
Experiment returns `existing` with the stored winner. `putHashed` serves Exposure Ticket redemption,
where the raw Targeting Key never rides in the ticket.

**Map key:** `experimentId` string. The evaluate path looks up `held[experimentId]`.

## Key structure

Logical key: `(appId, experimentId, idType, Targeting Key)`.
Physical KV key: `assignment:{appId}:{idType}:{targetingKeyHash}`, one per-Entity blob holding an
entry per Experiment. The substrate derives `targetingKeyHash` before constructing KV keys or DO
names; the raw Targeting Key is never stored.

**Why `id_type` is in the key:** guards against Targeting Key value collision across Entity types. If two Experiments use different `id_type`s, their Targeting Key namespaces may overlap (a userId `"abc"` and a workspaceId `"abc"` are different Entities). `id_type` is always required, never defaulted from Experiment config, even when the Experiment pins one Entity type.

## Value structure

`{ runId: string; variant: string }`

Both fields are load-bearing:

- `variant` — what to replay when serving a holdover (the Variant name, not value)
- `runId` — which Run owns this Entity's Exposures; without it, "counted in old Run" is unimplementable

## Storage substrate

| Operation                 | Substrate                                                | Why                                                                                                   |
| ------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `getAll` (hot-path read)  | Workers KV                                               | Edge-local (~10ms hot reads), read-heavy; no DO hop on evaluate                                       |
| `put` (first-touch write) | Durable Object per Entity, then awaited KV write-through | Single-threaded, globally unique; atomic get-then-put-if-absent; two POPs cannot both win first-touch |

DO grain: one writer per `(appId, idType, targetingKeyHash)`, storing one entry per Experiment. Every
Experiment write for an Entity shares that serialization point so concurrent read-merge-writes
cannot clobber the shared KV blob.

## DO atomicity rule

The DO's `get → decide → put-if-absent` must execute within `blockConcurrencyWhile` (or equivalent input-gate) with no non-storage I/O between get and put. Violating this risks two concurrent requests both "winning" first-touch.

## Failure contract

| Failure                                       | Behavior                                                                                                                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Holdover write fails after the Exposure seals | Remote `evaluate` awaits `put` and returns `503`; the durably accepted Exposure is not undone. Exposure Ticket redemption also retries through the durable holdover-write outbox. |
| KV write-through fails after DO commit        | DO is truth. The awaited write fails the request; a later `put` returns the stored winner and reasserts it in KV.                                                                 |
| KV read misses near a Run boundary            | A miss is an empty read and may cause fresh resolution until propagation catches up. The fresh `assign()` is deterministic for the same Run.                                      |
| KV read error or malformed record             | `AssignmentStoreError`; evaluation fails loudly and produces no Exposure decision. Conflicting retained-epoch records fail the same way.                                          |

**No distributed transaction on the hot path.** The experience (DO) and analysis (log) each self-correct independently.

## Policy boundary

The Assignment Store has **zero policy**. It does not:

- Evaluate the holdover predicate
- Call `assign()`
- Decide whether to write
- Choose which Run is live

All policy decisions live in evaluate orchestration. The store is dumb get/put. Exposure-pipeline
orchestration hosted by the Evaluation Worker dispatches the decided write only after Event Ingest
durably accepts the Exposure. (ADR-0008)

## Retention

Holdover records for ended Runs are retained until the Experiment is archived or deleted. On Experiment archive, all Assignment Store records for that `experiment_id` are pruned (hard-delete, since the Experiment's raw log is the system of record for replay). Archive pruning is not implemented yet: Experiment archive does not touch the Assignment Store, so records currently persist until App or Entity deletion purges them.

## Seam cleanliness

**Deletion test:** two real adapters exist — Statsig `IUserPersistentStorage` and GrowthBook `StickyBucketService`. Both are swappable ports the evaluation engine consults. The seam is real by the two-adapter rule. If collapsed behind the Provider, per-Entity write state would be forced onto every Provider implementation (including stateless ones like flagd), violating the OpenFeature evaluate/track boundary. The seam earns its keep.

## Sources

- [ADR-0006](../../adr/0006-run-boundary-sticky-experience-counted-in-old-run.md)
- [ADR-0007](../../adr/0007-assignment-store-is-a-sibling-seam-not-behind-the-provider.md)
- [ADR-0008](../../adr/0008-assignment-store-is-dumb-storage-policy-on-the-evaluate-path.md)
- [ADR-0009](../../adr/0009-assignment-store-substrate-kv-read-do-write.md)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [assignment-store-seam.md](../../architecture/assignment-store-seam.md)
