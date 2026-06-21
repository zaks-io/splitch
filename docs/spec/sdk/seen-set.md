# SDK seen-set: per-instance Exposure dedup cache (optimization only)

The SDK maintains a per-instance in-memory set to avoid redundant Exposure network calls
within a single SDK instance lifetime. It is a hot-path wire optimization — NOT an
authoritative source of truth for dedup (ADR-0005).

## Purpose and scope

The raw Exposure stream is intentionally many-per-Entity (ADR-0004). The pipeline dedup
is the authoritative first-touch gate. The seen-set exists only to reduce network calls
and raw log volume within a single SDK instance — it does not change correctness.

The seen-set is:
- **Per SDK instance** — not shared across Workers, POPs, or processes
- **In-memory** — does not survive a Worker restart or cold start
- **Not a dedup authority** — the pipeline dedup query (`MIN(server_ts)` per `(entity, run)`)
  is always correct regardless of what the seen-set contains

## Seen-set key

```
SeenKey = (flagKey, runId, targetingKey)
```

`runId` is required in the key. Without it, a Run-boundary event would be
incorrectly suppressed:

- Entity is exposed under Run N → seen-set entry created for `(flagKey, runN, targetingKey)`.
- Experiment publishes (assignment edit → new Run N+1 opens).
- Entity evaluates again → seen-set key `(flagKey, runN+1, targetingKey)` is absent.
- Fresh Exposure fires under Run N+1. Correct.

Without `runId`, the key `(flagKey, targetingKey)` would suppress the Run N+1 Exposure,
causing under-exposure in the new Run — a correctness error, not just an optimization gap.

## Capacity and eviction

```
SeenSet config {
  maxSize:        number    -- LRU capacity; default 10,000 entries
  evictionPolicy: 'lru'     -- least-recently-used eviction when at capacity
}
```

When at capacity, the oldest entry is evicted. The evicted entry may cause a redundant
Exposure on the next `evaluate` call — acceptable, because the pipeline dedup collapses it.

## What the seen-set does NOT prevent

The seen-set suppresses within a single SDK instance. It does NOT prevent:
- Multiple raw Exposures from different POPs (cross-POP is expected; pipeline deduplicates)
- Multiple raw Exposures across Worker restarts (cold starts have empty seen-sets)
- Duplicate Exposures from parallel `evaluate` calls before the seen-set is updated
  (the pipeline is still correct; the seam-finding on parallel evaluates is documented below)

## Seam finding: parallel evaluate calls

If two concurrent `evaluate(sameFlag, sameContext)` calls race within one SDK instance,
both may miss the seen-set (it is updated after the HTTP response) and both fire Exposures.
The pipeline dedup collapses them correctly (`MIN(server_ts)` picks first-touch). This is
an acknowledged inherent tension in the expose-on-read model, not a correctness bug. The
SDK documentation must note that calling `evaluate` in parallel for the same flag in the
same request context produces extra raw Exposure rows that are safely deduplicated.

## Debug logging requirement

When the SDK suppresses an Exposure due to a seen-set hit, it MUST emit a DEBUG-level log:

```
[splitch] seen-set hit: suppress Exposure for flagKey=<key> runId=<id> targetingKey=<tk>
```

This allows pipeline operators to verify that SDK suppression and raw log volume are
consistent. Without this log, there is no way to distinguish "SDK suppressed correctly"
from "SDK failed to fire" when debugging low Exposure counts (seam-finding from sdk.json).

## Relationship to pipeline authority

```
SDK seen-set (per-instance)          Pipeline dedup (authoritative)
         |                                        |
  blocks HTTP call if hit             collapses all raw Exposures to first-touch
  (wire optimization)                 per (entity, run) via MIN(server_ts)
         |                                        |
  NOT the source of truth             IS the source of truth
```

The two layers do different jobs. Deleting the seen-set is always safe — it causes more
network calls, not incorrect analysis.

## Sources

- [ADR-0004](../../adr/0004-exposure-fires-on-read.md)
- [ADR-0005](../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md)
