# Analysis API context

Read this when touching `apps/analysis-api`, statistics, result contracts, metric queries, or
experiment health.

## Owns

- Metric and result language.
- Web Analytics read projections and Web Session association.
- SRM and health diagnostics.
- Sequential, always-valid inference language.
- Variance, CUPED, FDR, and Dimension slicing terms.

## Metric terms

**Metric**:
A fact, the event or action measured, combined with an aggregation that says how it is summarized per
Entity. It is what an Experiment moves or guards.

**Metric Event**:
An App/Environment/Entity fact validated against an immutable Event Definition Version. Metric
Events contribute values for named typed fields. They never replace or narrow the first-touch
Exposure denominator.

**Web Analytics**:
Exploratory analysis of Web Events by Web Session and optional Entity identity, separate from
Experiment measurement.

**Ambiguous Web Session**:
A Web Session containing Web Events from more than one distinct explicit Entity. Exploratory
analysis attributes the session to no Entity. This is not the Experiment-specific `__multiple__`
Variant-conflict sentinel.

**Binomial Metric** (Proportion Metric):
A yes/no Metric. The Entity either did the thing or did not. Conversion is a colloquial alias for a
Binomial Metric event, not a first-class separate concept.

Avoid: conversion as a distinct domain concept.

**Count Metric**:
A Metric that sums event values per Entity, such as pages viewed per Entity.

**Revenue Metric** (Mean Metric):
A Metric measuring summed monetary value or duration per Entity, reported as the mean of those
per-Entity sums across arms. Average order value and revenue per session are Ratio Metrics, not
Revenue Metrics.

**Ratio Metric** (Quotient Metric):
A Metric computed as one Metric divided by another. Numerator and denominator are aggregated
independently.

**Guardrail Metric**:
A Metric watched for unintended harm. It warns when its confidence-interval bound breaches a
threshold.

**Activation Metric**:
A gate that filters analysis to Entities who first performed a defined activation action. An Entity
is activated when it performs that action. Activation must occur after first Exposure:
`activation_ts > first_exposure_ts`. A pre-exposure activation never counts.

When set, the Activation Metric re-anchors the Conversion Window to `activation_ts`. If Treatment
changes whether an Entity activates, conditioning on activation can bias results. splitch ships two
guardrails for that: SRM on the activated population and per-arm activation rate as a first-class
balance metric tested by activated / not-activated chi-square at `p < 0.001`. Either firing means the
gated results are untrusted.

Activation is a first-class logged event with its own row on the Exposure log. Future counterfactual
triggering, such as would-have-activated for Control, is an additive marker rather than a schema
change.

Avoid: trigger or entry-point as separate concepts; gating on a Treatment-affected action without the
activated-population SRM.

**Conversion Window**:
The time window after an Entity's anchor during which events count toward a Metric. The normal anchor
is `first_exposure_ts`. When an Activation Metric gates analysis, the anchor is `activation_ts`.

**Dimension**:
An attribute used to slice Experiment results, such as country, plan, or device.

**Segment**:
A named reusable slice of traffic defined by attribute Conditions, delivered to a Flag or Experiment.
Flagship and OpenFeature do not define this; splitch does.

Avoid: audience; cohort.

**Hypothesis**:
A formal statement of what an Experiment changes and the effect it is expected to have.

## Statistics terms

**Statistical Significance**:
An indicator that the difference between Control and Treatment is unlikely to be due to chance.
splitch defaults to sequential, always-valid, frequentist inference. You may peek continuously
without inflating the false-positive rate. Fixed-horizon is opt-in for a pre-committed sample size.

Across many Metrics and Variants, false positives are controlled by Benjamini-Hochberg FDR over the
goal-metric by Variant family. Guardrail and secondary Metrics are excluded.

Avoid: fixed-horizon as the default; saying peeking is unsafe when always-valid inference is in use.

**P-Value**:
The statistical measure of whether the difference between two Variants is significant. In splitch it
is an always-valid p-value, not a fixed-horizon one.

**Confidence Interval**:
The range in which the true effect is estimated to lie at a chosen Confidence Level. splitch's CI is
an asymptotic confidence sequence and the single object the engine flows through: delta-method
variance, winsorization for additive Metrics, CUPED when gated, always-valid sequence, relative-lift
CI, then Guardrail bound.

Variance is always computed over per-Entity aggregates. The denominator is `COUNT DISTINCT Entity`,
never events or sessions. Ratio Metrics and any Metric finer than the Entity use the delta method.

Avoid: naive ratio-of-means variance; events or sessions as the variance denominator.

**CUPED**:
Controlled-experiment Using Pre-Experiment Data. A regression adjustment using pre-period covariates
to reduce Metric variance and shorten Experiments for the same power. It is on by default when
coverage is sufficient. New-Entity Experiments fall back to assignment or attribute covariates because
they have no history. It never silently degrades.

**Minimum Detectable Effect** (MDE):
The smallest effect an Experiment is powered to detect at the chosen significance and power.

**Sample Ratio Mismatch** (SRM):
A diagnostic failure where observed traffic split across Variants deviates significantly from the
expected split. It signals broken bucketing or Assignment and invalidates Experiment results.

SRM is computed by chi-square over the same deduped denominator analysis uses: first-touch unique
Entities per arm per Run, excluding `__multiple__`, against the Run's declared allocation.

## Relationships

- Exposure counts, not Assignment counts, are the analysis denominator.
- Analysis is scoped to one Experiment Run.
- First-touch unique Entity per Run is the denominator for Metrics and SRM.
- Metric Events join a Run only when App, Environment, Entity type, and Targeting Key hash match.
- Metrics reference only Event Definitions in the `metric` family.
- Web Events never become Metric inputs or the Exposure denominator.
- Authenticated Web Analytics reads are served by the existing Analysis Worker through the shared
  control-plane contract; clients never query Tinybird directly.
- Web Session stitching may connect anonymous and Entity-identified Web Events for exploratory
  journeys when exactly one distinct Entity appears in the session. A session with no Entity remains
  anonymous; a session with multiple Entities is an Ambiguous Web Session attributed to none.
- Query-time Web Session association never rewrites anonymous Web Event rows or supplies an
  Experiment join.
- Exposed Entities with no matching Metric Event remain in the denominator with zero-valued
  Binomial, Count, or Revenue aggregates.
- Activation Metrics re-anchor the Conversion Window.
- Dimension slicing never changes the underlying Run or Exposure facts.

## Related context

- Exposure and dedup: [`../event-ingest-api/CONTEXT.md`](../event-ingest-api/CONTEXT.md)
- Experiment Run and Assignment: [`../evaluation-api/CONTEXT.md`](../evaluation-api/CONTEXT.md)
- Result contracts: [`../../packages/contracts/CONTEXT.md`](../../packages/contracts/CONTEXT.md)
