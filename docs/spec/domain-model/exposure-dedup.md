# Exposure dedup: first-touch rule, **multiple** quarantine, and SRM denominator

## Dedup rule

**Unique Entities per Run, first-touch.**

An Entity's earliest Exposure in a Run is the one that counts and anchors its Conversion Window. Repeat reads, sessions, and edge nodes do not add to the count.

**Why first-touch, not any-touch:** the Conversion Window anchors to the first Exposure timestamp. A later anchor would allow post-treatment behavior to bias the window (an Entity who took longer to convert anchors later, selectively extending their window). First-touch is a correctness rule, not just a convention.

## Dedup layers

| Layer          | Role                                                                                                                | Authority                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| SDK seen-set   | Hot-path wire optimization; suppresses re-fire within one SDK instance per `(experiment_id, run_id)`                | Optimization only; not authoritative |
| Pipeline dedup | `GROUP BY (app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash)` + `MIN(server_received_at)` | Correctness authority                |

The SDK seen-set is **per-`(experiment_id, run_id)`** so a Run boundary correctly lets a fresh Exposure fire under the new Run. The seen-set is per-instance only; across five edge runtimes, per-node sets cannot be the source of truth. The pipeline dedup is the only authoritative deduplication.

## The **multiple** quarantine

When an Entity's raw Exposures show **more than one distinct Variant within a single Run**, the dedup query places the Entity in the `__multiple__` sentinel bucket and **excludes it from all real arms.**

### Dedup query expression (shape, not literal SQL)

```sql
SELECT
  app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash,
  MIN(server_received_at) AS first_ts,
  CASE
    WHEN COUNT(DISTINCT variant) > 1 THEN '__multiple__'
    ELSE MAX(variant)
  END AS assigned_variant
FROM raw_events
WHERE type = 'exposure'
GROUP BY app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash
```

The `__multiple__` sentinel is not a real Variant. It is excluded from:

- All real arms / analysis
- SRM denominator
- Conversion Window anchor
- Metric aggregations

It is surfaced as its own **health metric** (rate of `__multiple__` Entities per Run). ~1% tolerated; above this rate signals a real defect.

### Why not first-touch-wins

Given pure `assign()` (ADR-0001), an authoritative per-key holdover DO (ADR-0009), and assignment-edit-opens-new-Run (ADR-0003), a same-Run Variant conflict can only mean one of three defects:

1. Config-propagation race (salt/allocation mid-flight across POPs)
2. SDK bug or bad integration bypassing the holdover read
3. Salt/allocation change without opening a new Run (direct ADR-0003 violation)

First-touch-wins would silently bias whichever arm won the timestamp race. SRM would not reliably catch it because the Entity still counts cleanly in one arm — a corrupted Experiment behind a green dashboard. `__multiple__` fails loudly. (ADR-0011)

## SRM denominator

SRM chi-square compares:

- **Observed:** deduped first-touch unique Entities per arm per Run (`__multiple__` excluded)
- **Expected:** Run's declared `allocation` (e.g. `{ "control": 50, "treatment": 50 }`)

**One denominator everywhere.** The SRM denominator is the same as the Metric analysis denominator and the Conversion Window anchor population. "How many Entities are in each arm" has exactly one definition in splitch, never two.

## Session as Dimension, not denominator

Session is a **Dimension** (an attribute for slicing results), never the denominator unit. The denominator is always unique Entities per Run, first-touch. Variance is always computed over per-Entity aggregates (`COUNT DISTINCT` Entity, not events or sessions). (CONTEXT.md, ADR-0015)

## Peek accessor (non-exposing path)

The SDK `peekVariant(...)` accessor resolves the Variant **without** firing an Exposure. No Exposure row is written. Peeked Entities:

- Are **not** counted in the SRM denominator
- Have **no** Conversion Window anchor
- Are **not** eligible for analysis
- Do **not** trigger a holdover write

This is the correct deferral path (e.g. below-the-fold UI that may never render). The accessor name must be distinct and loud — not a parameter on the standard `getVariant()` call.

## Sources

- [ADR-0004](../../adr/0004-exposure-fires-on-read.md)
- [ADR-0005](../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md)
- [ADR-0010](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md)
- [ADR-0011](../../adr/0011-conflicting-variant-entities-quarantined-to-multiple.md)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [exposure-pipeline-seam.md](../../architecture/exposure-pipeline-seam.md)
