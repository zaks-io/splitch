# Sequential testing mechanics: aCS implementation

Asymptotic confidence sequence (aCS) construction, boundary calculation, peeking safety, and
stopping rules. Applies after variance computation and CUPED in the CI pipeline.

## What aCS provides

An aCS produces a **time-uniform** confidence interval: valid at any sample size N, at any
point in time, without correction for peeking. The false-positive rate is controlled at `alpha`
simultaneously across all possible inspection times N_1, N_2, ..., N_k.

This is the key property: peek at N=100 and at N=10,000 and both checks are valid. A fixed-horizon
CI is only valid at the pre-declared N.

## aCS construction (Waudby-Smith et al.)

### Inputs

| Variable      | Source                            | Description                         |
|---------------|-----------------------------------|-------------------------------------|
| `y_bar_t`     | treatment per-Entity mean         | Running mean at N_t                 |
| `y_bar_c`     | control per-Entity mean           | Running mean at N_c                 |
| `var_t`       | variance (post-winsorize, CUPED)  | Per-Entity variance in treatment    |
| `var_c`       | variance                          | Per-Entity variance in control      |
| `lambda`      | Experiment config                 | Tuning parameter (default 0.5)      |
| `alpha`       | `1 - confidence_level`            | Significance level (default 0.05)   |

### CI width formula

The aCS at time N has half-width:

```
rho = sqrt(alpha / (N * lambda * (1 - lambda)))

half_width = sqrt( var_pooled / N ) * sqrt( 2 * log(2 / alpha) + log(1 + N * lambda / (1 - lambda)) )
```

Where `var_pooled = var_t/n_t + var_c/n_c` (independent arms).

The full expression simplifies to: for each arm, the margin is proportional to
`sqrt(var / N) * sqrt(log(1/alpha) + log(1 + N/N_ref))` where `N_ref = 1 / (lambda * (1-lambda))`.

### Tuning parameter λ

| λ value | Effect                                           |
|---------|--------------------------------------------------|
| `0.5`   | Symmetric — tightest at midpoint of expected N   |
| `< 0.5` | Tighter early, wider at large N (aggressive peek)|
| `> 0.5` | Wider early, tighter at large N (patient)        |

Default λ = 0.5 is appropriate when the expected run length is roughly symmetric. Users may
adjust per-Experiment; the value is stored in the Experiment config and used for all CI
calculations in the Run.

### Output at each analysis time N

```
ci_lower = (y_bar_t - y_bar_c) - half_width
ci_upper = (y_bar_t - y_bar_c) + half_width
p_value  = 1 - alpha  if CI contains 0
         = alpha_at_current_N  (derived from smallest alpha such that CI excludes 0)
```

The CI is for **absolute lift** `(treatment - control)`. Relative-lift CI is then computed via
delta method (see [inference-engine.md](inference-engine.md) §Relative-lift CI).

## Stopping rules

### Sequential stopping (default)

Monitor continuously. Stop when:

1. **Reject H0 (declare winner/loser):** `ci_lower > 0` (treatment wins) or `ci_upper < 0`
   (treatment loses on this Metric).
2. **Futility (optional):** when the futility boundary triggers — CI is not narrowing toward
   significance despite growing N. Configurable per Experiment; off by default.
3. **Budget / time deadline:** when maximum run duration or maximum N is reached.

No correction for multiple looks is needed — the aCS handles it by construction.

### Fixed-horizon stopping (opt-in)

When `horizon = 'fixed'` and `sample_size_locked = S`:

```
1. Collect exactly S Entities per arm.
2. Compute standard two-sample t-test (or z-test for large N).
3. Report: point_estimate, absolute_ci, p_value.
4. No aCS; no peeking supported.
```

The CI under fixed-horizon is narrower than aCS at the same N — more power, but only valid
at N = S. The trade-off is explicit at Experiment creation.

## Always-valid property

The false-positive rate under the aCS is bounded at `alpha` for any stopping rule, including
data-dependent stops (stop when you see the result you want). This holds because:

- The aCS is a test martingale: `E[1/CI_width_N] ≤ 1/alpha` at all N.
- The valid p-value at any N satisfies `P(p_N ≤ alpha for any N) ≤ alpha`.

This is the mathematical guarantee that makes continuous monitoring safe.

## No mid-experiment mode switching

The CI mode (`sequential` or `fixed`) is **locked at Run creation** (part of the assignment
config). Switching modes mid-Run is an assignment edit (opens a new Run). There is no
`horizon_type` edit that doesn't open a new Run. No sequential patching or mixed-mode runs.

## Failure contracts

| Condition                          | Behavior                                           |
|------------------------------------|----------------------------------------------------|
| `var_pooled = 0` (zero variance)   | CI = `[-∞, +∞]` for the Metric; warn in output    |
| `N = 0` in any arm                 | CI = `[-∞, +∞]`; status = `running`               |
| `lambda` not in `(0, 1)`           | Reject at config validation; do not use            |
| Numerical overflow in log term     | Return error status; do not return corrupt CI      |

## Seam: sequential vs. fixed-horizon

Two real adapters exist:
1. `SequentialCI` — implements the aCS; output is `{ci_lower, ci_upper, p_value}` valid at any N.
2. `FixedHorizonCI` — implements the t-test; output is `{ci_lower, ci_upper, p_value}` valid only at declared N.

Both implement the same interface:

```
interface CIAdapter {
  compute(params: CIParams): CIResult;
}

interface CIParams {
  mean_t: number; mean_c: number;
  var_t: number;  var_c: number;
  n_t: number;    n_c: number;
  alpha: number;
  // sequential only:
  lambda?: number;
  // fixed only:
  sample_size_locked?: number;
}

interface CIResult {
  ci_lower: number;
  ci_upper: number;
  p_value: number;
  mode: 'sequential' | 'fixed';
}
```

The deletion test passes: both adapters exist (sequential is the default, fixed is the opt-in),
and they are tested by substituting a fake adapter with known CI widths.

## Sources

- [../../adr/0014-stats-engine-sequential-always-valid-frequentist-by-default.md](../../adr/0014-stats-engine-sequential-always-valid-frequentist-by-default.md)
- [../../architecture/metric-analysis-seam.md](../../architecture/metric-analysis-seam.md)
