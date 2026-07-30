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
| `first_exposure_ts`  | `timestamp` | yes      | `MIN(server_ts)` — the Conversion Window anchor (ungated)                                                                                          |
| `window_anchor`      | `timestamp` | yes      | `COALESCE(activation_ts, first_exposure_ts)` — effective anchor                                                                                    |
| `dimension_values`   | `object`    | no       | Attribute values available for Dimension slicing, keyed by Dimension id                                                                            |

`window_anchor` is computed by the Activation gate layer (see
[../pipeline/activation-gate-query-contract.md](../pipeline/activation-gate-query-contract.md));
absent a gate it equals `first_exposure_ts`.

### Per-Entity Metric value row

For each (Entity, Run, Metric) the pipeline delivers values pre-aggregated in Tinybird (materialized
views for Binomial / Count / Revenue; query-time for Ratio pairs). The engine **never receives
event-level rows** — that loses the covariance term for Ratio delta-method variance (ADR-0015).

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

The pipeline derives these values from the separate `metric_events` datasource. A Metric Event joins
an Entity only on matching `app_id`, `environment_id`, `id_type`, and `targeting_key_hash`, and only
when `id_type = Run.targeting_key_type`. Metric selection further requires
`event_definition_id = Metric.event_definition_id` and, for Count and Revenue, the Metric's
`event_field_name` present on that row's accepting Event Definition Version; the Conversion Window
filter then keeps events inside the Entity's window. Ratio Metrics resolve numerator and denominator
independently through each operand Metric's Event Definition and field contract before forming the
per-Entity `(num_value, denom_value)` pair. Metric Events never create denominator rows: the
pipeline left-joins values onto the complete first-touch Exposure population.

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
exposure, not before activation.

### Activation rows (when Activation gate is set)

| Field                | Type        | Required | Meaning                                                                    |
| -------------------- | ----------- | -------- | -------------------------------------------------------------------------- |
| `targeting_key_hash` | `string`    | yes      |                                                                            |
| `run_id`             | `string`    | yes      |                                                                            |
| `activation_ts`      | `timestamp` | yes      | `MIN(activation_ts)` per (Entity, Run)                                     |
| `counterfactual`     | `boolean`   | yes      | `true` for Control-arm would-have-activated; defaults to `false`           |
| `activated`          | `boolean`   | yes      | `true` if activation event exists with `activation_ts > first_exposure_ts` |

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
  downside_threshold: number;            // relative-lift CI lower-bound threshold
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

The Run-mode fields are immutable inputs from Run Start. `horizon='fixed'` requires
`sample_size_locked` and disables peeking until that locked sample size is reached; sequential Runs
may set `target_n` but must not send `sample_size_locked`. `allocation` and `control_variant` come
from the same locked Run snapshot so SRM, Control selection, and decision families cannot drift
mid-experiment.

`guardrail_decisions` is the optional locked Guardrail family. When omitted, the engine treats it as
empty. When present, Guardrail breach evaluation uses the treatment Arm's relative-lift CI lower
bound and only emits a breach once the Arm is decisionable.

The engine is a **pure function**: same input → same output, no internal state. All state lives in
Tinybird (raw log + deduped snapshots), not the engine.

## Sources

- [../../adr/0015-variance-delta-method-aggregate-to-randomization-unit.md](../../adr/0015-variance-delta-method-aggregate-to-randomization-unit.md)
- [../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md](../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md)
- [../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md)
- [../../architecture/metric-analysis-seam.md](../../architecture/metric-analysis-seam.md)
- [../../architecture/activation-gate-seam.md](../../architecture/activation-gate-seam.md)
- [Deng, Knoblich, and Lu, Applying the Delta Method in Metric Analytics](https://arxiv.org/abs/1803.06336)
