# Stats inference engine: the one CI object

The single confidence-interval object every Metric type flows through, from variance computation
to Guardrail bound. This is the spine of the stats engine; each stage reads one thing and writes
one thing.

## CI pipeline order (the spine)

```
per-Entity Metric values (one row per Entity, aggregated upstream — ADR-0015)
  ▼ 1. Winsorization (additive Metrics only):
       cap value at p-th percentile, recompute variance over capped values
  ▼ 2. Type-appropriate variance estimator                         → variance_i
  ▼ 3. Delta-method term (Ratio Metrics)                           → delta_adjusted_variance_i
  ▼ 4. CUPED adjustment (gated; when applied, replaces variance_i) → cuped_adjusted_variance_i
  ▼ 5. Absolute-lift inference (aCS or fixed-horizon) → decision p-value / stop input:
       [absolute_ci_lower_N, absolute_ci_upper_N] (valid at any N for aCS)
  ▼ 6. Relative-lift interval (Fieller inversion of the absolute decision interval):
       [relative_lift_ci_lower, relative_lift_ci_upper]
  ▼ 7. Guardrail bound check (CI lower-bound vs. downside threshold) → guardrail_status
  ▼ 8. Family FDR (BH default; BH-G available as a typed comparator)  → is_significant (post-FDR)
```

Note: step 1 winsorizes input values _before_ variance computation (effective ordering:
winsorize -> type-variance -> delta-method -> CUPED -> aCS).

## Inference framework (ADR-0014)

**Default: sequential always-valid.** Fixed-horizon peeking inflates the real false-positive rate
from 5% to 25–57% (Optimizely A/A simulations); always-valid holds FPR at target regardless of how
often a user looks.

| Config field         | Type                      | Default        |
| -------------------- | ------------------------- | -------------- |
| `horizon`            | `'sequential' \| 'fixed'` | `'sequential'` |
| `confidence_level`   | `number` (0–1)            | `0.95`         |
| `sample_size_locked` | `integer \| null`         | `null`         |

`confidence_level` is **per-Experiment**, locked at Run Start for decision-valid results, and
applied to all Metrics in the locked decision family. Post-start exploratory views may compute
raw intervals at the configured display level, but they cannot change decision-valid significance
for the current Run.

### aCS (asymptotic confidence sequence) vs. mSPRT

aCS (Waudby-Smith et al.) is **chosen because it is a CI**, not a separate likelihood-ratio
object: it composes directly with the delta method and CUPED as one CI object. mSPRT is
mathematically equivalent but harder to compose into this stack (ADR-0014).

The aCS adapter owns the time-uniform boundary and tuning schedule. The Run may carry a
`target_n` tuning value for where the sequence should be tightest. Sequential intervals are wider
than fixed-horizon intervals at the same N, the accepted price of safe peeking. Full tuning,
p-value inversion (including the point mass at 1), and adapter requirements live in
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

**Rule 2: Delta method for Ratio Metrics.** When numerator and denominator are correlated
(Ratio Metric), the naive ratio-of-means variance omits the covariance term; the delta method
(first-order Taylor expansion) is the only path. Relative lift is not a second delta-method
estimate: ADR-0015 rule 4 derives it by Fieller inversion of the absolute interval.

**Rule 3: No naive variance code path exists.** One variance path; no flag or parameter selects
ratio-of-means or events-as-independent variance.

## Per-type variance estimators

### Binomial Metric

Per-Entity value: `y_i ∈ {0, 1}` (did the Entity do the thing). No
winsorization (binary has no tail).

```
p_hat        = mean(y_i) over arm
s2_arm       = p_hat * (1 - p_hat)          # per-Entity variance estimate
sampling_var = s2_arm / n                   # variance of p_hat
```

### Count / Revenue (Mean) Metric

Per-Entity value: `y_i` = sum of event values in the Conversion Window. Revenue reports the mean
of those per-Entity sums across Entities, e.g. revenue per Entity. Average order value or
revenue per session is a Ratio Metric, not a Revenue Metric.

```
y_bar        = mean(y_i) over arm
s2_arm       = sample_variance(y_i)         # per-Entity variance estimate
sampling_var = s2_arm / n                   # variance of y_bar
```

Winsorization applies to `y_i` before `y_bar` / `sampling_var` (see
[variance-reduction.md](variance-reduction.md)).

### Ratio Metric

Per-Entity inputs: `(num_i, denom_i)` pair, both aggregated independently to Entity level.

```
A = mean(num_i)         # numerator mean
B = mean(denom_i)       # denominator mean
R = A / B               # ratio

# Delta-method sampling variance (with covariance term — this is the non-negotiable rule):
sampling_var_ratio = (1/n) * [ var(num_i)/B^2
                             - 2*(A/B^3)*cov(num_i, denom_i)
                             + (A^2/B^4)*var(denom_i) ]
```

`cov(num_i, denom_i)` is computed from the per-Entity pair — unrecoverable after independent
aggregation. See [data-contracts.md](data-contracts.md) §Input for why the pipeline must deliver
the pair. Entities with `denom_i = 0` remain in the per-Entity pair with `denom_i = 0`; the arm
fails only if the arm-level denominator mean `B = 0`.

### Relative-lift CI

Relative lift is a derived interval, not a second test. The base interval and p-value are always
computed on absolute lift `R_t - R_c`. That absolute interval is the stopping input and the BH
rank. Relative-lift reporting and relative Guardrail bounds are the **Fieller inversion of that
same absolute interval**, never a second independent estimate (ADR-0015 rule 4). The
implementation (`packages/stats/src/relative-ci.ts`) recovers the critical multiplier from the
decision interval's half-width, so sequential Runs carry the aCS boundary into the ratio interval
and fixed-horizon Runs carry the t (or z) critical value. If the Control estimate is zero,
relative lift and its interval are undefined, while the absolute-lift decision remains available.

Guardrail breach is `ci_lower < downside_threshold_pct` on this Fieller relative lower bound
(`packages/stats/src/guardrail-bound-check.ts`). The relative interval is therefore
**decision-bearing for Guardrails**. Time-uniform coverage of the Fieller inversion as a
confidence sequence is unproven (no directly applicable Fieller CS construction was found;
Waudby-Smith Proposition 3.5 is a delta-method alternative, not a refutation). D1 keeps Fieller
and schedules that audit before any replacement.

Both the point estimate and the interval bounds are reported in **percentage points**:

```
relative_lift_pct = (R_t / R_c - 1) * 100

# Fieller: invert (R_t - k_ratio * R_c)^2 <= k^2 * (v_t + k_ratio^2 * v_c) for k_ratio,
# with k the same critical value the absolute decision interval uses.
a = R_c^2 - k^2 * v_c
b = R_t * R_c
c = R_t^2 - k^2 * v_t

ci_lower, ci_upper = ((b -/+ sqrt(b^2 - a*c)) / a - 1) * 100   # when a > 0
ci_lower, ci_upper = -Infinity, +Infinity                      # when a <= 0
```

`a <= 0` means the Control mean is not itself separated from zero at the confidence level. Fieller's
exact set is then not an interval: for `a < 0` it is the two rays outside the roots, and for `a = 0`
it is a half-line. The engine reports the **convex hull** of that set, `(-Infinity, +Infinity)`,
rather than truncating to a finite-looking range or publishing a set the result contract cannot
represent. This is deliberately conservative: the hull can contain 0% where the exact rays exclude
it, so an unbounded relative interval means "uninformative", never "no effect".

Because a ratio of 1 reduces Fieller's quadratic to the absolute test, the published relative
interval contains 0% if and only if the decision interval contains zero, **when `a > 0`**. The
unbounded case carries no such equivalence, which is why significance, stopping, and BH still
read the absolute-lift interval. Guardrails still read the relative lower bound when it is finite.

For a Binomial comparison with a non-zero effect but a zero plug-in variance at a boundary, the
decision or relative-reporting standard error uses the documented Agresti-Caffo plus-two variance
adjustment. The reported point estimate and Experiment estimand remain unadjusted. This avoids
manufacturing certainty from a zero Wald standard error while retaining finite boundary-safe
decision and Guardrail paths.

## Guardrail Metric behavior

A Guardrail Metric is a regular Metric carrying a `downside_threshold_pct` (a relative-lift lower
bound in percent, on the same scale as `relative_lift_pct` and `ci_lower`). Guardrail Metrics are
**excluded from the BH FDR family** — they do not consume multiplicity budget. Which bound the
engine uses rides `analysis_version` (ADR-0059).

### legacy-unversioned and analysis-v1: two-sided Fieller relative lower

After the full CI pipeline, `is_breached = ci_lower < downside_threshold_pct`, where `ci_lower` is
the Fieller-derived relative lower bound in percentage points defined above. This is
**failure to establish safety**: a wide early interval whose lower bound sits below the threshold
fires even when the interval still covers values above the threshold. A breached Guardrail fires
regardless of significance status.

The comparison is only reached when a relative lower bound exists. `is_breached` is
**`null`, meaning unevaluated**, in three cases, and the null is never compared numerically:

| Case                                                        | `ci_lower`  | `is_breached` |
| ----------------------------------------------------------- | ----------- | ------------- |
| Relative lift undefined (`R_c = 0`)                         | `null`      | `null`        |
| Arm not yet decisionable (status is neither ready, stopped) | any         | `null`        |
| Fieller unbounded (`a <= 0`)                                | `-Infinity` | `null`        |

An unbounded lower bound is unevaluated rather than breached: `-Infinity` is below every threshold,
so comparing it would fire every Guardrail on a Run whose Control mean is merely noisy. Any other
disagreement between the two fields is a contract violation and throws: a defined relative lift with
a `null` `ci_lower`, an undefined relative lift with a finite `ci_lower`, or a `NaN` bound.

### analysis-v2: one-sided Proposition B.1 contrast (C4)

analysis-v2 replaces the two-sided Fieller Guardrail check with a one-sided always-valid bound on
the relative non-inferiority contrast, at level `alpha` (not `alpha/2`):

```
margin = downside_threshold_pct / 100
δ = T − (1 + margin) · C
Var(δ) = v_T + (1 + margin)² · v_C

# Waudby-Smith et al. Proposition B.1 lower (1−α)-AsympCS; ρ tuned at 2α (§B.2).
L = δ̂ − SE(δ̂) · sqrt( 2(1 + nρ²) / (nρ²) · log(1 + sqrt(1 + nρ²) / (2α)) )
U = δ̂ + SE(δ̂) · (same scale)
```

`arm_results[].ci_*` stay on the Fieller relative interval for reporting. Only
`guardrail_results` switch. `guardrail_results[].ci_lower` is the relative-% form of `L`:
`downside_threshold_pct + 100 · L / Ĉ` (so the field stays on the threshold scale).

**Breach / safe / undecided semantics** (affirmative claims, not "failure to establish"):

| Verdict   | Condition   | `is_breached` | Meaning                                          |
| --------- | ----------- | ------------- | ------------------------------------------------ |
| safe      | `L > 0`     | `false`       | Established non-inferiority at the locked margin |
| breach    | `U < 0`     | `true`        | Affirmative evidence of harm past the margin     |
| undecided | `L ≤ 0 ≤ U` | `null`        | Neither safety nor harm is established           |

False-safety is `P(safe | true δ < 0)`. Proposition B.1 controls that rate at `alpha` under
continuous monitoring; the seeded `stats:simulation` suite asserts it on the known-harmful
fixture within the predeclared Monte Carlo tolerance. When Control estimate is 0 or the Arm is
not decisionable, the Guardrail stays unevaluated (`is_breached: null`), same as relative lift
undefined.

## Family FDR (step 8)

The final stage converts per-(Metric, Variant) p-values into `is_significant` across the locked
goal-metric × Variant family. Production selects Benjamini-Hochberg through `analysis_version`
for legacy-unversioned and analysis-v1. analysis-v2 selects BH-G (Benjamini-Yekutieli with the
harmonic sum) for arbitrary dependence and an arbitrary stopping time; that version is defined
but unsupported for Start/Results until an ingestion-ordered observation path lands (ADR-0059).
Family definition, algorithms, "None" option, and exclusion rules live in
[multiple-comparisons-fdr.md](multiple-comparisons-fdr.md).

## Composed inference contract

BH and BH-G both rank the same p-values. Those p-values are claimed valid only under this composed
contract. Claims that are asymptotic are labeled as such; they are not exact finite-sample
guarantees.

Supported estimators that emit a decision p-value:

- Sequential default: normal-mixture asymptotic confidence sequence (aCS). The p-value is a
  boundary inversion that recomputes the mixture parameter at every candidate alpha. It is
  super-uniform under the adapter's Gaussian/asymptotic assumptions and calibration, and it has a
  point mass at 1 when the boundary near alpha 1 still covers the estimate. There is no stored
  e-process.
- Fixed-horizon opt-in: two-sample z interval at the locked Entities-per-arm only. Peeking is
  refused. This path keeps its own one-look correction story; BH-G is not required for a single
  precommitted look.

Observation assumptions the p-value inherits from earlier spine steps:

- One row per Entity per Metric. Variance is at the randomization unit (the Targeting Key).
- The analysis denominator is first-touch Exposure, after `__multiple__` quarantine.
- Winsorization, type-appropriate variance, the delta method, and CUPED (when applied) all happen
  before the adapter. The p-value is for that composed estimand, not for a raw unadjusted mean.

Asymptotic versus exact:

- aCS coverage and the inverted p-value are asymptotic. They are not an exact sequential t-test.
- Entity-level variance estimators are sample moments. Ratio Metrics add a first-order delta-method
  approximation.
- Super-uniformity can fail at tiny n (the sequential Type-I helper records an exact two-observation
  Gaussian tail well above nominal). That is why low-n is a gate, not a silent default.

Burn-in:

- The engine warns below 100 Entities in an arm. The decision gate blocks Conclude on that warning.
- That count is a standing floor, not a calibrated per-estimator burn-in. Calibration of burn-in by
  estimator remains a later item.

Dependence and stopping:

- Goal Metrics share Control Entities. Locked Primary Dimension members share Entities with the
  aggregate. Johari, Pekelis, Walsh Theorem 7.3 gives FDR control for BH over always-valid p-values
  only under a restricted stopping class and independence. Proposition C.3 gives FDR control for
  BH-G under an arbitrary stopping time and arbitrary dependence.
- Production-supported versions (legacy and analysis-v1) use BH. analysis-v2 selects BH-G in the
  exhaustive switch; it is not Startable or readable on a frozen Run until the ingestion-ordered
  observation path lands.

## Failure contracts

| Failure                                  | Behavior                                                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| N = 0 in an arm                          | Return CI = `[-∞, +∞]`, p_value = 1.0, status = `running`                                                                          |
| N < 100                                  | Report result with `health.low_n_warning = true`; do not suppress                                                                  |
| CUPED pre-period missing                 | Fall back per [variance-reduction.md](variance-reduction.md); log method in `variance_techniques`                                  |
| Ratio arm-level denominator mean `B = 0` | Return CI = `[-∞, +∞]`, p_value = 1.0, status = `insufficient_denominator`; log zero-denominator Entity count                      |
| Relative lift Control estimate `R_c = 0` | Return relative lift and CI as `null`; retain the absolute-lift decision p-value and ready status when absolute inference is valid |
| aCS divergence (NaN/inf)                 | Return error status; do not return a corrupt CI                                                                                    |

## Sources

- [../../adr/0014-stats-engine-sequential-always-valid-frequentist-by-default.md](../../adr/0014-stats-engine-sequential-always-valid-frequentist-by-default.md)
- [../../adr/0015-variance-delta-method-aggregate-to-randomization-unit.md](../../adr/0015-variance-delta-method-aggregate-to-randomization-unit.md)
- [../../adr/0016-cuped-and-winsorization-default-on-but-conditional.md](../../adr/0016-cuped-and-winsorization-default-on-but-conditional.md)
- [../../architecture/metric-analysis-seam.md](../../architecture/metric-analysis-seam.md)
- [Deng, Knoblich, and Lu, Applying the Delta Method in Metric Analytics](https://arxiv.org/abs/1803.06336)
- [Fieller, Some Problems in Interval Estimation](https://doi.org/10.1111/j.2517-6161.1954.tb00159.x)
- [Waudby-Smith, Arbour, Sinha, Kennedy, and Ramdas, Time-uniform central limit theory](https://arxiv.org/abs/2103.06476)
  (Proposition 3.5 is a sequential delta-method alternative, not a refutation of Fieller)
