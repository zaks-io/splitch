# Variance reduction: CUPED and winsorization

Two default-on techniques that reduce Metric variance, shorten Experiments for the same power,
and never silently mis-apply. Both are gated on the data they require.

## Winsorization

### What it does

Caps per-Entity values at a high percentile before variance computation, replacing — not deleting —
extreme values. Heavy-tailed Count/Revenue Metrics let a few whales dominate variance; winsorization
neutralizes that.

### Applies to

- **Count Metrics**: caps per-Entity sum at the p-th percentile of per-Entity sums in the arm.
- **Revenue (Mean) Metrics**: caps per-Entity mean at the p-th percentile.
- **Binomial Metrics**: **never applied** (0/1 has no tail; winsorization is meaningless).
- **Ratio Metrics**: applied independently to `num_i` and `denom_i` if configured per Metric.

### Defaults

| Config field     | Default   | Scope      |
|------------------|-----------|------------|
| `winsorize`      | `true`    | per-Metric (count/revenue) |
| `winsorize_pct`  | `99.9`    | per-Metric |

This default-on is a deliberate divergence from Eppo and GrowthBook, which are opt-in per Metric
(ADR-0016). We follow Statsig's default-on reasoning: the untreated failure (a whale silently
deciding the result) is worse than a small documented truncation bias.

### Application order

```
1. Collect per-Entity values y_i in the Conversion Window.
2. Compute q = percentile(y_i, winsorize_pct).
3. y_i_winsorized = min(y_i, q).
4. Compute y_bar and sample variance over y_i_winsorized.
```

Sample size `n` (count of unique Entities) is **unchanged** by winsorization. Winsorized-to-cap
Entities still count in `n`.

### Bias acknowledgment

Winsorization introduces small upward bias in variance estimates (truncation bias). This is
accepted: the variance reduction for heavy-tailed Metrics is substantial (~20–40%), and the bias
is bounded, documented, and user-configurable.

## CUPED (Controlled-experiment Using Pre-Experiment Data)

### What it does

Regression adjustment using pre-period covariate values to explain within-arm variance unrelated
to the Treatment. Reduces Metric variance ~40–65%, shortening Experiments for the same power at
the same confidence level.

### Gating conditions

CUPED applies only when **both** conditions are met:

| Condition                | Threshold               | Config field             |
|--------------------------|-------------------------|--------------------------|
| Pre-period data exists   | Coverage ≥ threshold    | `cuped_coverage_threshold` (default 70%) |
| Coverage > threshold     | Fraction of arm Entities with pre-period data | same |

Coverage = `count(Entities with pre_period_value) / n` per arm. If either arm falls below the
threshold, CUPED does not apply (for consistency; both arms must use the same technique).

### Pre-period window

| Config field          | Default   | Scope          |
|-----------------------|-----------|----------------|
| `cuped_lookback_days` | `7`       | per-Experiment |

Pre-period = `[first_exposure_ts - cuped_lookback_days, first_exposure_ts)`.

The pre-period is **always anchored at `first_exposure_ts`**, even when an Activation gate
re-anchors the Conversion Window to `activation_ts`. This is immutable:
the pre-period captures what the Entity did before being exposed, not before activation.

### Fallback: attribute covariates for new-Entity Experiments

When pre-period data is absent (coverage < threshold, e.g., new users, new workspaces):

1. Collect available Entity attributes from the Evaluation Context at assignment time
   (e.g., `signup_date`, `plan_tier`, `device_type`, `cohort`).
2. Score each attribute by its variance-reduction magnitude on the Metric.
3. Apply the highest-scoring attribute as a covariate.
4. Report `cuped_method = 'attribute_covariate'` and `cuped_attribute = '<attribute_name>'`
   in the output.

Selection is **automatic**, ranked by variance-reduction. No user action
required; no configuration needed.

**Never silent**: if coverage is insufficient and no attribute covariate achieves meaningful
variance reduction, the engine falls back to `cuped_method = 'none'` and reports it. It never
applies CUPED to data that doesn't satisfy the gating condition.

### CUPED adjustment in the CI pipeline

CUPED replaces the variance estimate before the aCS step:

```
theta     = cov(Y_metric, X_covariate) / var(X_covariate)
Y_cuped_i = Y_i - theta * (X_i - X_bar)
var_cuped  = sample_variance(Y_cuped_i) / n
```

`var_cuped` feeds the aCS in place of the raw variance. The CI object downstream is unchanged.

### What the output reports

`VarianceTechniques` in the output always states the method used (see
[result-contracts.md](result-contracts.md)):

| `cuped_method` value   | Meaning                                     |
|------------------------|---------------------------------------------|
| `pre_period`           | CUPED with pre-period data (coverage met)   |
| `attribute_covariate`  | CUPED with attribute fallback               |
| `none`                 | CUPED not applied (coverage insufficient)   |

No silent degradation. An implementing agent reading the output can always tell which path ran.

## Seam: deletion test

The variance-reduction layer passes the deletion test: two distinct adapters exist (pre-period
CUPED and attribute-covariate CUPED), tested by substituting a fake covariate that yields known
variance reduction. The third adapter (`none`) is the explicit fallback path, not dead code.
Collapsing this seam would spread gating logic across every Metric computation.

## Sources

- [../../adr/0016-cuped-and-winsorization-default-on-but-conditional.md](../../adr/0016-cuped-and-winsorization-default-on-but-conditional.md)
- [../../architecture/metric-analysis-seam.md](../../architecture/metric-analysis-seam.md)
