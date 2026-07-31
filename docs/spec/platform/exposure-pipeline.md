# Exposure pipeline: raw log as system of record; first-touch dedup at query time

ELT, not ETL. The raw Exposure log is the system of record. Dedup is a re-runnable windowed query
at analysis time — never a collapse at ingest.

**Implementation status:** the ADR-0043 queue-backed transport below is accepted but pending. The
current Event Ingest Worker posts one implemented row per Tinybird request.

## Delivery contract

- **At-least-once, idempotent ingest.** Never exactly-once. Five edge runtimes give no global
  ordering and at-least-once delivery — "append raw, dedup in query" is the correct fit. Wire-level
  idempotency uses a retry-stable `event_id` plus the sha256 `dedup_key` defined in
  [pipeline/exposure-event-contract.md](../pipeline/exposure-event-contract.md).
- **Queue-backed microbatch transport.** The Event Ingest Worker durably queues accepted rows and
  sends datasource-specific gzip-compressed NDJSON batches to Tinybird. Intake handlers never issue
  one Tinybird request per row.
- **Weighted admission before durable acceptance.** New canonical `raw_events` rows consume row and
  serialized queue-payload byte capacity from the Ingest Admission Gate scoped to
  `(app_id, environment_id, raw_events)`. Existing idempotent retries that require no new delivery
  consume zero capacity. Gate failure returns `429 RATE_LIMITED` before durable acceptance; valid
  rows are never sampled or silently dropped.
- **First-touch identity** = the tuple `(app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash)`,
  resolved by `MIN(server_received_at)` at query time. Many raw Exposure rows for the same Entity/Run share
  this identity; the query picks the earliest `server_received_at` as the first-touch winner. The tuple is
  schema-stable — new fields do not change it. This is distinct from the wire-level `dedup_key`
  (a per-physical-row idempotency key); see the pipeline contract for the `dedup_key` construction.
- **Two timestamps per Exposure row:**
  - `server_received_at` (canonical): server-received-at. Monotonic, no client clock skew. Used for
    `MIN(ts)` first-touch ordering and Conversion Window anchor.
  - `ingest_ts` (watermark only): Tinybird insertion time, assigned by datasource
    `DEFAULT now64(3)` and omitted by producers. Used for snapshot/tail freshness boundaries, never
    for first-touch or Metric windows.
  - `client_timestamp` (diagnostics only): client-fired time. Never used for analysis ordering.

## Raw Exposure row schema

The canonical raw-row shape (all fields, both `type = 'exposure'` and `type = 'activation'`) lives in
[pipeline/exposure-event-contract.md](../pipeline/exposure-event-contract.md) and its physical
Tinybird form in [contracts/storage-schemas-tinybird.md](../../spec/contracts/storage-schemas-tinybird.md).
**Do not redefine the row here.** What matters at this layer:

- **First-touch identity components** (resolved by `MIN(server_received_at)` at query time):
  `(app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash)`. `environment_id`
  is co-scoped with `app_id` — Exposures are per-Environment (ADR-0027). `environment_id`,
  `experiment_id`, and `id_type` are functionally determined by `run_id`; the determinant is
  `(targeting_key_hash, run_id)`.
- **`run_id`** is stamped at SDK fire-time from the `liveRunId` present in the resolved flag config.
  It is never inferred at pipeline ingest-time. This ensures the Run boundary is anchored to the
  config the SDK actually evaluated against, not a server-side lookup at log time.

## Canonical dedup query

The first-touch dedup query — the single place where first-touch, the `__multiple__` quarantine,
the SRM denominator, and the Conversion Window anchor are all defined — lives in
[pipeline/dedup-query-contract.md](../pipeline/dedup-query-contract.md). **Do not re-state it here.**
The lambda snapshot and the real-time tail both derive from that one definition (ADR-0024); a second
copy in this file would be exactly the drift the "never hand-copied" rule forbids.

The dedup groups over the first-touch identity tuple
`(app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash)`, with
`(targeting_key_hash, run_id)` as the determinant (the rest are run-implied carry-through columns).
Reads `raw_events` rows where `type = 'exposure'`.

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

- **Experience:** after Event Ingest durably seals the retry-stable Exposure outbox row, the edge
  fires `DO.putIfAbsent(key, runId, variant)` optimistically on apparent first-touch. The DO's
  get-then-put-if-absent (ADR-0009) makes concurrent writers safe.
- **Analysis:** the raw log + batch dedup is authoritative for SRM and all metrics.

The two can momentarily disagree (the eager DO write guesses first-touch; the batch confirms it).
This is accepted and the failure contract is identical to the Assignment Store: DO governs
experience, log governs analysis.

## Accepted integrity gap: DO winner vs. MIN(server_received_at) winner may differ

In a POP race, two Exposures for the same Entity in the same Run arrive at their respective POPs
nearly simultaneously. The first POP to call `DO.putIfAbsent` wins and becomes the experience
winner — the Entity will replay that Variant. But if the second POP's Exposure has an earlier
`server_received_at`, the batch dedup (`MIN(server_received_at)`) counts the second POP's Exposure as first-touch
for analysis — counting a Variant the Entity did not actually see.

This is an accepted, bounded gap:

- It can only occur during a narrow race window at first-touch.
- Both Variants assigned must be from the same Run's valid allocation.
- The Entity is still deduplicated to a single row (not double-counted).
- SRM and analysis denominators are correct (one Entity, one Run, one counted Exposure).
- The discrepancy is cosmetic (experience showed Variant A, analysis attributes Variant A or B
  depending on which `server_received_at` was earlier) and self-consistent within each plane.

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
- [../../adr/0043-event-ingest-will-use-durable-queue-backed-tinybird-microbatches.md](../../adr/0043-event-ingest-will-use-durable-queue-backed-tinybird-microbatches.md)
- [../../architecture/exposure-pipeline-seam.md](../../architecture/exposure-pipeline-seam.md)
