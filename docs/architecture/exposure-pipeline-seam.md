# The Exposure pipeline seam

Status: designed (no code yet). Output of an upfront architecture grill on 2026-06-20.
Vocabulary: domain terms per [CONTEXT.md](../../CONTEXT.md); architecture terms (module, seam, adapter,
depth, locality) per the deepening discipline. Builds on the
[Assignment / Exposure seam](./assignment-exposure-seam.md) and the
[Assignment Store seam](./assignment-store-seam.md).

## Where this came from

Three prior ADRs handed obligations to this seam without specifying it: ADR-0004 (Exposures fire on read →
the raw stream is many-per-Entity), ADR-0005 (dedup is first-touch and the pipeline is authoritative,
deliberately un-collapsed on the wire), and ADR-0009 (the pipeline drives the holdover `put`). This grill
specifies the seam: how the raw stream becomes the trustworthy analysis denominator.

## The spine (ADR-0010): raw append-only log, dedup at query time

ELT, not ETL. Verified against Eppo / GrowthBook / Statsig and general streaming practice (see
[references.md](./references.md)) — it is the unanimous warehouse-native pattern, and the only sane choice
for an edge origin.

```
  5 edge runtimes                                          analysis time
       |                                                        |
   append raw Exposure          +------------------+      windowed dedup query
   (at-least-once,    ───────▶  | raw Exposure log | ───▶  first-touch per (entity, run)
    idempotent key)             |  (append-only,   |       QUALIFY ROW_NUMBER() ... = 1
                                |  system of record)|       (== GROUP BY + MIN(ts))
                                +------------------+              |
                                                                  ▼
                                                      deduped denominator → SRM,
                                                      metrics, Conversion Window anchor
```

- **System of record** = the raw append-only log. Each POP just appends; no global ordering needed.
- **Dedup** = a re-runnable windowed query at analysis time, not a collapse at ingest. First-touch
  (`MIN(ts)`) per `(entity, run)`.
- **Delivery** = at-least-once + idempotent dedup key. Never exactly-once. (Industry-settled: Kafka,
  Snowplow, Segment, BigQuery all dedup downstream by key, earliest wins.)

Why this fits the edge specifically: five POPs give no global ordering and at-least-once delivery — exactly
where "collapse early" is hardest (needs a global edge dedup store) and "append raw, dedup in query" is
easiest (the deduper sees everything and picks `MIN(ts)`). ADR-0004's intentional redundancy is the correct
*input* to an ELT deduper.

## The dedup query is the one place all the rules live

First-touch, the conflict quarantine, the SRM denominator, and the Conversion Window anchor are all
expressed in (or read from) the single shared dedup query — one definition, centralized per ADR-0005:

```sql
-- one row per (entity, run): the analysis unit
SELECT
  entity, run,
  MIN(ts)                                   AS first_exposure_ts,   -- Conversion Window anchor
  CASE WHEN COUNT(DISTINCT variant) > 1
       THEN '__multiple__'                                          -- ADR-0011 quarantine
       ELSE MAX(variant) END                AS variant
FROM raw_exposures
GROUP BY entity, run
```

## Variant conflict → `__multiple__` (ADR-0011)

An Entity showing >1 distinct Variant in one Run is **excluded from all arms** and surfaced as a health
metric (~1% tolerated). Given pure `assign()` + the authoritative holdover DO + material-edit-opens-new-Run,
a conflict can *only* be a config race, an SDK bug, or an ADR-0003 violation — all defects to surface
loudly. "First-touch wins" would silently bias the timestamp-winning arm; SRM wouldn't catch it. Fail loud.

## Holdover write timing: eager edge write, pipeline reconciles

ADR-0009 has the pipeline drive the holdover `put`, but authoritative first-touch is only known *after* the
batch dedup runs. Splitting the two jobs resolves the timing:

- **Experience (replay now):** the edge fires `DO.putIfAbsent(key, run, variant)` optimistically on apparent
  first-touch. The DO's get-then-put-if-absent (ADR-0009) makes concurrent writers safe — first writer
  wins — so replay works for the *very next* request without waiting for the batch.
- **Analysis (the denominator):** the raw log + batch dedup remains authoritative for SRM and all metrics.

So **the DO is for experience, the log is for analysis** — the same separation the Assignment Store seam
already draws, now extended to the write path. The two can momentarily disagree (the eager write guesses
first-touch; the batch confirms it), and that is fine: the DO only governs what a returning Entity *sees*,
never what the analysis *counts*.

## SRM reads the same denominator as everything else

SRM compares **observed deduped first-touch unique Entities per arm per Run** (the `__multiple__` bucket
excluded) against the Run's **declared allocation**, via chi-square. Crucially it uses the *same*
denominator definition as every metric and the Conversion Window anchor — one notion of "how many Entities
in each arm," never two. A second (raw-count) denominator was rejected as a reconciliation/debt source.

## Why this is a deep seam

A narrow interface — "append a raw Exposure" in, "deduped first-touch denominator" out — sits in front of:
at-least-once edge ingestion across five runtimes, idempotent dedup, first-touch anchoring, conflict
quarantine, SRM, and the holdover write reconciliation. All the correctness lives in one re-runnable query
plus one idempotent append, which is exactly the locality the deletion test rewards: delete the seam and
this logic smears across every analysis query and every edge runtime.

## Threads handed forward

- The **Conversion Window** mechanics (how post-first-touch events attribute to Metrics) build on the
  `first_exposure_ts` anchor this seam produces — the Metric/analysis seam.
- The **Activation Metric** gate (ADR-deferred from the original Assignment/Exposure grill) re-anchors
  first-touch to the activation event; it composes with this dedup query and is its own grill.
