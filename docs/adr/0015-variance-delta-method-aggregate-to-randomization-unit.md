# Variance correctness: delta method over per-Entity aggregates; no naive ratio-of-means path

**Status:** accepted

This ADR records the **non-negotiable** correctness rules of the variance computation. They are not
preferences — all three reference platforms (Statsig, Eppo, GrowthBook) implement exactly this method
(aggregate-to-unit + delta method), and the methodology literature (Deng/Knoblich/Lu, KDD 2018) is the
canonical proof (Eppo cites it directly; Statsig and GrowthBook implement the same method without naming a
source). Each rule guards a _silent_
error: the point estimate (lift) looks correct while the variance is wrong in the dangerous direction —
understated — so CIs are too narrow and the false-positive rate explodes.

1. **Always aggregate to the randomization unit (the Entity) before computing variance.** The denominator
   is `COUNT DISTINCT Entity`, never events or sessions. Treating an Entity's many correlated observations
   as independent understates variance and pushes the false-positive rate from 5% to ~25% (≈8 obs/Entity)
   and past 60% as observations per Entity grow. This ratifies ADR-0005's Entity-per-Run denominator.

2. **Delta method for Ratio Metrics and any Metric whose grain is finer than the Entity.** When the analysis
   unit (Entity) differs from the Metric's denominator unit (e.g. clicks-per-session, randomized on the
   user), numerator and denominator are correlated and the naive ratio-of-means variance is wrong. The delta
   method (first-order Taylor expansion including the covariance term) is the fix. The clustered-data problem
   (rule 1) and the ratio-metric problem are the **same** problem — analysis unit ≠ denominator unit — with
   the **same** fix.

3. **No naive variance code path exists.** The engine does **not** expose a ratio-of-means or
   events-as-independent variance path at all. The delta-method-over-Entity-aggregates path is the _only_
   path, so the silent error is structurally unreachable, not merely discouraged.

4. **Absolute lift is the decision; the published relative interval is derived from it.** Absolute lift is
   the simpler sum-of-variances, and it is the quantity the always-valid sequence (ADR-0014) is applied to.
   Relative lift is a ratio of the two arm means, and its interval is obtained by inverting that same
   absolute test with Fieller's theorem, never estimated a second time. Substituting a ratio of 1 into
   Fieller's quadratic reduces it to `(T − C)² ≤ k²(vT + vC)`, which is precisely the absolute test, so the
   published relative interval contains 0% lift **if and only if** the decision interval contains zero. Two
   independently estimated intervals do not have that property: the relative test statistic is smaller than
   the absolute one for a win and larger for a loss, so they disagree in a band around the threshold, and
   the disagreement is one-sided by direction. Guardrail Metrics fire on a **CI lower-bound breach** of a
   downside / non-inferiority threshold (CONTEXT.md; Eppo/Spotify), reading the same CI object, so a
   disagreement there is a mis-fired or a missed Guardrail, not a cosmetic inconsistency.

5. **Zero-denominator Entities stay in the randomized population.** A Ratio Metric is a ratio of
   per-Entity aggregate means, so `denom_i = 0` is data, not a row-level exclusion rule. Dropping those
   Entities changes the estimand and can create post-treatment selection bias. The ratio is unestimable
   only when the arm-level denominator mean is zero.

## Per-type variance estimators

- **Binomial** — Bernoulli `p(1−p)` over per-Entity 0/1.
- **Count / Revenue (Mean)** — sample variance of per-Entity sums.
- **Ratio** — delta method with the covariance term (rule 2).
- All feed the same always-valid CI (ADR-0014) after CUPED adjustment (ADR-0016).

## Considered options

- **Naive ratio-of-means / events-as-independent variance** — rejected as a code path entirely (rule 3).
  This is the single most common silent error in industry experimentation; the only safe design is to make
  it impossible to invoke.
- **A delta-method relative-lift CI estimated independently of the absolute CI** — rejected (rule 4). It is
  a defensible interval for the ratio taken in isolation, but it is not the interval the decision was made
  on, so a Run can read "not significant" beside an interval sitting entirely below zero. This was the
  original implementation and it is what rule 4 now forbids.
- **Rescaling the absolute bounds by the Control mean** — rejected (rule 4). It is trivially consistent
  with the decision, but it treats the Control mean as known and so publishes an interval that is too
  narrow. On the engine's own golden fixture it cleared a Guardrail that the correct interval breaches, so
  the failure mode is a missed downside, not a cosmetic one.

## Consequences

Every Metric computation aggregates to the Entity first, then applies the type-appropriate variance, then
the delta method wherever the unit differs from the denominator. This is more machinery than a naive engine,
but it is the machinery that makes the numbers trustworthy — the whole point of the seam. Winsorization of
heavy-tailed additive Metrics composes here (ADR-0016).

Rule 4 has a visible consequence users will meet: Fieller's interval is **unbounded** when the Control mean
is not itself separated from zero at the confidence level (the quadratic's leading coefficient goes
non-positive). The engine publishes an infinite bound there rather than a finite number it cannot support.
That is the fail-loud answer for a ratio whose denominator might be zero, and it is a real behavioural
difference from the delta method, which always returned something finite and confident-looking. Runs whose
Control arm sits near zero should be read on absolute lift.

## Amendment: sequential coverage audit (C11, D1)

Plan v2.1 reversed D1 to "keep and audit". This amendment records the Monte Carlo evidence. The
production estimator is unchanged.

**D1 is confirmed.** Time-uniform coverage of the current Fieller inversion stays inside the
predeclared Monte Carlo bound of alpha on binomial, count, revenue (heavy-tailed), and ratio Metrics,
with CUPED applied where the engine allows it (Ratio excludes CUPED). Coverage fixtures use nonzero
true lifts (±20%): Fieller's inclusion of 0% reduces to the absolute null test, so a zero-lift
fixture cannot catch a relative-bound scaling bug that still covers zero. A delta-method relative
interval on the same sequential critical multiplier (Waudby-Smith Proposition 3.5 style) does not
beat Fieller on ever-miscoverage, and on binomial and revenue it is often more anti-conservative.
There is no demonstrated coverage or Guardrail failure that would justify replacing rule 4.

Unexpected missing absolute or relative estimates, and sequential CI errors, fail the audit loud.
Coverage fixtures assert zero undefined-trial rate. The only legitimate unpublished relative lift is
the zero-Control domain case.

### Seeds, schedule, and tolerance

- Gate: `pnpm stats:simulation -- --mode=audit` (smoke caps at 40 iterations and looks `[80, 160, 280]`)
- Seed family: `424242`, per-scenario suffix `:{kind}:{raw|cuped}:{plus20|minus20}`, domain
  `:domain:{zero|signed|near-zero}`, Guardrail `:guardrail:{known-safe|known-harmful}`
- Audit iterations: 300. Alpha: 0.05. `target_n`: 1250.
- Looks: 80, 120, 180, 260, 380, 520, 700, 950, 1250.
- Tolerance: `max(0.02, 3 * sqrt(alpha * (1 - alpha) / n))` = 0.0377 at n=300.
- Guardrail threshold: -10% relative. Known-safe true lift 0% (count, CUPED on). Known-harmful true
  lift -20% (treatment mean 8 vs Control 10).
- Ever-miscoverage counts a trial if any look's finite interval misses the true relative lift.
  An unbounded Fieller interval is counted as covering, not as a miss.

### Time-uniform coverage (ever-miscoverage at ±20% true lift)

| Metric   | CUPED | True lift | Fieller | Delta-method CS | Fieller unbounded |
| -------- | ----- | --------- | ------- | --------------- | ----------------- |
| binomial | off   | +20%      | 0.0200  | 0.0300          | 0.0133            |
| binomial | off   | -20%      | 0.0100  | 0.0200          | 0.0233            |
| binomial | on    | +20%      | 0.0233  | 0.0167          | 0                 |
| binomial | on    | -20%      | 0.0133  | 0.0067          | 0                 |
| count    | off   | +20%      | 0.0067  | 0.0067          | 0                 |
| count    | off   | -20%      | 0.0167  | 0.0167          | 0                 |
| count    | on    | +20%      | 0.0067  | 0.0067          | 0                 |
| count    | on    | -20%      | 0.0200  | 0.0200          | 0                 |
| revenue  | off   | +20%      | 0.0167  | 0.0467          | 0.0200            |
| revenue  | off   | -20%      | 0.0067  | 0.0467          | 0.0567            |
| revenue  | on    | +20%      | 0.0100  | 0.0200          | 0.0300            |
| revenue  | on    | -20%      | 0.0033  | 0.0167          | 0.0333            |
| ratio    | off   | +20%      | 0.0067  | 0.0067          | 0                 |
| ratio    | off   | -20%      | 0.0067  | 0.0033          | 0                 |

All Fieller rates are below alpha + 0.0377. Every coverage fixture recorded `undefinedTrials = 0`.
Revenue's higher unbounded rate is the Control mean failing to separate from zero under a heavy
tail, which is the documented `a <= 0` hull, not a silent number.

### Guardrail breach (same sequential boundary)

| Fixture       | True lift | Fieller last look | Delta last look | Fieller ever | Delta ever |
| ------------- | --------- | ----------------- | --------------- | ------------ | ---------- |
| known-safe    | 0%        | 0.00              | 0.00            | 0.78         | 0.85       |
| known-harmful | -20%      | 1.00              | 1.00            | 1.00         | 1.00       |

Last look is the decision-time rate at 1250 Entities per arm. Ever-breach is not a Type I rate: a
wide early interval that still covers 0% can sit entirely below -10%, so the current
`ci_lower < threshold` rule fires while the snapshot is uninformative. Fieller and the delta-method
comparator agree at the last look. Early looks fire more often on the delta-method interval, which
matches ADR-0015's original reason for rejecting an independently estimated relative bound (it is
narrower and over-fires or under-fires relative to the absolute decision).

### Domain of signed, zero, and near-zero Control means

Recorded on the same audit seed and schedule. The engine already fails loud. No production change.

| Control mean                          | Relative lift        | Interval                        | Guardrail           |
| ------------------------------------- | -------------------- | ------------------------------- | ------------------- |
| Exactly 0 (binomial, no conversions)  | unpublished (`null`) | unpublished (`null`)            | `is_breached: null` |
| Negative and separated from zero      | defined (−25%)       | bounded; 1.33% ever-miscoverage | evaluated           |
| Near zero (count mean 0.04, spread 7) | defined              | unbounded on 98% of trials      | `is_breached: null` |

A Control mean of exactly zero never publishes a percentage. A Control mean that is not separated
from zero publishes `(-Infinity, +Infinity)` rather than a finite-looking delta-method interval.
Those are the fail-loud answers; the audit did not find a NaN or a silent default. Signed Control
means stay defined as `(T / C - 1) * 100` (here Control −12 and Treatment −9 yield −25%, while
absolute lift is +3). Read those Runs on absolute lift when the percentage sign is easy to misread.

Replacement remains reserved for a later demonstrated failure. C4's one-sided Guardrail bound
(below) uses the arm means and variance components from the same absolute path; it does not
replace the Fieller reporting interval on `arm_results`.

## Amendment: one-sided Guardrail bound (C4, analysis-v2)

Plan item 0.8. Two-sided Fieller Guardrail checks are conservative for a one-sided safety claim,
not invalid. analysis-v2 switches Guardrail decisions to a one-sided always-valid bound;
legacy-unversioned and analysis-v1 keep the two-sided Fieller rule above so their result tokens
stay byte-identical. The ingestion-ordered observation path makes analysis-v2 supported and
`CURRENT_ANALYSIS_VERSION`: new Starts freeze v2 and pick up the one-sided Guardrail bound.

### Bound

For locked margin `m = downside_threshold_pct / 100`, the raw contrast is
`D = T − (1 + m) C` with `Var = v_T + (1 + m)² v_C`. Relative lift
`R = (T − C) / C` satisfies `D = C · (R − m)`, so analysis-v2 orients by Control sign:
`δ* = sign(C) · D` (= `|C| · (R − m)` when sign is identified).

**Union bound at `alpha`.** Establishing `sign(C)` and testing the oriented contrast cannot
both spend the full `alpha` without inflating false-safety (picking orientation from the
noisy Control estimate and then testing either side at `alpha` can roughly double the
false-safe rate). The budget splits:

1. **Control sign — two-sided always-valid interval at `α/2`** (sequential: two-sided
   normal-mixture CS on Control; fixed: `z_{1−α/4}`). A one-sided sign test is the wrong
   tool: the side would be chosen from `Ĉ`. If the interval spans 0, the Guardrail is
   undecided.
2. **Oriented contrast — one-sided always-valid bound at `α/2`** (sequential: Waudby-Smith
   Proposition B.1 at `α/2` with `ρ` tuned at `α = 2 · (α/2)`, §B.2; fixed: `z_{1−α/2}`).
   Mixture scale at the contrast alpha `α' = α/2`:

```
sqrt( 2(1 + nρ²)/(nρ²) · log(1 + sqrt(1 + nρ²)/(2α')) )
```

This is not the two-sided bound at doubled alpha: the additive 1 inside the log is
required. The verdict (safe/breach/undecided) comes only from this contrast bound.

**Power cost.** Both pieces run at `α/2`, so boundaries are wider than a single level-`α`
procedure. Joint false-safety stays ≤ `α` by the union bound.

A relative-scale map `m + L/|Ĉ|` is not a valid lower confidence bound for relative lift
and is not emitted. `guardrail_results[].ci_lower` stays the Fieller reporting interval from
`arm_results`; the Guardrail verdict is `is_breached`, reported separately. Arm means and
variance components are taken from one pooled per-Metric estimate across every allocated arm
so winsorization and CUPED match `arm_results`.

### Breach semantics

| Verdict   | Condition                         | `is_breached` | Meaning                                          |
| --------- | --------------------------------- | ------------- | ------------------------------------------------ |
| safe      | `L > 0`                           | `false`       | Established non-inferiority at the locked margin |
| breach    | `U < 0`                           | `true`        | Affirmative evidence of harm past the margin     |
| undecided | `L ≤ 0 ≤ U`, or Control sign open | `null`        | Neither claim established                        |

**Breach means affirmative harm**, not failure to establish safety. That is a deliberate
semantic change from analysis-v1's `ci_lower < threshold` rule, which fired on wide
uninformative intervals. False-safety (`P(safe | true δ* < 0)`) is jointly controlled at
`alpha` by the union bound; the seeded known-harmful simulation and Codex near-zero-Control
Gaussian draws (`pnpm stats:simulation`, seed `424242`) keep the false-safe rate within
`alpha + monteCarloTolerance`.

`arm_results` relative intervals remain Fieller under every version. analysis-v2 Guardrail
_decisions_ read the oriented contrast; reporting `ci_lower` stays Fieller.

## Sources

- Deng, Knoblich, and Lu, Applying the Delta Method in Metric Analytics:
  https://arxiv.org/abs/1803.06336
- Fieller, Some Problems in Interval Estimation, JRSS Series B 16(2), 1954:
  https://doi.org/10.1111/j.2517-6161.1954.tb00159.x
