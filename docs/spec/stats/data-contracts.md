# Stats engine: input contract and seam interface

The input boundary between the Exposure pipeline / Activation gate and the stats engine, plus the
`StatsEngine` function signature. Output (result) shapes live in
[result-contracts.md](result-contracts.md). Every field the engine reads is named here.

## Input contract from Exposure pipeline

The engine reads **per-Entity rows** — one per (Entity, Run) — from the shared first-touch dedup
query (ADR-0010); `__multiple__` Entities are already excluded upstream.

### Deduped Exposure row

| Field              | Type                       | Required | Meaning                                                       |
|--------------------|----------------------------|----------|---------------------------------------------------------------|
| `entity_id`        | `string`                   | yes      | Targeting Key value (the randomization unit)                  |
| `id_type`          | `string`                   | yes      | Entity type label (e.g. `"user"`, `"workspace"`)             |
| `run_id`           | `string`                   | yes      | The Run this Exposure belongs to                              |
| `variant`          | `string`                   | yes      | Variant name assigned to this Entity in this Run             |
| `first_exposure_ts`| `timestamp`                | yes      | `MIN(server_ts)` — the Conversion Window anchor (ungated)    |
| `window_anchor`    | `timestamp`                | yes      | `COALESCE(activation_ts, first_exposure_ts)` — effective anchor |

`window_anchor` is computed by the Activation gate layer (see
[../pipeline/activation-gate-query-contract.md](../pipeline/activation-gate-query-contract.md));
absent a gate it equals `first_exposure_ts`.

### Per-Entity Metric value row

For each (Entity, Run, Metric) the pipeline delivers values pre-aggregated in Tinybird (materialized
views for Binomial / Count / Revenue; query-time for Ratio pairs). The engine **never receives
event-level rows** — that loses the covariance term for Ratio delta-method variance (ADR-0015).

| Field          | Type      | Required | Meaning                                                             |
|----------------|-----------|----------|---------------------------------------------------------------------|
| `entity_id`    | `string`  | yes      | Matches the deduped Exposure row                                    |
| `run_id`       | `string`  | yes      | Same Run scope                                                      |
| `metric_id`    | `string`  | yes      | References Metric definition                                        |
| `metric_type`  | `enum`    | yes      | `binomial \| count \| revenue \| ratio`                            |
| `value`        | `number`  | yes      | Per-Entity aggregate (0/1 for binomial; sum for count/revenue)      |
| `num_value`    | `number`  | cond.    | Ratio numerator per-Entity sum (required when `metric_type=ratio`)  |
| `denom_value`  | `number`  | cond.    | Ratio denominator per-Entity sum (required when `metric_type=ratio`)|
| `in_window`    | `boolean` | yes      | True if event fell within `[window_anchor, window_anchor + window_duration)` |

The `num_value` / `denom_value` pair for Ratio Metrics is the **hard input-contract rule**: it must
arrive as a per-Entity pair so the delta-method covariance term is computable — unrecoverable after
independent aggregation. Rows with `denom_value = 0` are retained; dropping them would change the
randomized population and can bias denominator-sensitive Metrics.

### Pre-period covariate row (CUPED input)

Supplied only when CUPED applies (pre-period data present, coverage above threshold).

| Field             | Type      | Required | Meaning                                                       |
|-------------------|-----------|----------|---------------------------------------------------------------|
| `entity_id`       | `string`  | yes      | Same Entity                                                   |
| `metric_id`       | `string`  | yes      | Same Metric                                                   |
| `pre_period_value`| `number`  | yes      | Metric value in `[first_exposure_ts - lookback, first_exposure_ts)` |
| `covariate_source`| `enum`    | yes      | `pre_period \| declared_attribute \| historical_attribute`    |

Pre-period is **always anchored at `first_exposure_ts`**, even when the Conversion Window re-anchors
to `activation_ts`. Immutable: it captures what the Entity did before
exposure, not before activation.

### Activation rows (when Activation gate is set)

| Field              | Type      | Required | Meaning                                              |
|--------------------|-----------|----------|------------------------------------------------------|
| `entity_id`        | `string`  | yes      |                                                      |
| `run_id`           | `string`  | yes      |                                                      |
| `activation_ts`    | `timestamp`| yes     | `MIN(activation_ts)` per (Entity, Run)               |
| `counterfactual`   | `boolean` | yes      | `true` for Control-arm would-have-activated (v1: always `false`) |
| `activated`        | `boolean` | yes      | `true` if activation event exists with `activation_ts > first_exposure_ts` |

Un-activated Entities (`activated = false`) are excluded from gated analysis but still counted in
the full-exposed SRM denominator.

## Seam interface

```
interface StatsEngine {
  // Compute results for one Run's Metrics
  analyze(input: StatsInput): Promise<StatsOutput>;
}

interface StatsInput {
  run_id: string;
  confidence_level: number;              // default 0.95
  horizon: 'sequential' | 'fixed';      // default 'sequential'
  target_n?: integer;                    // sequential tuning, locked at Run Start when set
  sample_size_locked?: integer;          // required when horizon='fixed'
  decision_family: DecisionFamilyMember[]; // locked goal Metric × Variant × Primary Dimension family
  exposures: DedupeExposureRow[];
  metric_values: PerEntityMetricRow[];
  pre_period_covariates?: PrePeriodRow[];
  activation_rows?: ActivationRow[];
}

interface DecisionFamilyMember {
  metric_id: string;
  variant: string;                       // non-Control Variant
  dimension_id?: string | null;
  dimension_value?: string | null;
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

The engine is a **pure function**: same input → same output, no internal state. All state lives in
Tinybird (raw log + deduped snapshots), not the engine.

## Sources

- [../../adr/0015-variance-delta-method-aggregate-to-randomization-unit.md](../../adr/0015-variance-delta-method-aggregate-to-randomization-unit.md)
- [../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md](../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md)
- [../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md)
- [../../architecture/metric-analysis-seam.md](../../architecture/metric-analysis-seam.md)
- [../../architecture/activation-gate-seam.md](../../architecture/activation-gate-seam.md)
- [Deng, Knoblich, and Lu, Applying the Delta Method in Metric Analytics](https://arxiv.org/abs/1803.06336)
