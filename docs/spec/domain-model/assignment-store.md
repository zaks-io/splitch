# Assignment Store: interface, key structure, and failure contract

The single piece of durable per-Entity state on the experiment seam. Enables sticky experience at Run boundaries.

## What it is

The Assignment Store persists `(Experiment, idType, Targeting Key) -> (runId, Variant)`, written once at an Entity's first Exposure and read eagerly on the evaluate path. It is the equivalent of Statsig's **Persistent Assignment** and GrowthBook's **Sticky Bucketing** store.

**It is a sibling seam to the Provider, never behind it.** The Provider is a stateless read-side flag-config resolver. The Assignment Store persists per-Entity experiment state. The evaluate path consults both. (ADR-0007.)

## Interface

```
AssignmentStore.getAll(
  app_id:         string,
  environment_id: string,
  id_type:        string,
  targetingKey:   string
) -> Map<experiment_id, { run_id: string; variant: string }>
```

Returns all holdovers for this Entity across all Experiments in the Environment in one edge-local read. `environment_id` co-scopes alongside `app_id` since Experiments and their Runs are per-Environment (ADR-0027). The evaluate path calls this once per request, before iterating flags.

```
AssignmentStore.put(
  experiment_id: string,
  id_type:       string,
  targetingKey:  string,
  run_id:        string,
  variant:       string
) -> void
```

First-touch write. Called by the Exposure pipeline after the first raw Exposure for this Entity/Experiment. The store enforces put-if-absent semantics — a second put for the same key is a no-op.

**Map key:** `experiment_id` string. The evaluate path looks up `held[experiment_id]`. The key is always the `experiment_id` string, never the full object.

## Key structure

Logical key: `(experiment_id, id_type, Targeting Key)`.
Physical key: `(experiment_id, id_type, targeting_key_hash)`, where the hash is derived by the
Assignment Store substrate before constructing KV keys or DO names. `environment_id` is not part of
the key because an Experiment belongs to exactly one Environment (ADR-0027); `experiment_id` already
implies it. `getAll` filters to the request's Environment via that binding.

**Why `id_type` is in the key:** guards against Targeting Key value collision across Entity types. If two Experiments use different `id_type`s, their Targeting Key namespaces may overlap (a userId `"abc"` and a workspaceId `"abc"` are different Entities). `id_type` is always required, never defaulted from Experiment config, even when the Experiment pins one Entity type.

## Value structure

`{ run_id: string; variant: string }`

Both fields are load-bearing:

- `variant` — what to replay when serving a holdover (the Variant name, not value)
- `run_id` — which Run owns this Entity's Exposures; without it, "counted in old Run" is unimplementable

## Storage substrate

| Operation                 | Substrate                                     | Why                                                                                                   |
| ------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `getAll` (hot-path read)  | Workers KV                                    | Edge-local (~10ms hot reads), read-heavy; no DO hop on evaluate                                       |
| `put` (first-touch write) | Durable Object per key, then KV write-through | Single-threaded, globally-unique; atomic get-then-put-if-absent; two POPs cannot both win first-touch |

DO grain: one DO per `(experiment_id, id_type, targeting_key_hash)`. Fine-grained is correct — coarser DOs create a bottleneck; per-key DOs have zero cross-key contention, idle cheaply, and are the Cloudflare-documented pattern. (ADR-0009)

## DO atomicity rule

The DO's `get → decide → put-if-absent` must execute within `blockConcurrencyWhile` (or equivalent input-gate) with no non-storage I/O between get and put. Violating this risks two concurrent requests both "winning" first-touch.

## Failure contract

| Failure                                            | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KV write-through fails after DO commit             | DO is truth; KV miss is self-healing. Next `getAll` from any POP misses KV and recomputes `assign()` fresh. Because `assign()` is deterministic (ADR-0001) and the salt/allocation are frozen (same Run), the recomputed Variant is identical to what the DO stored. **No Run dataset is corrupted; no Entity sees the wrong Variant.** The cosmetic glitch (one extra Exposure fired by the fresh assign path) deduplicates in the pipeline; the DO still stamps the holdover on the next put attempt. |
| DO process crash mid-write (after get, before put) | DO state is Cloudflare-durable; next request to the same DO key re-executes put-if-absent idempotently. The pipeline's at-least-once Exposure delivery retries the Exposure, which re-triggers the put.                                                                                                                                                                                                                                                                                                 |
| KV read returns stale value near Run boundary      | At most ~60s window. The fresh `assign()` is deterministic and yields the correct Variant (same as what would have been replayed). Accepted cosmetic glitch; self-healing. (ADR-0009)                                                                                                                                                                                                                                                                                                                   |

**No distributed transaction on the hot path.** The experience (DO) and analysis (log) each self-correct independently.

## Policy boundary

The Assignment Store has **zero policy**. It does not:

- Evaluate the holdover predicate
- Call `assign()`
- Decide whether to write
- Choose which Run is live

All policy lives on the evaluate path. The store is dumb get/put so the evaluate path is a readable straight line where every branch is explicit. (ADR-0008)

## Retention

Holdover records for ended Runs are retained until the Experiment is archived or deleted. On Experiment archive, all Assignment Store records for that `experiment_id` are pruned (hard-delete, since the Experiment's raw log is the system of record for replay).

## Seam cleanliness

**Deletion test:** two real adapters exist — Statsig `IUserPersistentStorage` and GrowthBook `StickyBucketService`. Both are swappable ports the evaluation engine consults. The seam is real by the two-adapter rule. If collapsed behind the Provider, per-Entity write state would be forced onto every Provider implementation (including stateless ones like flagd), violating the OpenFeature evaluate/track boundary. The seam earns its keep.

## Sources

- [ADR-0006](../../adr/0006-run-boundary-sticky-experience-counted-in-old-run.md)
- [ADR-0007](../../adr/0007-assignment-store-is-a-sibling-seam-not-behind-the-provider.md)
- [ADR-0008](../../adr/0008-assignment-store-is-dumb-storage-policy-on-the-evaluate-path.md)
- [ADR-0009](../../adr/0009-assignment-store-substrate-kv-read-do-write.md)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [assignment-store-seam.md](../../architecture/assignment-store-seam.md)
