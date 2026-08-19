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
- **Not a dedup authority** — the pipeline dedup query (`MIN(server_received_at)` per `(entity, run)`)
  is always correct regardless of what the seen-set contains

## Seen-set key

The seen-set keeps **two** concerns under one Exposure slot. They must not share a
single undifferentiated key:

```
ExposureKey = (flagKey, runId, idType, targetingKey)
ValueKey    = (ExposureKey, attributesFingerprint)
```

`attributesFingerprint` is a stable serialization of the Evaluation Context
`attributes` map (sorted keys, so insertion order does not affect equality). An
empty / omitted attribute map fingerprints as `{}`.

| Concern              | Key           | Behavior within the revalidation window                                       |
| -------------------- | ------------- | ----------------------------------------------------------------------------- |
| Exposure suppression | `ExposureKey` | One Exposure per Entity/Run. Attribute churn must not fire a second Exposure. |
| Value replay         | `ValueKey`    | A cached Variant is valid only for the attribute set that produced it.        |

`idType` is required in the Exposure key because Entity identity is `(idType, targetingKey)`:
"user 42" and "workspace 42" are different Entities that may hold different Variants,
so one must never replay the other's cached value.

The cached value depends on which path wrote the entry:

- **Exposure-bearing `evaluate` (miss):** the WIRE variant is stored. A 200 no-match
  (`variant: null`) is cached as an explicit no-match marker, and a `CACHED` replay
  re-applies the CURRENT call's Default Variant — one call site's local `defaultValue`
  must never leak into another's result from a wire null.
- **Context-miss (`verify` re-resolve):** the resolved `details.value` is stored for
  every non-ERROR reason, including `DEFAULT` and `DISABLED`. A later `CACHED` replay
  returns that same served value so identical inputs cannot flip between the server
  result and the caller's `defaultValue`.

`runId` is required in the Exposure key. Without it, a Run-boundary event would be
incorrectly suppressed:

- Entity is exposed under Run N → seen-set entry created for `(flagKey, runN, targetingKey)`.
- Experiment starts (assignment edit → new Run N+1 opens).
- Entity evaluates again → seen-set key `(flagKey, runN+1, targetingKey)` is absent.
- Fresh Exposure fires under Run N+1. Correct.

Without `runId`, the key `(flagKey, targetingKey)` would suppress the Run N+1 Exposure,
causing under-exposure in the new Run — a correctness error, not just an optimization gap.

### Attributes and value replay

Replaying a resolved Variant across different Evaluation Contexts is incorrect: a
Targeting Rule that keys on an attribute (for example `plan`) can resolve a different
arm when attributes change. The seen-set therefore:

1. **Value hit** — same `ExposureKey` and same `attributesFingerprint` within the
   window → `reason: CACHED`, no transport call, no second Exposure.
2. **Context miss** — same `ExposureKey` still fresh, but `attributesFingerprint`
   differs → re-resolve the Variant through the non-exposing `verify` transport
   (Client Key and API Key), cache the resolved `details.value` under its fingerprint
   (including `DEFAULT` / `DISABLED`; never collapse those to a null marker), and
   return the live reason (not `CACHED`). No second Exposure-bearing `evaluate`.
3. **Miss** — never seen, or past the revalidation window → Exposure-bearing
   `evaluate` as today.

Never serve a plausible wrong value from cache. A cache may only replay a result for
inputs that would resolve identically.

### Bounded optimistic suppression for a pure-HTTP client (revalidation TTL)

The Exposure key above assumes the SDK already knows the **current** `runId` before it decides to
suppress. A pure-HTTP client does not: the public data-plane response is the bare
`{ variant, variantName }` (non-revealing, ADR-0018: which arm, never how it was chosen) and the
SDK only learns the live `runId` **from** an evaluate call — the very call a seen-set hit is trying
to skip. The `runId` is surfaced as non-revealing operational metadata alongside the body (an
`X-Run-Id` response header), not inside it, so the response schema stays closed.

This creates a circular dependency: keying on the **last-seen** `runId` and short-circuiting
on it forever would make a long-lived instance (browser SPA, warm Worker — the normal case)
**never** detect a new Run, re-introducing exactly the Run N+1 under-exposure above.

The seen-set resolves this with a **revalidation window** (`revalidateMs`, default `60_000`,
matching the browser client's revalidation interval):

- A repeat **within** the window short-circuits to `CACHED` (no call, no Exposure) — the dedup
  benefit is preserved for the hot repeat case.
- A repeat **past** the window is treated as a **miss**: the SDK re-contacts the server, which
  returns the current `runId` via `X-Run-Id`. A **new** `runId` there stores a new entry and
  fires a fresh Exposure under the new Run.

A Run boundary is therefore detected within **at most `revalidateMs`** (not "never", and not
"immediately" — an HTTP client cannot detect it before any call). The per-instance / pipeline
authority model (below) bounds the worst case: the pipeline dedup is always correct regardless
of seen-set staleness, and the seen-set is a wire optimization, not the dedup authority.

## Capacity and eviction

```
SeenSet config {
  maxSize:             number    -- client option; LRU capacity for Exposure identities; default 10,000
  revalidateMs:        number    -- client option; revalidation window; default 60,000 (see above)
  maxValuesPerEntry:   number    -- internal constant (not a client option); LRU capacity for
                                    attribute fingerprints per identity; default 64
  evictionPolicy:      'lru'     -- least-recently-used eviction when at capacity
}
```

When at Exposure-identity capacity, the oldest identity is evicted. The evicted entry may cause a
redundant Exposure on the next `evaluate` call — acceptable, because the pipeline dedup collapses
it. Within one identity, attribute-fingerprint values are also LRU-capped so high-cardinality
context churn cannot grow unbounded inside a single TTL window; an evicted fingerprint re-resolves
via the context-miss path (no second Exposure while the identity is still fresh). Exposing
`maxValuesPerEntry` as a client option is a separate slice; 64 is the shipped internal default.

## What the seen-set does NOT prevent

The seen-set suppresses within a single SDK instance. It does NOT prevent:

- Multiple raw Exposures from different POPs (cross-POP is expected; pipeline deduplicates)
- Multiple raw Exposures across Worker restarts (cold starts have empty seen-sets)
- Duplicate Exposures from parallel `evaluate` calls before the seen-set is updated
  (the pipeline is still correct; the seam-finding on parallel evaluates is documented below)

## Seam finding: parallel evaluate calls

If two concurrent `evaluate(sameFlag, sameContext)` calls race within one SDK instance,
both may miss the seen-set (it is updated after the HTTP response) and both fire Exposures.
The pipeline dedup collapses them correctly (`MIN(server_received_at)` picks first-touch). This is
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
  (wire optimization)                 per (entity, run) via MIN(server_received_at)
         |                                        |
  NOT the source of truth             IS the source of truth
```

The two layers do different jobs. Deleting the seen-set is always safe — it causes more
network calls, not incorrect analysis.

## Sources

- [ADR-0004](../../adr/0004-exposure-fires-on-read.md)
- [ADR-0005](../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md)
