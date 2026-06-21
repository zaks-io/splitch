# Multiple comparisons: Benjamini-Hochberg FDR

The false-discovery-rate correction applied across the goal-metric × Variant family — the final
stage of the CI pipeline that turns per-(Metric, Variant) p-values into `is_significant` calls.

This is step 8 of the CI pipeline in [inference-engine.md](inference-engine.md).

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
- [Johari, Koomen, Pekelis, and Walsh, always-valid inference](https://pubsonline.informs.org/doi/10.1287/opre.2021.2135)
