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

CUPED is a regression adjustment, so it composes into the same CI object before the always-valid sequence
(ADR-0014): delta-method variance (ADR-0015) → CUPED adjustment → always-valid CI.

## Winsorization — default-on for additive Metrics, never binary

Heavy-tailed Count/Revenue Metrics let a few whales dominate variance (a single $5,000 order makes its arm
"win"). Winsorization caps per-Entity values at a high percentile (Statsig's 99.9% default), replacing — not
deleting — extreme values. It is **default-on for additive Metrics (sum/count/mean/ratio)** and **never
applied to Binomial Metrics** (a 0/1 has no tail). The small bias from truncation is the accepted price of a
large variance reduction.

## Considered options

- **CUPED on-but-skip for new users (no covariate fallback)** — viable and safe, but leaves the new-Entity
  variance-reduction win on the table; the attribute-covariate fallback is worth the modest extra machinery.
- **CUPED unconditionally on** — rejected: silently degrades / mis-estimates on new-Entity experiments.
- **Winsorization on binary Metrics** — rejected: meaningless and slightly biasing; additive-only.

## Consequences

Both techniques are default-on, so users get tighter CIs and shorter experiments without opting in, but both
are gated so they cannot corrupt results when their precondition is absent. The thresholds (CUPED coverage
%, winsorization percentile) are configurable; the *gating behavior* is not. Together with ADR-0014/0015 this
completes the one CI object: delta-method variance → winsorization (additive) → CUPED (gated) → always-valid
sequence → relative-lift CI → Guardrail bound → Benjamini-Hochberg FDR across the goal-metric × variant
family (guardrails excluded).
