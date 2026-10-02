# Multiple comparisons: family FDR

The false-discovery-rate correction applied across the goal-metric × Variant family. This is the
final stage of the CI pipeline that turns per-(Metric, Variant) p-values into `is_significant`
calls.

This is step 8 of the CI pipeline in [inference-engine.md](inference-engine.md). Production
still applies Benjamini-Hochberg. BH-G is implemented beside it and is selected only when the
caller passes `family_correction: "bh_g"`.

## Family definition (locked at Experiment design time)

Benjamini-Hochberg FDR controls false discovery rate across the **goal-metric × Variant family**.

- Members: `(goal_metric_id, variant)` for every goal Metric and every non-Control Variant.
- Guardrail Metrics: excluded — they do not consume multiplicity budget.
- Secondary Metrics (exploratory): excluded.
- Primary Dimensions (if declared at design time): each `(goal_metric, variant, dimension_value)`
  tuple is a family member. Secondary Dimensions are excluded.
- Family size `m`, confidence level / alpha, and member list are locked when the Experiment Run is Started.
  Adding a Metric or Dimension mid-Run does not change `m` for decision-valid results.

Post-start additions can still be analyzed, but they are explicitly `exploratory: true`,
`in_bh_family: false`, and never produce a decision-valid `is_significant = true` for the current
Run. To make them decision-valid, Start a new Experiment Run or a future locked-analysis version before
looking at results.

## BH algorithm

```
1. Collect p-values p_1, ..., p_m for the m family members.
2. Sort ascending: p_(1) ≤ p_(2) ≤ ... ≤ p_(m).
3. Find the largest k such that p_(k) ≤ (k/m) * alpha.
4. Reject (declare significant) all hypotheses 1..k.
```

`alpha = 1 - confidence_level` (e.g., 0.05 at 95% confidence level).

Johari, Pekelis, Walsh Theorem 7.3: BH over always-valid p-values controls FDR under a
sufficient condition on the stopping time and independence. That is the current production
procedure.

## BH-G algorithm (Benjamini-Yekutieli / harmonic BH)

BH-G is the same rank-and-cut with `alpha` replaced by `alpha / H_m`, where
`H_m = sum_{i=1..m} 1/i`. Equivalently, reject the largest k such that
`p_(k) ≤ (k/m) * alpha / H_m`.

Johari, Pekelis, Walsh Proposition C.3: this correction controls FDR for always-valid
p-values under an arbitrary stopping time and arbitrary dependence. The sequential p-value
here is a boundary inversion, not an e-value, so e-BH is not available as a swap.

`applyDecisionFamilyCorrection({ family_correction })` shares one implementation:
`"bh"` (default) and `"bh_g"`. The stats engine does not pass the argument yet.
`analysis_version` wiring will select BH-G for new Runs.

## Dependence and stopping simulation

Predeclared smoke design (also used in ADR-0014):

- Seed `424242`, 300 iterations, alpha `0.05`.
- Sequential looks at 100, 200, and 400 Entities per arm. Stop at the first look where the
  procedure rejects at least one locked member.
- Four Count goal Metrics, one Treatment, shared Control Entities. Residual correlation 0.6
  through a shared Entity factor.
- Mixed nulls: two true nulls, two alternatives with absolute lift 0.35.
- SequentialCI `target_n` 1250. Winsorization and CUPED off so the multiplicity policy is
  isolated from those layers.
- Monte Carlo FDR tolerance:
  `max(0.02, 3 * sqrt(alpha * (1 - alpha) / iterations))` = 0.038 at these settings.

Recorded smoke results from `stats:simulation` (same seed and iteration count):

| Procedure | Stop FDR | Stop power | Last-look power (n=400) |
| --------- | -------- | ---------- | ----------------------- |
| BH        | 0.0011   | 0.720      | 0.927                   |
| BH-G      | 0.0011   | 0.735      | 0.888                   |

Stop-policy power cost of BH-G versus BH: -0.015, because BH-G can wait past BH's first
crossing and then reject more alternatives. Same-look power cost at the last look: 0.038
(3.8 percentage points). BH-G observed FDR stayed within alpha plus the tolerance above.

Primary Dimension tuples are locked-family members when declared, but production snapshots
still write an empty dimension list, so they are not in this simulation.

## "None" option

When `decision_family = []`, no FDR correction is applied because the user explicitly declared no goal
Metrics. The output is exploratory: `is_significant` may reflect raw `p_value < alpha`, but
`decision_valid = false`.

No post-hoc FDR and no sequential patching: the family is a design-time declaration, immutable
per Run.

## What is excluded

| Excluded member      | Reason                                                        |
| -------------------- | ------------------------------------------------------------- |
| Guardrail Metrics    | Fire on CI-bound breach regardless of significance; no budget |
| Secondary Metrics    | Exploratory; not part of the decision family                  |
| Secondary Dimensions | Not declared at design time; cannot change locked `m`         |

See [inference-engine.md](inference-engine.md) §Guardrail Metric behavior for the Guardrail
exclusion and [dimension-slicing.md](dimension-slicing.md) for Dimension family expansion.

## Sources

- [../../adr/0014-stats-engine-sequential-always-valid-frequentist-by-default.md](../../adr/0014-stats-engine-sequential-always-valid-frequentist-by-default.md)
- [../../architecture/metric-analysis-seam.md](../../architecture/metric-analysis-seam.md)
- [Benjamini and Hochberg (1995), controlling the false discovery rate](https://rss.onlinelibrary.wiley.com/doi/10.1111/j.2517-6161.1995.tb02031.x)
- [Benjamini and Yekutieli (2001), the control of the false discovery rate under dependency](https://projecteuclid.org/journals/annals-of-statistics/volume-29/issue-4/The-control-of-the-false-discovery-rate-in-multiple-testing/10.1214/aos/1013699998.full)
- [Johari, Koomen, Pekelis, and Walsh, always-valid inference](https://pubsonline.informs.org/doi/10.1287/opre.2021.2135)
