# Stats engine: result (output) contracts

The output shapes the stats engine writes to the UI/API — the members of `StatsOutput`. The input
contract and `StatsEngine` signature live in [data-contracts.md](data-contracts.md).

## Per-arm result object (one per (Variant, Metric))

| Field                 | Type                 | Meaning                                                                                                              |
| --------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `variant`             | `string`             | Variant name                                                                                                         |
| `metric_id`           | `string`             |                                                                                                                      |
| `sample_size_n`       | `integer`            | Unique Entities in this arm (deduped)                                                                                |
| `point_estimate`      | `number`             | Per-Entity mean for this arm                                                                                         |
| `relative_lift_pct`   | `number \| null`     | `(treatment / control - 1) × 100`; null for Control or undefined Control estimate                                    |
| `ci_lower`            | `number \| null`     | Always-valid CI lower bound (relative-lift %); null for Control or undefined relative lift                           |
| `ci_upper`            | `number \| null`     | Always-valid CI upper bound (relative-lift %); null for Control or undefined relative lift                           |
| `p_value`             | `number`             | Sequential: always-valid boundary-inversion p-value (super-uniform, mass at 1). Fixed-horizon: one-look t/z p-value. |
| `is_significant`      | `boolean`            | After Benjamini-Hochberg FDR correction                                                                              |
| `in_bh_family`        | `boolean`            | True only for locked goal Metric × Variant family members                                                            |
| `exploratory`         | `boolean`            | True for post-start additions or Secondary outputs                                                                   |
| `decision_valid`      | `boolean`            | True only when the result belongs to the locked decision spec                                                        |
| `status`              | `enum`               | `running \| ready \| stopped \| insufficient_denominator \| insufficient_n \| error`                                 |
| `variance_techniques` | `VarianceTechniques` | Which variance-reduction methods applied (see below)                                                                 |
| `estimand`            | `EstimandDisclosure` | What the published estimate measures and what the cap changed (see below)                                            |

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

## EstimandDisclosure object

The engine emits `estimand` on every arm result, including Dimension arm results. The schema
keeps it optional only so Stats recorded before it existed still parse.

| Field                 | Type                       | Meaning                                                                                      |
| --------------------- | -------------------------- | -------------------------------------------------------------------------------------------- |
| `label`               | `EstimandLabel`            | What the published `point_estimate`, lift, interval, and p-value measure                     |
| `decision_label`      | `EstimandLabel`            | The estimate decisions use. Always equal to `label`: the published (capped) estimate decides |
| `capped_entity_count` | `integer \| null`          | Entities in this arm with at least one value lowered by the cap; null when not winsorized    |
| `uncapped`            | `UncappedEstimate \| null` | The same arm without the cap, computed in the same pass; null when not winsorized            |

`capped_entity_count` and `uncapped` are present together or null together.

`EstimandLabel` is one of:

| Label                     | Metric kind    | Technique                                                           |
| ------------------------- | -------------- | ------------------------------------------------------------------- |
| `uncapped_additive_mean`  | Count, Revenue | Per-Entity mean, no cap                                             |
| `capped_additive_mean`    | Count, Revenue | Per-Entity mean of values capped at the pooled cap                  |
| `binomial_mean`           | Binomial       | Per-Entity conversion rate. Never winsorized, so never capped       |
| `ratio_of_uncapped_means` | Ratio          | Mean numerator over mean denominator, no cap                        |
| `ratio_of_capped_means`   | Ratio          | Mean capped numerator over mean capped denominator (component caps) |

A Ratio Entity counts once in `capped_entity_count` even when both components were capped.

### UncappedEstimate object

Disclosure only. It never enters the Benjamini-Hochberg family, the Guardrail check, or the
decision gate. Its `p_value` uses the same method as the published `p_value` and is never
FDR-corrected.

| Field               | Type             | Meaning                                                                                   |
| ------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| `label`             | `EstimandLabel`  | `uncapped_additive_mean` or `ratio_of_uncapped_means`                                     |
| `point_estimate`    | `number`         | Uncapped per-Entity mean (or ratio of means) for this arm                                 |
| `relative_lift_pct` | `number \| null` | Uncapped relative lift; null for Control or undefined Control estimate                    |
| `ci_lower`          | `number \| null` | Uncapped relative-lift interval lower bound, same interval method as the published one    |
| `ci_upper`          | `number \| null` | Uncapped relative-lift interval upper bound                                               |
| `p_value`           | `number`         | p-value of the uncapped comparison, same method as the published one, never FDR-corrected |
| `status`            | `enum`           | Same status vocabulary as the arm result                                                  |
| `cuped_applied`     | `boolean`        | True if CUPED still adjusts the uncapped estimate                                         |

When CUPED applied to the capped estimate, the uncapped estimate uses the same selected covariate
with its slope refit on uncapped outcomes, so `cuped_applied` matches the arm's
`variance_techniques.cuped_applied`. Ratio Metrics never use CUPED.

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

## Sequential `p_value` (super-uniform, mass at 1)

For `horizon = 'sequential'`, `p_value` is the infimum alpha whose aCS excludes zero
([sequential-testing-mechanics.md](sequential-testing-mechanics.md)). The adapter returns `1`
when the estimate is zero and when the boundary at alpha just below `1` still covers the
estimate (`packages/stats/src/sequential-ci.ts`). That is a point mass at `1`, not a bug.

Valid sequential p-values are super-uniform: `P(p <= alpha) <= alpha` under the null (Wang and
Ramdas). They are not Uniform(0, 1). A/A simulations, metric-trust jobs, and any Anderson-Darling
(or similar) uniformity gate on these p-values would reject a correctly conservative test. Those
jobs must check false-positive control directly: under the null, the probability that the
p-value ever reaches `alpha` across the declared look schedule must not exceed `alpha`
(`P(inf_t p_t <= alpha) <= alpha`), within a predeclared Monte Carlo tolerance. Matching this
adapter's own simulated null distribution can supplement that check but never replaces it, since an
adapter that over-rejects would match its own reference.

Fixed-horizon `p_value` is a one-look t/z tail and is not this inversion.

## Guardrail `ci_lower`

`guardrail_results[].ci_lower` is the Fieller relative-lift lower bound derived from the same
absolute decision interval (ADR-0015 rule 4). Breach evaluation is
`ci_lower < threshold` once the Arm is decisionable
(`packages/stats/src/guardrail-bound-check.ts`). Time-uniform coverage of that inversion is
unproven; the Fieller sequential-coverage audit is scheduled separately.

## Analysis Results envelope

The control-plane Results read uses the shipped `AnalysisResultsEnvelopeSchema` from
`@splitch/contracts`; there is no parallel Results type. Its strict `state: "ready"` member contains
`run_id`, `control_variant`, and `stats`. It admits `data_watermark` and `result_token` only as an
all-or-nothing pair. A Results read that supports Conclude returns both; the result-delivery runtime
slice owns populating them. Their absence keeps the current read compatible but provides no evidence
inputs for Conclude.

`data_watermark` is the server-selected inclusive `ingest_ts` boundary used by the complete read. It
comes from the inclusive `deduped_exposures.watermark_ts` Copy Pipe boundary, so rows whose
`ingest_ts` exactly equals the watermark are part of the result.
`result_token` is `sha256:` plus 64 lowercase hexadecimal digits, computed as SHA-256 over RFC 8785
canonical bytes of
`{ appId, environmentId, experimentId, runId, runConfigHash, analysisVersion, stats }`, where
`stats` omits every arm result's `estimand` (`resultTokenStats`). The disclosure labels the
decision-driving estimate and adds an uncapped view that no decision reads, so leaving it out keeps
a Run's token byte-identical to the token issued before the disclosure existed. A change to any
decision-bearing field still changes the token. A legacy Run omits `analysisVersion`, so its token
is byte-identical to the token it had before versioning. It is evidence identity for Conclude, not
caller authority. The `no_run` and `no_data` members have neither field because no decision-bearing
result exists.

A ready envelope also carries `run_commitments`, what the Run froze at Start
([ADR-0059](../../adr/0059-runs-freeze-an-analysis-version-and-legacy-runs-read-under-a-labeled-one.md)):

| Field                              | Versioned Run (`analysis_version_source: "frozen"`)   | Legacy Run (`"legacy"`) |
| ---------------------------------- | ----------------------------------------------------- | ----------------------- |
| `analysis_version`                 | The frozen version                                    | `legacy-unversioned`    |
| `target_n`                         | Frozen target; null on a fixed horizon                | null                    |
| `target_n_source`                  | `caller` or `default`; null on a fixed horizon        | null                    |
| `planned_duration_days`            | Planned duration                                      | null                    |
| `planned_duration_override_reason` | Label when the duration is not whole weeks, else null | null                    |

A legacy Run never reports a target or duration it did not record. Analysis refuses a Run frozen
under a version it does not implement with `VALIDATION_ERROR` instead of analyzing it under a
different engine.

## Sources

- [../../adr/0015-variance-delta-method-aggregate-to-randomization-unit.md](../../adr/0015-variance-delta-method-aggregate-to-randomization-unit.md)
- [../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md](../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md)
- [../../architecture/metric-analysis-seam.md](../../architecture/metric-analysis-seam.md)
- [Wang and Ramdas, False discovery rate control with e-values](https://arxiv.org/abs/2009.02824)
  (super-uniform versus uniform p-values)
