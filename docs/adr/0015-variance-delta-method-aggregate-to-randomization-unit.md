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

## Sources

- Deng, Knoblich, and Lu, Applying the Delta Method in Metric Analytics:
  https://arxiv.org/abs/1803.06336
- Fieller, Some Problems in Interval Estimation, JRSS Series B 16(2), 1954:
  https://doi.org/10.1111/j.2517-6161.1954.tb00159.x
