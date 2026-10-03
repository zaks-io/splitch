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

| Field                    | Type                       | Meaning                                                                                          |
| ------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------ |
| `srm_p_value`            | `number`                   | Full-exposed SRM p-value: chi-square under legacy/analysis-v1; anytime p-value under analysis-v2 |
| `srm_is_mismatch`        | `boolean`                  | `true` when the version's gate fires (chi-square p < 0.001, or sequential threshold crossed)     |
| `observed_counts`        | `Record<variant, integer>` | Deduped first-touch Entity counts per arm                                                        |
| `expected_counts`        | `Record<variant, integer>` | Expected counts per declared allocation                                                          |
| `activated_srm_p_value`  | `number \| null`           | Activated-population SRM under the same version rule; null if no gate                            |
| `activated_srm_mismatch` | `boolean \| null`          | Activated mismatch under the same version rule; null if no gate                                  |

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

Under legacy-unversioned and analysis-v1, `guardrail_results[].ci_lower` is the Fieller
relative-lift lower bound derived from the same absolute decision interval (ADR-0015 rule 4).
Breach evaluation is `ci_lower < threshold` once the Arm is decisionable
(`packages/stats/src/guardrail-bound-check.ts`) — failure to establish safety.

Under analysis-v2, `guardrail_results[].ci_lower` remains the Fieller relative-lift lower
bound (same reporting interval as `arm_results`). The Guardrail _verdict_ is separate:
`is_breached` is three-valued from the union-bound oriented contrast
(`packages/stats/src/guardrail-one-sided.ts`) — `false` = safe (`L > 0`), `true` =
affirmative harm (`U < 0`), `null` = undecided (including Control sign not established at
`α/2`) or unevaluated. No contrast-derived relative-scale lower bound is reported. See
[inference-engine.md](inference-engine.md) §Guardrail Metric behavior and ADR-0015's C4
amendment.

## ROPE verdict (confidence-sequence helper)

`classifyRopeVerdict` in `packages/stats/src/rope-verdict.ts` classifies a finite absolute
confidence-sequence interval against a Region Of Practical Equivalence (ROPE) on the absolute scale.
When a Metric's pre-registration freezes an absolute ROPE at Run Start (plan 2.2), treatment
`ArmResult` rows include `ropeVerdict` and `ropeScale: "absolute"` for that Metric; when none was
pre-registered, or the absolute interval is not finite, both fields are absent (not defaulted).

Relative ROPEs are refused at Start with `PREREG_ROPE_RELATIVE_UNSUPPORTED`: the Fieller relative
inversion used for relative intervals does not yet have proven time-uniform coverage under sequential
analysis (see Guardrail `ci_lower` above). If a relative ROPE is nonetheless present at results time,
the engine emits `ropeVerdictUnavailable: "relative_sequential_coverage_unproven"` instead of a
verdict or a silent omission. The result token strips `ropeVerdict` / `ropeScale` /
`ropeVerdictUnavailable` the same way it strips `estimand`, so Runs without pre-registration keep
byte-identical tokens.

Both the interval and the ROPE are closed. Because the absolute interval is an always-valid confidence
sequence, an absolute-scale verdict is valid at any look (Kruschke 2018).

| Verdict     | Meaning                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------ |
| `outside`   | Interval entirely outside the ROPE on one side (no shared points)                          |
| `inside`    | Interval entirely within the ROPE, including equality on either ROPE bound                 |
| `undecided` | Interval overlaps the ROPE without being contained (includes a shared boundary point only) |

Non-finite bounds, an inverted interval (`lower > upper`), or a non-positive-width ROPE
(`ropeLower >= ropeUpper`) throw. A point interval (`lower === upper`) is allowed.

## Ship recommendation (plan 2.4)

When a Run froze a pre-registration, the Control Plane result producer emits
`recommendation: { verdict, because }`. Verdicts are `ship`, `do_not_ship`,
`keep_running`, or `invalid`. `because` is one sentence naming the deciding fact
with numbers and no internal ids. Runs without a pre-registration omit
`recommendation` and set `recommendationUnavailable: "no_pre_registration"`.

Precedence (first matching row wins):

| Order | Condition                                                                                                                            | Outcome                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 1     | No pre-registration                                                                                                                  | `recommendationUnavailable: "no_pre_registration"`                   |
| 2     | Trust/health gate fail (Control identity, SRM, activation balance, engine, decision family)                                          | `invalid`                                                            |
| 3     | Gate not ready (`underpowered` or `planned_duration`)                                                                                | `keep_running`                                                       |
| 4     | Any Guardrail `is_breached: true`                                                                                                    | `do_not_ship` (before interval-availability returns)                 |
| 5     | Sequential Run with a relative ship-rule margin                                                                                      | `recommendationUnavailable: "relative_sequential_coverage_unproven"` |
| 6     | Relative ship-rule margin with a non-positive Control mean                                                                           | `recommendationUnavailable: "relative_control_mean_non_positive"`    |
| 7     | Combining goals (`unanimous_goals` / `any_goal`) with a locked goal missing desirability in the freeze                               | `recommendationUnavailable: "locked_goal_desirability_missing"`      |
| 8     | Combined locked goal Metrics harmful in the desirable direction                                                                      | `do_not_ship`                                                        |
| 9     | Combined locked goal Metrics undecided (interval has not cleared the required margin, or FDR-corrected decision evidence is missing) | `keep_running`                                                       |
| 10    | Combined locked goal Metrics beneficial per the ship rule's required margin, no Guardrail breached                                   | `ship`                                                               |

A win requires eligible FDR-corrected decision evidence (`is_significant`,
`in_bh_family`, and `decision_valid` on the deciding Treatment arm). Clearing the
margin alone is not enough. Conflict resolution (`primary_wins` /
`unanimous_goals` / `any_goal`) combines only locked goal Metrics from the BH
decision family; Guardrail Metrics listed in pre-registration are ignored for
goal combination and evaluated only by their breach rows. Start refuses a
combining ship rule that omits a locked goal Metric's desirability with
`PREREG_LOCKED_GOAL_DESIRABILITY_REQUIRED`; an existing partial freeze fails loud
at results with `locked_goal_desirability_missing` rather than silently excluding
the omitted goal. `because` names the deciding Metric's interval (Primary or Goal)
with numbers and no internal ids.

Absolute margins use the absolute decision interval (`absolute_ci_*` on Treatment
arms, stripped from the result token). Relative margins use the published relative
CI (percent) against a fractional `required_margin`, and are accepted only on a
**fixed-horizon** Run: sequential Fieller time-uniform coverage is unproven, so
Start refuses `marginScale: "relative"` on a sequential Run with
`PREREG_SHIP_RULE_RELATIVE_SEQUENTIAL_UNSUPPORTED` (same rationale as relative
ROPE). If a sequential Run somehow carries a relative ship rule at results time,
the producer emits `recommendationUnavailable: "relative_sequential_coverage_unproven"`
rather than a Fieller-based ship. Relative comparisons reverse desirability when
the Control mean is zero or negative, so a relative-scale rule then emits
`recommendationUnavailable: "relative_control_mean_non_positive"` rather than
re-orienting the interval. Missing absolute bounds with an absolute ship rule
yield `recommendationUnavailable: "absolute_interval_unavailable"` rather than a
guessed verdict. Treatments are identified by Control identity (every non-Control
Variant), not by a non-null relative lift — so a zero Control mean still yields
an absolute-rule recommendation when absolute intervals exist.

## Futility verdict (MDE exclusion, advisory)

`classifyMdeExclusionFutility` in `packages/stats/src/futility-verdict.ts` classifies a finite
absolute confidence-sequence interval against the primary Metric's pre-registered absolute MDE and
desirability. When Start freezes `futility: "mde_exclusion"` (plan 2.12; default `off`, always
written explicitly on the freeze), treatment `ArmResult` rows for the primary Metric include
`futilityVerdict` (`futile` | `not_futile`) and a one-sentence `futilityBecause`. When futility is
`off`, no absolute MDE is present, the arm is not the primary Metric, or the absolute interval is
not finite, both fields are absent (not defaulted).

`mde_exclusion` at Start requires an absolute MDE on the primary Metric
(`PREREG_FUTILITY_REQUIRES_ABSOLUTE_MDE`). Relative MDE alone is refused for the same reason relative
ROPE is refused: sequential Fieller coverage is unproven. Likelihood-ratio futility is not adopted;
Shim (2025) Truncated mSPRT ([arXiv:2509.07892](https://arxiv.org/abs/2509.07892)) was withdrawn in
2026 because the denominator is not a supermartingale.

The interval is closed. Futile means the beneficial-side bound excludes the MDE (the effect is
credibly smaller than the MDE):

| Desirability       | Futile when             |
| ------------------ | ----------------------- |
| `higher_is_better` | `upper < mde_absolute`  |
| `lower_is_better`  | `lower > -mde_absolute` |

Futility is advisory: it never stops or Concludes a Run by itself. The result token strips
`futilityVerdict` / `futilityBecause` the same way it strips `ropeVerdict`, so existing Runs keep
byte-identical tokens.

## Analysis Results envelope (Analysis Worker)

The Analysis Worker returns `AnalysisResultsEnvelopeSchema`. Its strict `state: "ready"` member
contains `run_id`, `control_variant`, and `stats`. It admits `data_watermark` and `result_token`
only as an all-or-nothing pair. A Results read that supports Conclude returns both; the
result-delivery runtime slice owns populating them. Their absence keeps the current read compatible
but provides no evidence inputs for Conclude.

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

| Field                              | Versioned Run (`analysis_version_source: "frozen"`)               | Legacy Run (`"legacy"`) |
| ---------------------------------- | ----------------------------------------------------------------- | ----------------------- |
| `analysis_version`                 | The frozen version                                                | `legacy-unversioned`    |
| `target_n`                         | Frozen target; null on a fixed horizon                            | null                    |
| `target_n_source`                  | `caller` or `default`; null on a fixed horizon                    | null                    |
| `planned_duration_days`            | Planned duration                                                  | null                    |
| `planned_duration_override_reason` | Label when the duration is not whole weeks, else null             | null                    |
| `pre_registration`                 | Frozen pre-registration when Start supplied one; otherwise absent | absent                  |

A legacy Run never reports a target or duration it did not record. Analysis refuses a Run frozen
under a version it does not implement with `VALIDATION_ERROR` instead of analyzing it under a
different engine.

Which estimators a version uses (SRM gate, family correction, Guardrail bound) is in
[ADR-0059](../../adr/0059-runs-freeze-an-analysis-version-and-legacy-runs-read-under-a-labeled-one.md)
§Version table. analysis-v2 switches Exposure and activated SRM to the sequential martingale,
selects BH-G family correction, and uses the Proposition B.1 one-sided Guardrail contrast; it is
defined but unsupported for Start/Results until an ingestion-ordered observation path lands.

## Control Plane result producer (CLI, MCP, panel)

Public `experiment_results_get` / `experiment_results_post` responses are produced by the Control
Plane (`ExperimentResultsResponseSchema`), not the raw Analysis envelope. The producer resolves
Control identity against the Run Snapshot, Run lifecycle, planned duration (`run_commitments` /
D1), caller conclude permission, and analysis evidence, then emits:

1. `view`: `detailed` (default) or `concise`
2. `state`: `ready` | `no_data` | `no_run` (same members as Analysis; never null or a bare error for
   those cases)
3. `readiness.statistical`: evidence-side gate checks pass (Control identity, SRM, activation
   balance, engine status, underpowered, decision-valid membership)
4. `readiness.concludeExecutable`: Conclude can run for this caller on this evidence right now
   (statistical readiness plus planned duration, running lifecycle, evidence handles, App
   owner/admin)
5. `blockedBy`: failing decision-gate check ids
6. `reasons`: human-readable failure details (gate checks plus lifecycle / permission / evidence
   handle blockers)
7. Then, for `view: "detailed"` and `state: "ready"`, the unchanged Analysis statistics (`stats`)
   and the full `gate` object

`view: "concise"` is a separate schema member: same readiness / blockedBy / reasons / operational
handles (`run_id`, `run_number`, `run_status`, `control`, `control_variant`, `data_watermark`,
`result_token`, `run_commitments`, `gate`) without `stats`. It does not delete required fields from
the detailed member. Released CLI 0.7.5 and SDK 0.9.1 tolerate unknown additive fields; existing
field names and Analysis enums are not renamed or extended.

After `reasons`, ready responses carry `recommendation` or `recommendationUnavailable` (plan 2.4).
Concise omits `stats` unless the caller sets `includeExploratory: true` (exploratory statistics
opt-in; detailed always includes full stats). On GET, `includeExploratory` is a query string and
accepts only `"true"` / `"false"` (coerced to a boolean); POST/MCP bodies keep a real JSON boolean.
The recommendation is never hashed into `result_token`. The panel Experiment Results read calls the
same producer and maps into its camelCase projection; it does not re-derive the gate or the
recommendation.

## Sources

- [../../adr/0015-variance-delta-method-aggregate-to-randomization-unit.md](../../adr/0015-variance-delta-method-aggregate-to-randomization-unit.md)
- [../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md](../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md)
- [../../architecture/metric-analysis-seam.md](../../architecture/metric-analysis-seam.md)
- [Wang and Ramdas, False discovery rate control with e-values](https://arxiv.org/abs/2009.02824)
  (super-uniform versus uniform p-values)
- [Kruschke (2018), Rejecting or accepting parameter values in Bayesian estimation](https://doi.org/10.1177/2515245918771304)
  (ROPE decision rule; applied here to an always-valid confidence sequence)
