# Stats engine: input contract and seam interface

The input boundary between the Exposure pipeline / Activation gate and the stats engine, plus the
`StatsEngine` function signature. Output (result) shapes live in
[result-contracts.md](result-contracts.md). Every field the engine reads is named here.

## Input contract from Exposure pipeline

The engine reads **per-Entity rows** — one per (Entity, Run) — from the shared first-touch dedup
query (ADR-0010); `__multiple__` Entities are already excluded upstream.

### Deduped Exposure row

| Field                | Type        | Required | Meaning                                                                                                                                            |
| -------------------- | ----------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_id`             | `string`    | yes      | Tenant scope; carried from the dedup output (every dedup row is `app_id`-scoped, ADR-0018)                                                         |
| `targeting_key_hash` | `string`    | yes      | Hash of the Targeting Key — the randomization unit. The raw Targeting Key value is PII and never leaves the pipeline; the engine joins on the hash |
| `environment_id`     | `string`    | yes      | Per-Environment scope (ADR-0027); run-implied, carried from the dedup output for scope-complete handoff                                            |
| `id_type`            | `string`    | yes      | Entity type label (e.g. `"user"`, `"workspace"`)                                                                                                   |
| `run_id`             | `string`    | yes      | The Run this Exposure belongs to                                                                                                                   |
| `variant`            | `string`    | yes      | Variant name assigned to this Entity in this Run                                                                                                   |
| `first_exposure_ts`  | `timestamp` | yes      | `MIN(exposure_at)` — the Conversion Window anchor (ungated)                                                                                        |
| `window_anchor`      | `timestamp` | yes      | `COALESCE(activation_ts, first_exposure_ts)` — effective anchor                                                                                    |
| `dimension_values`   | `object`    | no       | Attribute values available for Dimension slicing, keyed by Dimension id                                                                            |

`window_anchor` is computed by the Activation gate layer (see
[../pipeline/activation-gate-query-contract.md](../pipeline/activation-gate-query-contract.md));
absent a gate it equals `first_exposure_ts`.

### Per-Entity Metric value row

For each (Entity, Run, Metric), the Analysis Worker derives one value after
`serve_deduped_metric_events` has completed its retry-key `argMinMerge`, then aggregates per Entity
and Run. Binomial, Count, Revenue, and both Ratio operands all follow that ordering. No materialized
view reads unmerged Metric aggregate state. The stats engine **never receives event-level rows**;
Ratio inputs remain paired per Entity so the covariance term required by ADR-0015 is preserved.

| Field                | Type      | Required | Meaning                                                                      |
| -------------------- | --------- | -------- | ---------------------------------------------------------------------------- |
| `app_id`             | `string`  | yes      | Same App as the deduped Exposure and Run                                     |
| `environment_id`     | `string`  | yes      | Same Environment as the deduped Exposure and Run                             |
| `id_type`            | `string`  | yes      | Must equal the Run's `targeting_key_type`                                    |
| `targeting_key_hash` | `string`  | yes      | Matches the deduped Exposure row                                             |
| `run_id`             | `string`  | yes      | Same Run scope                                                               |
| `metric_id`          | `string`  | yes      | References Metric definition                                                 |
| `metric_type`        | `enum`    | yes      | `binomial \| count \| revenue \| ratio`                                      |
| `value`              | `number`  | yes      | Per-Entity aggregate (0/1 for binomial; sum for count/revenue)               |
| `num_value`          | `number`  | cond.    | Ratio numerator per-Entity sum (required when `metric_type=ratio`)           |
| `denom_value`        | `number`  | cond.    | Ratio denominator per-Entity sum (required when `metric_type=ratio`)         |
| `in_window`          | `boolean` | yes      | True if event fell within `[window_anchor, window_anchor + window_duration)` |

The `num_value` / `denom_value` pair for Ratio Metrics is the **hard input-contract rule**: it must
arrive as a per-Entity pair so the delta-method covariance term is computable — unrecoverable after
independent aggregation. Rows with `denom_value = 0` are retained; dropping them would change the
randomized population and can bias denominator-sensitive Metrics.

The pipeline derives these values from `serve_deduped_metric_events` after its aggregate-state merge
returns one logical Metric Event per `dedup_key`. A Metric Event joins an Entity only on matching
`app_id`, `environment_id`, `id_type`, and `targeting_key_hash`, and only when
`id_type = Run.targeting_key_type`. Metric selection further requires
`event_definition_id = Metric.event_definition_id` and, for Count and Revenue, the Metric's
`event_field_name` present on that row's accepting Event Definition Version; the Conversion Window
filter then keeps events inside the Entity's window. Ratio Metrics resolve numerator and denominator
independently through each operand Metric's Event Definition and field contract before forming the
per-Entity `(num_value, denom_value)` pair. Metric Events never create denominator rows: the
pipeline left-joins values onto the complete first-touch Exposure population.

An accepted Metric Event that omits an optional selected number field contributes no value for that
Metric. This is a filter, not a numeric default: present values remain strict numeric conversions,
and the Exposure left join is solely responsible for a zero per-Entity aggregate when none remain.

Physical retry rows must never inflate Binomial, Count, Revenue, or Ratio inputs. The mandatory
logical source and ordering are defined in [physical-datasources.md](../pipeline/physical-datasources.md#metric-retry-state-deduped_metric_events_state).

For locked non-Ratio decision-family or Guardrail Metrics, `metric_values` may be sparse at the
beginning of a Run. If no row has arrived for a locked Metric yet, the engine still evaluates that
Metric over the Exposure denominator as zero-valued per-Entity aggregates. This keeps early Binomial,
Count, and Revenue Metrics decision-family-complete without inventing event rows.

### Pre-period covariate row (CUPED input)

Supplied only when CUPED applies (pre-period data present, coverage above threshold).

| Field                | Type     | Required | Meaning                                                             |
| -------------------- | -------- | -------- | ------------------------------------------------------------------- |
| `targeting_key_hash` | `string` | yes      | Same Entity                                                         |
| `metric_id`          | `string` | yes      | Same Metric                                                         |
| `pre_period_value`   | `number` | yes      | Metric value in `[first_exposure_ts - lookback, first_exposure_ts)` |
| `covariate_source`   | `enum`   | yes      | `pre_period \| declared_attribute \| historical_attribute`          |

Pre-period is **always anchored at `first_exposure_ts`**, even when the Conversion Window re-anchors
to `activation_ts`. Immutable: it captures what the Entity did before
exposure, not before activation. CUPED eligibility, selection, and fallback live in
[variance-reduction.md](variance-reduction.md); this document only records which rows the pipes
emit.

### Activation rows (when Activation gate is set)

| Field                | Type        | Required | Meaning                                                                    |
| -------------------- | ----------- | -------- | -------------------------------------------------------------------------- |
| `targeting_key_hash` | `string`    | yes      |                                                                            |
| `run_id`             | `string`    | yes      |                                                                            |
| `activation_ts`      | `timestamp` | yes      | Earliest candidate satisfying `activation_ts > first_exposure_ts`          |
| `counterfactual`     | `boolean`   | yes      | `true` for Control-arm would-have-activated; defaults to `false`           |
| `activated`          | `boolean`   | yes      | `true` if activation event exists with `activation_ts > first_exposure_ts` |

Un-activated Entities (`activated = false`) are excluded from gated analysis but still counted in
the full-exposed SRM denominator. The pipeline applies the post-Exposure predicate to candidate
Activations before `MIN(activation_ts)`; reducing all candidates first is forbidden because one
pre-Exposure event could otherwise hide a later valid Activation.

## Seam interface

```
interface StatsEngine {
  // Compute results for one Run's Metrics
  analyze(input: StatsInput): Promise<StatsOutput>;
}

interface StatsInput {
  run_id: string;
  analysis_version: string;              // frozen at Run Start (ADR-0059); defaults to analysis-v1 for non-Run fixtures
  confidence_level: number;              // default 0.95
  horizon: 'sequential' | 'fixed';       // locked at Run Start; default 'sequential'
  target_n?: integer;                    // sequential tuning, locked at Run Start when set
  sample_size_locked?: integer;          // required when horizon='fixed'
  allocation: Record<string, number>;    // locked Run allocation, percentages keyed by Variant
  control_variant: string;               // locked Control Variant name
  decision_family: DecisionFamilyMember[]; // locked goal Metric × Variant × Primary Dimension family
  guardrail_decisions?: GuardrailDecision[]; // locked Guardrails; defaults to []
  exposures: DedupeExposureRow[];
  metric_values: PerEntityMetricRow[];
  pre_period_covariates?: PrePeriodRow[];
  activation_rows?: ActivationRow[];
  dimensions?: DimensionInput[];
}

interface DecisionFamilyMember {
  metric_id: string;
  variant: string;                       // non-Control Variant
  dimension_id?: string | null;
  dimension_value?: string | null;
}

interface DimensionInput {
  dimension_id: string;
  class: 'primary' | 'secondary';
  values?: string[];                     // declared values; Secondary may infer observed values
}

interface GuardrailDecision {
  metric_id: string;
  variant: string;                       // non-Control Variant
  downside_threshold_pct: number;            // relative-lift CI lower-bound threshold, percent
  guardrail_locked_at_run_start: boolean;
  threshold_locked_at_run_start: boolean;
}

interface StatsOutput {
  arm_results: ArmResult[];
  srm: SrmResult;
  guardrail_results: GuardrailResult[];
  health: HealthMetrics;
  dimension_results?: DimensionResult[];  // if Dimensions declared
}
```

`StatsOutput` member shapes (`ArmResult`, `SrmResult`, `GuardrailResult`, `HealthMetrics`,
`DimensionResult`) are defined in [result-contracts.md](result-contracts.md).

The Run-mode fields are immutable inputs from Run Start. `analysis_version` selects the SRM gate
and family-correction procedure (ADR-0059 version table). `horizon='fixed'` requires
`sample_size_locked` and disables peeking until that locked sample size is reached; sequential Runs
may set `target_n` but must not send `sample_size_locked`. `allocation` and `control_variant` come
from the same locked Run snapshot so SRM, Control selection, and decision families cannot drift
mid-experiment.

`guardrail_decisions` is the optional locked Guardrail family. When omitted, the engine treats it as
empty. When present, Guardrail breach evaluation uses the treatment Arm's Fieller relative-lift CI
lower bound (derived from the absolute decision interval, ADR-0015 rule 4) and only emits a breach
once the Arm is decisionable. The relative interval is decision-bearing for that check; see
[inference-engine.md](inference-engine.md) §Relative-lift CI.

The engine is a **pure function**: same input → same output, no internal state. All retained facts and
derived serving state live in Tinybird (raw logs, the deduped Exposure snapshot, and merged Metric/Web
aggregate states), not the engine.

## Observation process at a watermark (data-entry audit)

This is the Phase 0.1 audit: which units enter each statistic at each refresh, written against
Lindon and Kallus's calendar-time estimand (staggered entry and delayed outcomes, evaluated at a
clock time rather than after every Conversion Window closes). Sequential SRM (item 0.6) must use
this observation contract; it does not invent a different filtration.

The Analysis Worker (`apps/analysis-api/src/results.ts`) builds one `StatsInput` per Results read
and calls the engine, binding `analysis_version` from the Run Snapshot commitments. It does not
incrementally append to a previous `StatsInput`. Counts that look like "new Entities since last
look" are a difference of two full recomputes, not a martingale increment stored on disk. Under
analysis-v2 the sequential SRM gate rebuilds the Entity arrival path from the current watermarked
`StatsInput` (Exposure by `first_ingest_ts`, activated by `activation_ingest_ts`) and evaluates the
martingale after every arrival (running-minimum p). Sticky alarms hold while ingestion before the
pinned watermark is complete. Pinned `dataWatermark` fixes the Entity set, so the path and result
token stay deterministic.

### Evidence watermark

`data_watermark` is an inclusive ingest-time boundary (`ingest_ts <= watermark`), not an
event-time cutoff. Default selection is `max(watermark_ts)` on `deduped_exposures` for the App and
Environment (`infra/tinybird/pipes/analysis_run_inputs.pipe`). A Results read may pin
`dataWatermark` instead. Every downstream pipe receives `ingest_watermark_ts`
(`apps/analysis-api/src/results.ts` `watermarkPipeParams`). Rows whose `ingest_ts` equals the
watermark are in the result ([result-contracts.md](result-contracts.md)).

The Exposure snapshot Copy Pipe (`infra/tinybird/copies/cp_deduped_exposures.pipe`) is
`COPY_MODE replace`, triggered from `apps/analysis-api/src/scheduled.ts`. Each run rebuilds
`deduped_exposures` from `raw_events` with `ingest_ts <= copy_watermark`. It does not append a
delta. A later snapshot can change an Entity's `variant`, `first_exposure_ts`, and arm membership
that an earlier snapshot already published.

Serving (`infra/tinybird/pipes/serve_deduped_exposures.pipe`) unions that snapshot with the raw
tail (`ingest_ts` overlapping the snapshot watermark on both sides) and re-dedups. Overlap is
deliberate so a row landing exactly on the boundary is not lost.

Metric Events freeze membership the same way: `serve_deduped_metric_events` keeps
`ingest_ts <= ingest_watermark_ts` after retry-key `argMinMerge`. The Analysis Worker then scans
`accepted_at` from Run `started_at` through wall-clock `to_ts` (now), so a row accepted and
ingested on the inclusive evidence edge is not dropped by `accepted_at < to_ts`
(`apps/analysis-api/src/results.ts`, `apps/analysis-api/src/results-metric-query.ts`).

Calendar-time reading: at watermark W the published numbers are the analysis of facts ingested by
W, with Conversion Windows on `accepted_at` (and first-touch on `exposure_at`). They are not a
complete delayed-outcome analysis that waits for every Entity's window to close. A later W can
revise earlier Entity-level values.

### Who enters each statistic

| Statistic                                                              | Units that enter                                                                                                                                                                                 | Code                                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Full-exposed SRM `observed_counts`, `health.deduped_counts`            | One row per Entity in this Run with `variant != '__multiple__'`, never truncated                                                                                                                 | `analysis_deduped_exposures.pipe` keeps `__multiple__` rows; `packages/stats/src/exposure-denominator.ts` drops them from arms |
| Metric `sample_size_n` (ungated sequential)                            | The same non-`__multiple__` Entities as full-exposed SRM                                                                                                                                         | `exposure-denominator.ts`; `variance-estimators.ts`                                                                            |
| Metric `sample_size_n` (fixed horizon, gated or ungated)               | The first `sample_size_locked` Entities per arm of that Metric's population (full-exposed or activated), ordered by first Exposure time with a total-order tie-break; later Entities are ignored | `metric-arm-results.ts` passes `fixed_horizon_sample_size`; `variance-estimators.ts` `lockedSample`                            |
| `health.multiple_count` / `multiple_rate`                              | Those `__multiple__` Entities                                                                                                                                                                    | same files; `packages/stats/src/srm-checker.ts`                                                                                |
| Activated SRM, gated Metric denominators                               | Exposed, non-`__multiple__` Entities with a post-Exposure Activation (`activation_ts > first_exposure_ts`)                                                                                       | `analysis_activation_rows.pipe`; gated Metrics also `INNER JOIN` in `analysis_metric_values_batch.pipe`                        |
| Activation balance                                                     | 2 × Variant table of activated vs not-activated among full-exposed (non-`__multiple__`) counts                                                                                                   | `srm-checker.ts` `chiSquareActivationBalance`                                                                                  |
| Per-Entity Metric values (Binomial / Count / Revenue / Ratio operands) | Left join of Metric Events onto the (gated or ungated) Exposure population; missing events are zero, not dropped                                                                                 | `analysis_metric_values_batch.pipe`; engine applies rows with `in_window` in `variance-estimators.ts`                          |
| CUPED pre-period rows                                                  | Non-Ratio Metrics; lookback ends at `first_exposure_ts` even when gated                                                                                                                          | `analysis_pre_period_covariates.pipe` / `_batch`; selection rules: [variance-reduction.md](variance-reduction.md)              |

SRM and health counts are never truncated, so on a fixed-horizon Run they can exceed the Metric
`sample_size_n` (for example 150 exposed Entities per arm against `sample_size_locked = 100`).
The two populations answer different questions and must not be compared as one number.

Counterfactual Activations (`counterfactual = 1`) are excluded in
`analysis_activation_rows.pipe` and the batch Metric pipe. They must not enter the activated
denominator (`exposure-denominator.ts` reads `activated`, not the counterfactual flag).

`analysis_deduped_exposures.pipe` currently emits `window_anchor = first_exposure_ts` because the
pipe cannot read `runs.activation_metric_id`. Gated Conversion Windows are applied in
`analysis_metric_values_batch.pipe` (`activation_gated = 1` sets `window_anchor` to
`min(activation_ts)`). The engine still gates the denominator from `activation_rows`.

### `__multiple__` quarantine (ADR-0011)

Conflict is detected at query time: `countDistinct(variant) > 1` (or a null Variant) in the Copy
Pipe and again on the snapshot-plus-tail union. The Entity is labelled `__multiple__` and excluded
from every real arm, from both SRM denominators, and from Metric sample sizes. It is not
first-touch resolved.

A later watermark **revises** earlier arm counts when a second Variant is ingested for an Entity
that previously sat in one arm. The Entity leaves that arm's SRM and Metric denominators and
appears in `multiple_count`. This is not an iid multinomial increment across watermarks. The
analysis-v2 SRM gate therefore does not continue a prior filtration: it rebuilds the arrival
path from the cleaned watermarked population and re-evaluates (see
[srm-and-health.md](srm-and-health.md#sequential-dirichlet-multinomial-srm-analysis-v2-gate)).
Late delivery of an earlier `exposure_at` can revise `first_exposure_ts` (and therefore windows
and CUPED lookback) without changing Variant; the SRM path still orders by `first_ingest_ts`, so
the Entity's filtration position stays the first ingest, and the path for a later watermark
extends the earlier one when the Entity set only grows.

### Activation gating (ADR-0012)

When `analysis_run_inputs.activation_metric_id` is set, the Worker fetches
`analysis_activation_rows` and passes `activation_gated=1` into the Metric batch pipe
(`results-downstream-rows.ts`). Un-activated Entities are absent from that pipe's output rather
than emitted with `activated = 0`; the engine treats absence and `activated = false` the same.
Full-exposed SRM still uses every non-`__multiple__` Exposure.

A late Activation (ingested after W1, at or before W2) **revises** the gated population: the
Entity enters activated SRM, activation-balance counts, and gated Metric denominators, and its
Conversion Window re-anchors to `activation_ts`. Outcomes that were scored from first Exposure on
an ungated look are not the gated estimand; gated looks never included the Entity until
activation arrived.

### Late conversions

A Metric Event enters an Entity's value when `ingest_ts <= watermark`, `accepted_at` falls in
`[window_anchor, window_anchor + window_duration)` (duration `0` means open-ended), and the Event
Definition / field contract matches. The batch pipe emits `in_window = 1` for every left-joined
Entity, including zeros.

A conversion ingested after W1 **revises** that Entity's `value` / Ratio pair at W2. It does not
append a new denominator row unless the Entity was not yet in the Exposure population. Ratio
zero-denominator Entities stay in the pair ([inference-engine.md](inference-engine.md)).

### What revises versus what appends

At watermark W2 versus W1:

- **Append (new unit):** a newly ingested first Exposure for an Entity that did not appear at W1
  (and is not `__multiple__`).
- **Revise (same unit, new facts):** a late conversion; a late Activation; a later first-touch
  `exposure_at`; a Variant conflict that moves the Entity to `__multiple__`; a Copy Pipe replace
  that rebuilds snapshot keys. Arm counts, SRM chi-square inputs, and Metric means can go down as
  well as up.
- **Not observed:** Metric Events or Activations with `ingest_ts` after W, even if `accepted_at` /
  `activation_ts` is in the window. Re-read at a later watermark to include them.

Diagnostics that bucket by time (`decision-diagnostics.md` SRM trend) recompute this same process
at the submitted `dataWatermark`; they do not replay a stored increment log.

## Sources

- [../../adr/0015-variance-delta-method-aggregate-to-randomization-unit.md](../../adr/0015-variance-delta-method-aggregate-to-randomization-unit.md)
- [../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md](../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md)
- [../../adr/0011-conflicting-variant-entities-quarantined-to-multiple.md](../../adr/0011-conflicting-variant-entities-quarantined-to-multiple.md)
- [../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md)
- [../../architecture/metric-analysis-seam.md](../../architecture/metric-analysis-seam.md)
- [../../architecture/activation-gate-seam.md](../../architecture/activation-gate-seam.md)
- [Deng, Knoblich, and Lu, Applying the Delta Method in Metric Analytics](https://arxiv.org/abs/1803.06336)
- [Lindon and Kallus, Anytime-valid inference under outcome delay and staggered entry](https://arxiv.org/abs/2603.25971)
  (calendar-time estimand for the watermark observation process)
- [Lindon and Malek, Anytime-valid inference for multinomial count data](https://arxiv.org/abs/2011.03567)
  (iid multinomial increments; quarantine and late facts are not that process)
