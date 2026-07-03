# Sequential testing mechanics: aCS implementation

Asymptotic confidence sequence (aCS) construction, boundary calculation, peeking safety, and
stopping rules. aCS applies after winsorize -> type-variance -> delta-method -> CUPED in the CI pipeline.

## What aCS provides

An aCS produces a **time-uniform** confidence interval: valid at any sample size N, at any
point in time, without correction for peeking. The false-positive rate is controlled at `alpha`
simultaneously across all possible inspection times N_1, N_2, ..., N_k.

This is the key property: peek at N=100 and at N=10,000 and both checks are valid. A fixed-horizon
CI is only valid at the pre-declared N.

## aCS construction

### Inputs

| Variable       | Source                            | Description                                                   |
| -------------- | --------------------------------- | ------------------------------------------------------------- |
| `estimate`     | treatment minus Control estimator | Absolute-lift estimate at the current look                    |
| `sampling_var` | variance layer                    | Sampling variance of `estimate`; already includes `1/n` terms |
| `n_t`          | deduped Exposures                 | Treatment unique Entity count                                 |
| `n_c`          | deduped Exposures                 | Control unique Entity count                                   |
| `alpha`        | locked Run decision spec          | `1 - confidence_level`                                        |
| `target_n`     | Run config                        | Optional tuning target for where the sequence is tightest     |

`sampling_var` is the variance of the estimator, not the raw per-Entity variance. For a simple
difference in means this is `s2_t / n_t + s2_c / n_c`; for Ratio and relative-lift estimators it
is the delta-method sampling variance from [inference-engine.md](inference-engine.md). The
sequential adapter must not divide by `N` again.

### Algorithm contract

The implementation must use a named confidence-sequence algorithm with source-level tests, not a
hand-copied width sketch in this document. The inference engine uses an asymptotic confidence sequence adapter over
the asymptotically normal estimator produced by the variance layer. The adapter owns:

1. The time-uniform boundary / wealth process.
2. The tuning schedule, such as a target sample size for tightest intervals.
3. Inversion from boundary to p-value.
4. Numerical stability and monotonicity checks.

For bounded Binomial and winsorized additive Metrics, Waudby-Smith and Ramdas style empirical-
Bernstein / betting CSs are the reference family. For delta-method estimators (Ratio and
relative lift), the adapter uses the same always-valid interface over the asymptotic normal
estimator and is validated by simulation under null and alternative data-generating processes.

### Tuning

The tuning parameter is stored as `target_n` or an equivalent adapter-specific schedule in the Run
decision spec. It is locked at Run Start. A later tuning change is exploratory only; it cannot
alter decision-valid significance for the current Run.

### Output at each analysis time N

```
ci_lower = estimate - boundary(alpha, n_t, n_c, sampling_var, tuning)
ci_upper = estimate + boundary(alpha, n_t, n_c, sampling_var, tuning)
p_value  = inf alpha in (0, 1] such that 0 is outside CI_alpha
```

If `0` is inside the 95% CI, the p-value is not set to `0.95`; it is computed by boundary
inversion. This matters because BH FDR ranks all p-values, including non-significant ones.

The base CI is for **absolute lift** `(treatment - control)`. Relative-lift CI is then computed
via delta method (see [inference-engine.md](inference-engine.md) §Relative-lift CI).

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
data-dependent stops (stop when you see the result you want). This is the always-valid guarantee:

- The underlying test martingale / supermartingale controls crossing probability at all times.
- The valid p-value at any N satisfies `P(inf_N p_N <= alpha) <= alpha` under the null.

This is the mathematical guarantee that makes continuous monitoring safe.

## No mid-experiment mode switching

The CI mode (`sequential` or `fixed`) is **locked at Run Start** as part of the decision spec.
Switching modes mid-Run can be drafted for the next Run or shown as exploratory, but it cannot
alter decision-valid significance for the current Run. No sequential patching or mixed-mode
decision results.

## Failure contracts

| Condition                          | Behavior                                       |
| ---------------------------------- | ---------------------------------------------- |
| `sampling_var = 0` (zero variance) | CI = `[-∞, +∞]` for the Metric; warn in output |
| `N = 0` in any arm                 | CI = `[-∞, +∞]`; status = `running`            |
| Invalid tuning schedule            | Reject at config validation; do not use        |
| Numerical overflow in log term     | Return error status; do not return corrupt CI  |

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
  estimate: number;
  sampling_var: number;
  n_t: number; n_c: number;
  alpha: number;
  // sequential only:
  target_n?: number;
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
- [Johari, Koomen, Pekelis, and Walsh, Always Valid Inference](https://pubsonline.informs.org/doi/10.1287/opre.2021.2135)
- [Waudby-Smith and Ramdas, Estimating means of bounded random variables by betting](https://academic.oup.com/jrsssb/article-abstract/86/1/1/7043257)
