# CUPED and winsorization: default-on, but conditional on data they require

**Status:** accepted

Two variance-reduction techniques ship **on by default** but **gated** on the data they need, so neither
silently mis-applies.

## CUPED — on by default, gated on pre-period data, attribute-covariate fallback

CUPED (Deng/Xu/Kohavi/Walker, WSDM 2013) uses pre-experiment data to cut metric variance ~40–65%,
shortening experiments for the same power. All three platforms apply it (Statsig auto-on, 7-day lookback;
Eppo CUPED++, 30-day; GrowthBook CUPEDps, 14-day). The catch this design handles explicitly: **CUPED needs
pre-period data, which a new-Entity experiment does not have** — and splitch's own upstream produces a real
new-Entity slice (first-touch Entities, onboarding flows). So:

- **Apply CUPED by default when** pre-period data is present **and** coverage exceeds a threshold.
- **Fall back to assignment/attribute covariates** when metric history is missing (the new-Entity case),
  capturing what variance reduction is available without a pre-period.
- **Never silently degrade**: the absence of pre-period data switches the method, it does not quietly weaken
  a CUPED that assumed history it didn't have.
- **Never select fallback covariates from post-treatment outcomes**: attribute covariates must be declared
  before Run start or selected from pre-period / historical data without using post-exposure outcomes.
- **Fit one slope and one centering constant across both arms.** `Y_cuped = Y − θ(X − X̄)` uses the pooled
  covariate mean and a single θ, as Deng/Xu/Kohavi/Walker define it (§3.2). Centering each arm on its own
  covariate mean makes the adjustment sum to zero inside that arm, so the lift keeps the full covariate
  imbalance while the reported variance still falls to the residual: the interval narrows around an
  uncorrected estimate, and the realized Type-I error climbs with the covariate correlation. θ itself is fit
  from within-arm-centered cross products, so a real treatment effect cannot leak into the slope.

CUPED is a regression adjustment, so it composes into the same CI object before the always-valid sequence
(ADR-0014): delta-method variance (ADR-0015) → CUPED adjustment → always-valid CI.

## Winsorization — default-on for additive Metrics, never binary

Heavy-tailed Count/Revenue Metrics let a few whales dominate variance (a single $5,000 order makes its arm
"win"). Winsorization caps per-Entity values at a high percentile, replacing — not deleting — extreme values.
It is **default-on for additive Metrics (sum/count/mean/ratio)** and **never applied to Binomial Metrics** (a
0/1 has no tail). The small bias from truncation is the accepted price of a large variance reduction.
The cap is computed over the pooled analysis population, never separately per arm, and the cap rule is
locked at Run Start for decision-valid results.

**This default-on is a deliberate divergence, not a field norm.** Only **Statsig** defaults winsorization on
(at 99.9%, which we adopt as the default percentile); **Eppo and GrowthBook are opt-in per-Metric**.
Winsorization introduces bias, so defaulting it on is a real choice — we make it on the same fail-loud /
safe-default reasoning as the rest of the engine (the untreated failure, a whale silently deciding the
result, is worse than a small documented truncation bias), but we record it as a choice we own, not a
consensus we inherited. The percentile is configurable and winsorization can be turned off per Metric.

## Considered options

- **CUPED on-but-skip for new users (no covariate fallback)** — viable and safe, but leaves the new-Entity
  variance-reduction win on the table; the attribute-covariate fallback is worth the modest extra machinery.
- **CUPED unconditionally on** — rejected: silently degrades / mis-estimates on new-Entity experiments.
- **Winsorization on binary Metrics** — rejected: meaningless and slightly biasing; additive-only.
- **Per-arm winsorization caps** — rejected: different caps by arm can change each arm's estimand
  differently and mask tail effects.
- **Per-arm CUPED centering** — rejected for a sharper version of the same reason. A per-arm cap biases the
  estimand; a per-arm-centered CUPED leaves the estimand uncorrected while shrinking the interval around
  it, which is a Type-I error inflation rather than a bias. At ρ = 0.9 it takes a nominal 5% false-positive
  rate past 40%.

## Consequences

Both techniques are default-on, so users get tighter CIs and shorter experiments without opting in, but both
are gated so they cannot corrupt results when their precondition is absent. The thresholds (CUPED coverage
%, winsorization percentile) are configurable; the _gating behavior_ is not. Together with ADR-0014/0015 this
completes the one CI object: delta-method variance → winsorization (additive) → CUPED (gated) → always-valid
sequence → relative-lift CI derived by Fieller → Guardrail bound → Benjamini-Hochberg FDR across the
goal-metric × variant family (guardrails excluded).

The pooled-centering rule carries a testing obligation. "The CUPED adjustment does not shift the null mean"
is true of a per-arm-centered implementation for **every** covariate, so that assertion cannot certify the
adjustment no matter how many covariates it is run against. Only a realized A/A rejection rate can
distinguish the two, so an A/A Type-I simulation across a range of covariate correlations is a permanent
part of the stats suite, not an optional extra.

## Sources

- Deng, Xu, Kohavi, and Walker, CUPED:
  https://robotics.stanford.edu/~ronnyk/2013-02CUPEDImprovingSensitivityOfControlledExperiments.pdf
