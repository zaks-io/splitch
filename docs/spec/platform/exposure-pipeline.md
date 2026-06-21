# Exposure pipeline: raw log as system of record; first-touch dedup at query time

ELT, not ETL. The raw Exposure log is the system of record. Dedup is a re-runnable windowed query
at analysis time — never a collapse at ingest.

## Delivery contract

- **At-least-once, idempotent ingest.** Never exactly-once. Five edge runtimes give no global
  ordering and at-least-once delivery — "append raw, dedup in query" is the correct fit. Wire-level
  idempotency uses a retry-stable `event_id` plus the sha256 `dedup_key` defined in
  [pipeline/exposure-event-contract.md](../pipeline/exposure-event-contract.md).
- **First-touch identity** = the tuple `(app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash)`,
  resolved by `MIN(server_ts)` at query time. Many raw Exposure rows for the same Entity/Run share
  this identity; the query picks the earliest `server_ts` as the first-touch winner. The tuple is
  schema-stable — new fields do not change it. This is distinct from the wire-level `dedup_key`
  (a per-physical-row idempotency key); see the pipeline contract for the `dedup_key` construction.
- **Two timestamps per Exposure row:**
  - `server_ts` (canonical): server-received-at. Monotonic, no client clock skew. Used for
    `MIN(ts)` first-touch ordering and Conversion Window anchor.
  - `ingest_ts` (watermark only): raw-log append time. Used for snapshot/tail freshness boundaries,
    never for first-touch or Metric windows.
  - `client_ts` (diagnostics only): client-fired time. Never used for analysis ordering.

## Raw Exposure row schema

```
ExposureRow {
  // First-touch identity components (resolved by MIN(server_ts) at query time)
  app_id:           string    // required — tenant scope
  environment_id:   string    // required — co-scoped with app_id; Exposures are per-Environment (ADR-0027)
  experiment_id:    string    // required
  run_id:           string    // required — stamped at SDK fire-time from liveRunId in config
  id_type:          string    // required — Entity type (e.g. "user", "workspace")
  targeting_key_hash:    string    // required, HMAC-derived Entity identity

  // Event fields
  event_id:        string    // required — retry-stable physical raw-row id
  dedup_key:       string    // required — hashes type + identity + source_id + event_id
  source_id:       string    // required — POP identifier
  variant:          string    // required — Variant name assigned
  server_ts:        datetime  // required — server-received-at (canonical)
  ingest_ts:        datetime  // required — raw-log append watermark, not analysis time
  client_ts:        datetime  // optional — client-fired-at (diagnostics)
  type:             'exposure' | 'activation'  // required — discriminator

  // Activation-only fields (null for exposure rows)
  counterfactual:   boolean | null  // additive marker for counterfactual triggering (ADR-0013)
}
```

`run_id` is stamped at SDK fire-time from the `liveRunId` present in the resolved flag config.
It is never inferred at pipeline ingest-time. This ensures the Run boundary is anchored to the
config the SDK actually evaluated against, not a server-side lookup at log time.

## Canonical dedup query (single source of truth)

```sql
-- First-touch per (entity, run). One row per Entity per Run.
SELECT
  targeting_key_hash,
  environment_id,
  experiment_id,
  run_id,
  MIN(server_ts) AS first_exposure_ts,
  CASE WHEN COUNT(DISTINCT variant) > 1
       THEN '__multiple__'
       ELSE MAX(variant) END AS variant
FROM raw_exposures
WHERE app_id = {{String(app_id)}}
GROUP BY targeting_key_hash, environment_id, experiment_id, run_id
```

This query is the single place where first-touch, the `__multiple__` quarantine, the SRM
denominator, and the Conversion Window anchor are all defined. It must never be hand-copied —
the lambda snapshot and the real-time tail both derive from this definition (ADR-0024).

## Variant conflict: `__multiple__` quarantine (ADR-0011)

An Entity showing >1 distinct Variant in one Run is excluded from all arms and surfaced as a health
metric. A conflict can only arise from a config race, SDK bug, or material-edit violation — all
defects to surface loudly. Silently awarding "first-touch wins" would bias the timestamp-winning
arm without catching it in SRM.

Tolerated rate: ~1%. Above that, the Experiment's results are flagged as suspect.

## SRM denominator

SRM uses the same deduped first-touch unique-Entity-per-arm-per-Run count (`__multiple__` excluded)
that metrics and the Conversion Window anchor use. One denominator definition everywhere. Chi-square
vs the Run's declared allocation. A second raw-count denominator does not exist.

## Holdover write timing: eager edge write, pipeline confirms

- **Experience:** the edge fires `DO.putIfAbsent(key, runId, variant)` optimistically on apparent
  first-touch. The DO's get-then-put-if-absent (ADR-0009) makes concurrent writers safe.
- **Analysis:** the raw log + batch dedup is authoritative for SRM and all metrics.

The two can momentarily disagree (the eager DO write guesses first-touch; the batch confirms it).
This is accepted and the failure contract is identical to the Assignment Store: DO governs
experience, log governs analysis.

## Accepted integrity gap: DO winner vs. MIN(server_ts) winner may differ

In a POP race, two Exposures for the same Entity in the same Run arrive at their respective POPs
nearly simultaneously. The first POP to call `DO.putIfAbsent` wins and becomes the experience
winner — the Entity will replay that Variant. But if the second POP's Exposure has an earlier
`server_ts`, the batch dedup (`MIN(server_ts)`) counts the second POP's Exposure as first-touch
for analysis — counting a Variant the Entity did not actually see.

This is an accepted, bounded gap:

- It can only occur during a narrow race window at first-touch.
- Both Variants assigned must be from the same Run's valid allocation.
- The Entity is still deduplicated to a single row (not double-counted).
- SRM and analysis denominators are correct (one Entity, one Run, one counted Exposure).
- The discrepancy is cosmetic (experience showed Variant A, analysis attributes Variant A or B
  depending on which `server_ts` was earlier) and self-consistent within each plane.

This is explicitly **not** a dataset corruption: the Run's dataset is sound; only a single
Entity's experience-vs-counted-variant may momentarily disagree. Accepted over the alternative
(making DO writes synchronously confirm the batch dedup `MIN(ts)` winner — impractical at edge).

## Activation events

Activation events are rows on the same log with `type = 'activation'`. They share the same
first-touch identity tuple and carry their own `event_id` and wire `dedup_key` (same sha256 construction as
Exposure rows; see [pipeline/exposure-event-contract.md](../pipeline/exposure-event-contract.md)).
Counterfactual triggering adds `counterfactual = true` — an additive column, not a
schema change (ADR-0013). The activation gate seam joins activation rows to the deduped Exposure
output at analysis time.

## Sources

- [../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md)
- [../../adr/0004-exposure-fires-on-read.md](../../adr/0004-exposure-fires-on-read.md)
- [../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md](../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md)
- [../../adr/0011-conflicting-variant-entities-quarantined-to-multiple.md](../../adr/0011-conflicting-variant-entities-quarantined-to-multiple.md)
- [../../adr/0013-activation-is-a-first-class-event-counterfactual-triggering-is-additive.md](../../adr/0013-activation-is-a-first-class-event-counterfactual-triggering-is-additive.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../architecture/exposure-pipeline-seam.md](../../architecture/exposure-pipeline-seam.md)
