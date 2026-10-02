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
difference in means this is `s2_t / n_t + s2_c / n_c`; for Ratio Metrics it is the delta-method
sampling variance from [inference-engine.md](inference-engine.md). Relative lift does not feed
this adapter: Fieller inverts the absolute interval after it. The sequential adapter must not
divide by `N` again.

### Algorithm contract

The implementation must use a named confidence-sequence algorithm with source-level tests, not a
hand-copied width sketch in this document. The inference engine uses an asymptotic confidence sequence adapter over
the asymptotically normal estimator produced by the variance layer. The adapter owns:

1. The time-uniform boundary / wealth process.
2. The tuning schedule, such as a target sample size for tightest intervals.
3. Inversion from boundary to p-value.
4. Numerical stability and monotonicity checks.

For bounded Binomial and winsorized additive Metrics, Waudby-Smith and Ramdas style empirical-
Bernstein / betting CSs are the reference family. For delta-method estimators (Ratio Metrics),
the adapter uses the same always-valid interface over the asymptotic normal estimator and is
validated by simulation under null and alternative data-generating processes. Relative lift is
the Fieller inversion of that absolute interval, not a second sequential adapter.

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

The sequential p-value is that inversion over alpha. The adapter recomputes the mixture parameter
at every candidate alpha (`packages/stats/src/sequential-ci.ts`, `normalMixturePValue`). It
returns exactly `1` when the estimate is zero, and also when the boundary at alpha just below `1`
still covers the estimate. That second case is a point mass at `1` for a band of standardized
statistics near zero. A valid sequential p-value is **super-uniform**, not uniform: under the
null, `P(p <= alpha) <= alpha` at each alpha (Wang and Ramdas). Any A/A or metric-trust check
must test that bound across the declared look schedule (`P(inf_t p_t <= alpha) <= alpha`). A
comparison to this adapter's simulated reference distribution may supplement it but never replaces
it. Anderson-Darling uniformity of p-values would reject a correctly conservative test.

The base CI and p-value are for **absolute lift** `(treatment - control)`. That absolute interval
is the stopping input and the BH rank. Relative-lift output is the **Fieller inversion of the
same absolute interval** (see [inference-engine.md](inference-engine.md) §Relative-lift CI).
Fieller recovers its critical multiplier from the decision interval's half-width, so a sequential
Run's relative bounds track the aCS boundary rather than a fixed-n z. Guardrail breach reads that
relative lower bound (`packages/stats/src/guardrail-bound-check.ts`), so the relative interval
**is decision-bearing for Guardrails** (ADR-0015 rule 4). It does not supply the BH rank or the
absolute stop. Time-uniform coverage of the Fieller inversion itself is unproven; D1 keeps Fieller
and schedules that audit.

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
1. Collect S Entities per arm. Until every arm has S, the Metric stays `running`.
2. Analyze exactly the first S Entities per arm, ordered by first_exposure_ts
   and then by targeting_key_hash so Entities exposed in the same millisecond
   still have one fixed order.
   Entities that arrive past the lock are excluded, not weighted down.
3. Compute standard two-sample t-test (or z-test for large N).
4. Report: point_estimate, absolute_ci, p_value.
5. No aCS; no peeking supported.
```

Step 2 is what makes re-analysis safe. Hash-bucketed assignment never lands both arms on the
same count, and a live Run keeps accruing Entities until someone ends it, so "exactly S in both
arms" is a state a real Run never occupies. Analyzing whatever is present instead would re-test
a growing dataset at every poll, which is peeking on a test that has no peeking correction.
Truncating by exposure time makes every re-analysis return the same pre-registered test.

The CI under fixed-horizon is narrower than aCS at the same N — more power, but only valid
at N = S. The trade-off is explicit at Experiment creation.

## Always-valid property

The false-positive rate under the aCS is bounded at `alpha` for any stopping rule, including
data-dependent stops (stop when you see the result you want). This is the always-valid guarantee:

- The underlying test martingale / supermartingale controls crossing probability at all times.
- The valid p-value at any N satisfies `P(inf_N p_N <= alpha) <= alpha` under the null.
  Super-uniformity permits a point mass at 1; it does not require `p ~ Uniform(0,1)`.

This is the mathematical guarantee that makes continuous monitoring safe. The implemented
normal-mixture inversion is super-uniform only under its stated asymptotic assumptions and
calibration. Small-n miscoverage is a known aCS property; the low-n gate currently keeps those
looks away from Conclude.

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
- [Wang and Ramdas, False discovery rate control with e-values](https://arxiv.org/abs/2009.02824)
  (super-uniform versus uniform p-values; sequential p-values need not be uniform)
- [Fieller, Some Problems in Interval Estimation](https://doi.org/10.1111/j.2517-6161.1954.tb00159.x)
