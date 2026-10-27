# The Exposure pipeline seam

Status: reference design. Output of an upfront architecture grill on 2026-06-20.
Vocabulary: domain terms per [CONTEXT.md](../../CONTEXT.md); architecture terms (module, seam, adapter,
depth, locality) per the deepening discipline. Builds on the
[Assignment / Exposure seam](./assignment-exposure-seam.md) and the
[Assignment Store seam](./assignment-store-seam.md).

## Where this came from

Three prior ADRs handed obligations to this seam without specifying it: ADR-0004 (Exposures fire on read →
the raw stream is many-per-Entity), ADR-0005 (dedup is first-touch and the pipeline is authoritative,
deliberately un-collapsed on the wire), and ADR-0009 (the pipeline drives the holdover `put`). This grill
specifies the seam: how the raw stream becomes the trustworthy analysis denominator.

## The spine (ADR-0010/0024): raw append-only log, snapshot plus deduped tail

ELT, not ETL. Verified against Eppo / GrowthBook / Statsig and general streaming practice (see
[references.md](./references.md)) — it is the unanimous warehouse-native pattern, and the only sane choice
for an edge origin.

```
  5 edge runtimes                                          analysis time
       |                                                        |
   append raw Exposure          +------------------+      snapshot + raw-tail query
   (at-least-once,    ───────▶  | raw Exposure log | ───▶  first-touch per (entity, run)
    idempotent key)             |  (append-only,   |       QUALIFY ROW_NUMBER() ... = 1
                                |  system of record)|       (== GROUP BY + MIN(ts))
                                +------------------+              |
                                                                  ▼
                                                      deduped denominator → SRM,
                                                      metrics, Conversion Window anchor
```

- **System of record** = the raw append-only log. Each POP just appends; no global ordering needed.
- **Dedup** = a re-runnable first-touch reducer, not a collapse at ingest.
  `cp_deduped_exposures` replaces the snapshot; `serve_deduped_exposures` unions it with raw
  rows whose `ingest_ts` is at or after the snapshot watermark, then re-dedups the overlap.
  First-touch is `MIN(exposure_at)`, the encounter clock, not delivery receipt time (ADR-0049).
- **Delivery** = at-least-once + idempotent dedup key. Never exactly-once. Downstream dedup by
  key and earliest timestamp owns first-touch.

Why this fits the edge specifically: five POPs give no global ordering and at-least-once delivery — exactly
where "collapse early" is hardest (needs a global edge dedup store) and "append raw, dedup in query" is
easiest (the deduper sees everything and picks `MIN(ts)`). ADR-0004's intentional redundancy is the correct
_input_ to an ELT deduper.

## The dedup query is the one place all the rules live

First-touch, conflict quarantine, the SRM denominator, and the Conversion Window anchor share the
logical reducer below. The deployed Copy and serving Pipes apply it across the snapshot and raw tail:

```sql
-- one row per (entity, run): the analysis unit
SELECT
  app_id, environment_id, experiment_id, run_id, id_type, entity_family_hash,
  MIN(exposure_at) AS first_exposure_ts,
  CASE WHEN countIf(isNull(variant)) > 0 OR COUNT(DISTINCT variant) > 1
       THEN '__multiple__'
       ELSE MAX(assumeNotNull(variant)) END AS variant
FROM raw_events
WHERE type = 'exposure'
GROUP BY app_id, environment_id, experiment_id, run_id, id_type, entity_family_hash
```

`app_id` and `environment_id` ride the `GROUP BY` as carried scope columns, not because they change which
rows collapse — Exposures are per-Environment (ADR-0027), so every downstream consumer (SRM, Metrics, the
Activation gate) receives them. The canonical column list lives in
[dedup-query-contract.md](../spec/pipeline/dedup-query-contract.md).

## Variant conflict → `__multiple__` (ADR-0011)

An Entity showing >1 distinct Variant in one Run is **excluded from all arms** and surfaced as a health
metric (~1% tolerated). Given pure `assign()` + the authoritative holdover DO + material-edit-opens-new-Run,
a conflict can _only_ be a config race, an SDK bug, or an ADR-0003 violation — all defects to surface
loudly. "First-touch wins" would silently bias the timestamp-winning arm; SRM wouldn't catch it. Fail loud.

## Holdover write timing: after durable Exposure acceptance

ADR-0009 has the pipeline drive the holdover `put`, but authoritative first-touch is only known _after_ the
batch dedup runs. Splitting the two jobs resolves the timing:

- **Experience (replay now):** after Event Ingest durably seals the retry-stable Exposure outbox row,
  the Evaluation Worker writes through the App inventory to the Assignment Store. The per-Entity
  DO keeps one first writer per Experiment and awaits KV write-through. A failed inline write
  returns an error for retry; Exposure Ticket redemption additionally uses a durable holdover
  outbox. KV propagation can still delay replay on a later request.
- **Analysis (the denominator):** the raw log + snapshot/tail dedup remains authoritative for SRM and all metrics.

The DO governs replay experience; the log governs analysis. Their winners may differ because the
DO serializes write arrival while first-touch analysis uses the earliest encounter time. Analysis
does not reconcile its denominator by overwriting the holdover winner.

## SRM reads the same denominator as everything else

SRM compares **observed deduped first-touch unique Entities per arm per Run** (the `__multiple__` bucket
excluded) against the Run's **declared allocation**. `analysis-v2` uses an ingestion-ordered sequential
Dirichlet-multinomial martingale; legacy and `analysis-v1` use chi-square. The Control Plane persists
observed v2 alarm crossings in D1 `run_srm_alarms`. Every version uses the _same_
denominator definition as every metric and the Conversion Window anchor — one notion of "how many Entities
in each arm," never two. A second (raw-count) denominator was rejected as a reconciliation/debt source.

## Why this is a deep seam

A narrow interface — "append a raw Exposure" in, "deduped first-touch denominator" out — sits in front of:
at-least-once edge ingestion across five runtimes, idempotent dedup, first-touch anchoring, conflict
quarantine, SRM, and post-seal holdover writes. All the correctness lives in one re-runnable query
plus one idempotent append, which is exactly the locality the deletion test rewards: delete the seam and
this logic smears across every analysis query and every edge runtime.

## Threads handed forward

- The **Conversion Window** mechanics (how post-first-touch events attribute to Metrics) build on the
  `first_exposure_ts` anchor this seam produces — the Metric/analysis seam.
- The **Activation Metric** gate re-anchors first-touch to the activation event; it composes with this
  dedup query. Designed in the [Activation gate seam](./activation-gate-seam.md) (ADR-0012/0013).
