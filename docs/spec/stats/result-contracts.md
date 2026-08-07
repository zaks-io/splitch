# Stats engine: result (output) contracts

The output shapes the stats engine writes to the UI/API — the members of `StatsOutput`. The input
contract and `StatsEngine` signature live in [data-contracts.md](data-contracts.md).

## Per-arm result object (one per (Variant, Metric))

| Field                 | Type                 | Meaning                                                                                    |
| --------------------- | -------------------- | ------------------------------------------------------------------------------------------ |
| `variant`             | `string`             | Variant name                                                                               |
| `metric_id`           | `string`             |                                                                                            |
| `sample_size_n`       | `integer`            | Unique Entities in this arm (deduped)                                                      |
| `point_estimate`      | `number`             | Per-Entity mean for this arm                                                               |
| `relative_lift_pct`   | `number \| null`     | `(treatment / control - 1) × 100`; null for Control or undefined Control estimate          |
| `ci_lower`            | `number \| null`     | Always-valid CI lower bound (relative-lift %); null for Control or undefined relative lift |
| `ci_upper`            | `number \| null`     | Always-valid CI upper bound (relative-lift %); null for Control or undefined relative lift |
| `p_value`             | `number`             | Always-valid p-value (valid under continuous peeking)                                      |
| `is_significant`      | `boolean`            | After Benjamini-Hochberg FDR correction                                                    |
| `in_bh_family`        | `boolean`            | True only for locked goal Metric × Variant family members                                  |
| `exploratory`         | `boolean`            | True for post-start additions or Secondary outputs                                         |
| `decision_valid`      | `boolean`            | True only when the result belongs to the locked decision spec                              |
| `status`              | `enum`               | `running \| ready \| stopped \| insufficient_denominator \| insufficient_n \| error`       |
| `variance_techniques` | `VarianceTechniques` | Which variance-reduction methods applied (see below)                                       |

## VarianceTechniques object (never silent)

| Field                    | Type                                           | Meaning                                                                                         |
| ------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `winsorized`             | `boolean`                                      | True if winsorization was applied                                                               |
| `winsorize_pct`          | `number \| null`                               | Percentile used (e.g., `99.9`); null if not winsorized                                          |
| `winsorize_cap`          | `number \| { num_value, denom_value } \| null` | Realized pooled cap value; Ratio reports numerator and denominator caps; null if not winsorized |
| `cuped_applied`          | `boolean`                                      | True if CUPED adjustment was applied                                                            |
| `cuped_method`           | `enum \| null`                                 | `pre_period \| attribute_covariate \| none`                                                     |
| `cuped_attribute`        | `string \| null`                               | Named attribute used (for `attribute_covariate`)                                                |
| `cuped_attribute_source` | `enum \| null`                                 | `declared \| pre_period_selected \| historical_selected \| null`                                |
| `cuped_coverage_pct`     | `number \| null`                               | Fraction of Entities with pre-period data (0–100)                                               |
| `delta_method`           | `boolean`                                      | True if delta method was applied (always true for Ratio)                                        |

## SRM result object

| Field                    | Type                       | Meaning                                                  |
| ------------------------ | -------------------------- | -------------------------------------------------------- |
| `srm_p_value`            | `number`                   | Chi-square p-value over full-exposed deduped denominator |
| `srm_is_mismatch`        | `boolean`                  | `true` if `srm_p_value < 0.001`                          |
| `observed_counts`        | `Record<variant, integer>` | Deduped first-touch Entity counts per arm                |
| `expected_counts`        | `Record<variant, integer>` | Expected counts per declared allocation                  |
| `activated_srm_p_value`  | `number \| null`           | Chi-square on activated population; null if no gate      |
| `activated_srm_mismatch` | `boolean \| null`          | `true` if `activated_srm_p_value < 0.001`                |

## Guardrail result object

| Field            | Type              | Meaning                                                            |
| ---------------- | ----------------- | ------------------------------------------------------------------ |
| `metric_id`      | `string`          |                                                                    |
| `variant`        | `string`          |                                                                    |
| `ci_lower`       | `number \| null`  | Relative-lift CI lower bound; null when relative lift is undefined |
| `threshold`      | `number`          | Downside threshold declared on the Metric                          |
| `is_breached`    | `boolean \| null` | `true` if `ci_lower < threshold`; null when undefined              |
| `in_bh_family`   | `boolean`         | Always false for Guardrails; carried so outputs self-audit         |
| `exploratory`    | `boolean`         | True for post-start or non-decision Guardrail outputs              |
| `decision_valid` | `boolean`         | True only if the Guardrail and threshold were locked at Run Start  |
| `breach_reason`  | `string \| null`  | E.g., `"CI lower bound −0.02 < threshold −0.005"`                  |

## Health metrics object

| Field                         | Type                              | Meaning                                                   |
| ----------------------------- | --------------------------------- | --------------------------------------------------------- |
| `multiple_rate`               | `number`                          | Fraction of Entities in `__multiple__` bucket             |
| `multiple_count`              | `integer`                         | Raw count of `__multiple__` Entities                      |
| `activation_rates`            | `Record<variant, number> \| null` | Per-arm activation rate; null if no gate                  |
| `activation_balance_p_value`  | `number \| null`                  | Chi-square p-value for activated / not-activated by arm   |
| `activation_balance_mismatch` | `boolean \| null`                 | `true` if `activation_balance_p_value < 0.001`            |
| `exposure_counts`             | `Record<variant, integer>`        | Raw (pre-dedup) Exposure counts per arm                   |
| `deduped_counts`              | `Record<variant, integer>`        | First-touch deduped Entity counts per arm (the SRM input) |
| `low_n_warning`               | `boolean`                         | `true` if any arm has deduped n < 100                     |

Dimension result shapes (`DimensionResult`) are defined in
[dimension-slicing.md](dimension-slicing.md).

## Analysis Results envelope

The ready member of the control-plane Results read is:

```ts
type ReadyAnalysisResults = {
  state: "ready";
  run_id: string;
  control_variant: string;
  dataWatermark: string;
  resultToken: `sha256:${string}`;
  stats: StatsOutput;
};
```

`dataWatermark` is the server-selected exclusive `ingest_ts` boundary used by the complete read.
`resultToken` is SHA-256 over RFC 8785 canonical bytes of
`{ appId, environmentId, experimentId, runId, runConfigHash, stats }`. It is evidence identity for
Conclude, not caller authority. The `no_run` and `no_data` members have neither field because no
decision-bearing result exists.

## Sources

- [../../adr/0015-variance-delta-method-aggregate-to-randomization-unit.md](../../adr/0015-variance-delta-method-aggregate-to-randomization-unit.md)
- [../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md](../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md)
- [../../architecture/metric-analysis-seam.md](../../architecture/metric-analysis-seam.md)
