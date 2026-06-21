# Stats engine: result (output) contracts

The output shapes the stats engine writes to the UI/API — the members of `StatsOutput`. The input
contract and `StatsEngine` signature live in [data-contracts.md](data-contracts.md).

## Per-arm result object (one per (Variant, Metric))

| Field                   | Type                   | Meaning                                                             |
|-------------------------|------------------------|---------------------------------------------------------------------|
| `variant`               | `string`               | Variant name                                                        |
| `metric_id`             | `string`               |                                                                     |
| `sample_size_n`         | `integer`              | Unique Entities in this arm (deduped)                               |
| `point_estimate`        | `number`               | Per-Entity mean for this arm                                        |
| `relative_lift_pct`     | `number \| null`       | `(treatment - control) / control × 100`; null for Control arm      |
| `ci_lower`              | `number`               | Always-valid CI lower bound (relative-lift %)                       |
| `ci_upper`              | `number`               | Always-valid CI upper bound (relative-lift %)                       |
| `p_value`               | `number`               | Always-valid p-value (valid under continuous peeking)               |
| `is_significant`        | `boolean`              | After Benjamini-Hochberg FDR correction                             |
| `status`                | `enum`                 | `running \| ready \| stopped`                                       |
| `variance_techniques`   | `VarianceTechniques`   | Which variance-reduction methods applied (see below)                |

## VarianceTechniques object (never silent)

| Field                | Type                              | Meaning                                                    |
|----------------------|-----------------------------------|------------------------------------------------------------|
| `winsorized`         | `boolean`                         | True if winsorization was applied                          |
| `winsorize_pct`      | `number \| null`                  | Percentile used (e.g., `99.9`); null if not winsorized     |
| `cuped_applied`      | `boolean`                         | True if CUPED adjustment was applied                       |
| `cuped_method`       | `enum \| null`                    | `pre_period \| attribute_covariate \| none`               |
| `cuped_attribute`    | `string \| null`                  | Named attribute used (for `attribute_covariate`)           |
| `cuped_coverage_pct` | `number \| null`                  | Fraction of Entities with pre-period data (0–100)          |
| `delta_method`       | `boolean`                         | True if delta method was applied (always true for Ratio)   |

## SRM result object

| Field                   | Type      | Meaning                                                    |
|-------------------------|-----------|------------------------------------------------------------|
| `srm_p_value`           | `number`  | Chi-square p-value over full-exposed deduped denominator   |
| `srm_is_mismatch`       | `boolean` | `true` if `srm_p_value < 0.001`                            |
| `observed_counts`       | `Record<variant, integer>` | Deduped first-touch Entity counts per arm    |
| `expected_counts`       | `Record<variant, integer>` | Expected counts per declared allocation      |
| `activated_srm_p_value` | `number \| null`   | Chi-square on activated population; null if no gate  |
| `activated_srm_mismatch`| `boolean \| null`  | `true` if `activated_srm_p_value < 0.001`            |

## Guardrail result object

| Field              | Type      | Meaning                                                        |
|--------------------|-----------|----------------------------------------------------------------|
| `metric_id`        | `string`  |                                                                |
| `variant`          | `string`  |                                                                |
| `ci_lower`         | `number`  | Relative-lift CI lower bound                                   |
| `threshold`        | `number`  | Downside threshold declared on the Metric                      |
| `is_breached`      | `boolean` | `true` if `ci_lower < threshold`                               |
| `breach_reason`    | `string \| null` | E.g., `"CI lower bound −0.02 < threshold −0.005"`        |

## Health metrics object

| Field                | Type                       | Meaning                                                    |
|----------------------|----------------------------|------------------------------------------------------------|
| `multiple_rate`      | `number`                   | Fraction of Entities in `__multiple__` bucket              |
| `activation_rates`   | `Record<variant, number> \| null` | Per-arm activation rate; null if no gate          |
| `exposure_counts`    | `Record<variant, integer>` | Raw (pre-dedup) Exposure counts per arm                    |

Dimension result shapes (`DimensionResult`) are defined in
[dimension-slicing.md](dimension-slicing.md).

## Sources

- [../../adr/0015-variance-delta-method-aggregate-to-randomization-unit.md](../../adr/0015-variance-delta-method-aggregate-to-randomization-unit.md)
- [../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md](../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md)
- [../../architecture/metric-analysis-seam.md](../../architecture/metric-analysis-seam.md)
