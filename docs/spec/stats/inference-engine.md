# Stats inference engine: the one CI object

The single confidence-interval object every Metric type flows through, from variance computation
to Guardrail bound. This is the spine of the stats engine; each stage reads one thing and writes
one thing.

## CI pipeline order (the spine)

```
per-Entity Metric values (one row per Entity, aggregated upstream — ADR-0015)
  ▼ 1. Type-appropriate variance estimator                          → variance_i
  ▼ 2. Delta-method term (Ratio Metrics and relative-lift; always)  → delta_adjusted_variance_i
  ▼ 3. Winsorization (additive Metrics only; on per-Entity values before step 1):
       cap value at p-th percentile, recompute variance over capped values
  ▼ 4. CUPED adjustment (gated; when applied, replaces variance_i)  → cuped_adjusted_variance_i
  ▼ 5. Asymptotic confidence sequence (aCS) — variance → time-uniform CI:
       [ci_lower_N, ci_upper_N] (valid at any N, safe to peek continuously)
  ▼ 6. Relative-lift CI (delta-method ratio of CI objects):
       [relative_lift_ci_lower, relative_lift_ci_upper]
  ▼ 7. Guardrail bound check (CI lower-bound vs. downside threshold) → guardrail_status
  ▼ 8. Benjamini-Hochberg FDR (across goal-metric × Variant family)  → is_significant (post-FDR)
```

Note: step 3 winsorizes input values *before* variance computation (effective ordering:
winsorize → type variance → delta-method → CUPED → aCS).

## Inference framework (ADR-0014)

**Default: sequential always-valid.** Fixed-horizon peeking inflates the real false-positive rate
from 5% to 25–57% (Optimizely A/A simulations); always-valid holds FPR at target regardless of how
often a user looks.

| Config field      | Type                        | Default        |
|-------------------|-----------------------------|----------------|
| `horizon`         | `'sequential' \| 'fixed'`   | `'sequential'` |
| `confidence_level`| `number` (0–1)              | `0.95`         |
| `sample_size_locked` | `integer \| null`        | `null`         |

`confidence_level` is **per-Experiment**, set at design time, applied to all Metrics in the
Experiment.

### aCS (asymptotic confidence sequence) vs. mSPRT

aCS (Waudby-Smith et al.) is **chosen because it is a CI**, not a separate likelihood-ratio
object: it composes directly with the delta method and CUPED as one CI object. mSPRT is
mathematically equivalent but harder to compose into this stack (ADR-0014).

The aCS tuning parameter λ (default 0.5, configurable per Experiment) controls when the sequence
is tightest, and CI width scales as `sqrt(log(2 / alpha_star) / N)` — wider than fixed-horizon at
the same N, the accepted price of safe peeking. Full λ-tuning and width construction live in
[sequential-testing-mechanics.md](sequential-testing-mechanics.md).

### Fixed-horizon opt-in

When `horizon = 'fixed'` and `sample_size_locked = S`: standard frequentist t-test / z-test
(not aCS), p-value output instead of a CI sequence; stopping rule is to collect exactly S Entities
per arm then read once. Peeking is disabled in the UI while fixed-horizon is active (no
intermediate results rendered).

## Variance computation rules (non-negotiable; ADR-0015)

Three structural rules — the naive code paths do not exist:

**Rule 1 — Aggregate to Entity before variance.** Denominator is always `COUNT DISTINCT Entity`;
events, sessions, pageviews are never the denominator. Treating correlated observations as
independent understates variance, pushing FPR from 5% to ~25% or worse.

**Rule 2: Delta method for Ratio Metrics and relative-lift.** When numerator and denominator are
correlated (Ratio Metric) or when computing relative lift (treatment mean / control mean), the
naive ratio-of-means variance omits the covariance term; the delta method (first-order Taylor
expansion) is the only path.

**Rule 3: No naive variance code path exists.** One variance path; no flag or parameter selects
ratio-of-means or events-as-independent variance.

## Per-type variance estimators

### Binomial Metric

Per-Entity value: `y_i ∈ {0, 1}` (did the Entity do the thing). `SE = sqrt(var_i)`. No
winsorization (binary has no tail).

```
p_hat  = mean(y_i) over arm
var_i  = p_hat * (1 - p_hat) / n
```

### Count / Revenue (Mean) Metric

Per-Entity value: `y_i` = sum (Count) or mean (Revenue) over events in Conversion Window.

```
y_bar  = mean(y_i) over arm
var_i  = sample_variance(y_i) / n
```

Winsorization applies to `y_i` before `y_bar` / `var_i` (see
[variance-reduction.md](variance-reduction.md)).

### Ratio Metric

Per-Entity inputs: `(num_i, denom_i)` pair, both aggregated independently to Entity level.

```
A = mean(num_i)         # numerator mean
B = mean(denom_i)       # denominator mean
R = A / B               # ratio

# Delta-method variance (with covariance term — this is the non-negotiable rule):
var_ratio = (1/n) * [ var(num_i)/B^2
                    - 2*(A/B^2)*cov(num_i, denom_i)
                    + (A^2/B^4)*var(denom_i) ]
```

`cov(num_i, denom_i)` is computed from the per-Entity pair — unrecoverable after independent
aggregation. See [data-contracts.md](data-contracts.md) §Input for why the pipeline must deliver
the pair.

### Relative-lift CI

Relative lift `(R_t - R_c) / R_c` is itself a ratio; its variance is delta-method.

```
delta  = R_t - R_c
var_delta = var_t / n_t + var_c / n_c   # independent arms
relative_lift = delta / R_c
var_relative  = (1/R_c^2) * var_delta + (delta^2 / R_c^4) * var_c_mean
```

## Guardrail Metric behavior

A Guardrail Metric is a regular Metric carrying a `downside_threshold` (a relative-lift lower
bound). After the full CI pipeline, `guardrail_breached = ci_lower < downside_threshold`. A
breached Guardrail fires regardless of significance status. Guardrail Metrics are **excluded from
the BH FDR family** — they do not consume multiplicity budget.

## Benjamini-Hochberg FDR (step 8)

The final stage converts per-(Metric, Variant) p-values into `is_significant` via BH FDR across
the goal-metric × Variant family. Family definition, BH algorithm, "None" option, and exclusion
rules (Guardrails, Secondary Metrics/Dimensions) live in
[multiple-comparisons-fdr.md](multiple-comparisons-fdr.md).

## Failure contracts

| Failure                       | Behavior                                                   |
|-------------------------------|-------------------------------------------------------------|
| N = 0 in an arm               | Return CI = `[-∞, +∞]`, p_value = 1.0, status = `running` |
| N < 100                       | Report result with `health.low_n_warning = true`; do not suppress |
| CUPED pre-period missing       | Fall back per [variance-reduction.md](variance-reduction.md); log method in `variance_techniques` |
| Ratio `denom_value = 0`        | Exclude that Entity from the arm; log exclusion count      |
| aCS divergence (NaN/inf)      | Return error status; do not return a corrupt CI            |

## Sources

- [../../adr/0014-stats-engine-sequential-always-valid-frequentist-by-default.md](../../adr/0014-stats-engine-sequential-always-valid-frequentist-by-default.md)
- [../../adr/0015-variance-delta-method-aggregate-to-randomization-unit.md](../../adr/0015-variance-delta-method-aggregate-to-randomization-unit.md)
- [../../adr/0016-cuped-and-winsorization-default-on-but-conditional.md](../../adr/0016-cuped-and-winsorization-default-on-but-conditional.md)
- [../../architecture/metric-analysis-seam.md](../../architecture/metric-analysis-seam.md)
