# splitch

Unified feature flags and A/B experimentation across the edge. splitch builds on **Cloudflare
Flagship** (the default Provider) and the **OpenFeature** standard. It adopts both glossaries
verbatim for the **flag** side, and defines its own terms only for the **experimentation** side,
which both leave undefined.

Sources of truth:
- [Flagship concepts](https://developers.cloudflare.com/flagship/concepts/) — App, Flag, Variation,
  Targeting Rule, Percentage Rollout, Evaluation Context.
- [OpenFeature glossary](https://openfeature.dev/specification/glossary/) — Targeting Key, Variant,
  Fractional Evaluation, Provider, Client, Resolution.

## Language

### Ownership & flag terms (adopted from Flagship / OpenFeature — do not redefine)

**App**:
The top-level organizational unit; groups related flags. Maps to one product/service surface. In
splitch, the **five runtimes of one product share a single App** (define a flag once, consume it
everywhere). Owns Flags; hosts Experiments.
_Avoid_: Site, Project, Tenant, Workspace (Site was the user's first word — App is canonical)

**Flag** (Feature Flag):
A named feature toggle with a key, a set of Variations, Targeting Rules, and an enabled/disabled
state. Defines alternative codepaths chosen at runtime based on a rule set.
_Avoid_: toggle, switch (as nouns for the flag itself)

**Flag Key**:
A string that logically identifies a particular flag. Unique within an App.

**Variant**:
A possible value a Flag can return, referenced by a semantic name (Boolean, String, Number, or JSON).
A Flag has one or more Variants; one is the Default Variant. OpenFeature's term and splitch's single
canonical word, because the public SDK is OpenFeature-shaped. Flagship's API calls this a "Variation"
— that word is quarantined to the Flagship adapter seam and never appears in SDK or glossary language.
_Avoid_: variation (Flagship-only, adapter-internal), arm, bucket, group, treatment

**Default Variant**:
The Variant returned when a Flag is disabled or no Targeting Rule matches.

**Targeting Rule**:
A priority-ordered rule of Conditions (attribute/operator/value, combinable with AND/OR) that serves
a Variant when matched, optionally with a Percentage Rollout. First match wins.

**Percentage Rollout**:
A component of a Targeting Rule that splits traffic across Variants deterministically using the
Targeting Key. (The mechanism is OpenFeature's Fractional Evaluation.)

**Targeting Key**:
A string logically identifying the subject of evaluation (end-user, service, workspace, etc.). The
single stable identifier splitch buckets on AND measures against. Configurable per flag/experiment —
may identify an individual, a session, or a group (e.g. workspace) depending on the desired unit.
_Avoid_: userId, unitId, subjectId, sessionId (all too narrow — Targeting Key spans them)

**Evaluation Context**:
The object carrying the Targeting Key and attributes used for Targeting at evaluation time.

**Targeting**:
The application of rules, overrides, or fractional evaluations during flag resolution.

**Fractional Evaluation**:
Pseudorandomly resolving a flag value from a context property (e.g. Targeting Key) by a configured
percentage (e.g. 50/50). The mechanism behind percentage rollouts and even A/B splits.
_Avoid_: bucketing, hashing (those are implementation; "Fractional Evaluation" is the concept)

**Provider**:
An implementation that resolves flag values from a particular flag management system. For splitch the
default Provider is Cloudflare Flagship, but the Provider is swappable.

**Evaluation** vs **Resolution**:
*Evaluation* is the full retrieval of a flag value including hooks and default fallback.
*Resolution* is the Provider retrieving the value from its source of truth. (Evaluation wraps Resolution.)

### Experiment terms (defined by splitch — Flagship & OpenFeature are silent here)

Adopted verbatim from the experimentation industry (Statsig, Eppo, GrowthBook), not invented.

**Experiment**:
A test that compares Variants of one or more Flags to measure their effect on Metrics for a population
of Entities. First-class and sibling to Flags under an App; it controls Flags while running, it does
not own them.

**Entity**:
The randomization unit under experiment — what the Targeting Key identifies. May be a user, session,
workspace, restaurant, driver, etc. (Eppo's term.) An App may experiment on more than one Entity type.
_Avoid_: subject, unit (use Entity); userId (too narrow)

**Control**:
The baseline Variant in an Experiment — the existing version being improved upon. A role a Variant
plays, not a separate thing.
_Avoid_: baseline-as-a-noun (acceptable as a synonym, but Control is canonical), A

**Treatment**:
A non-baseline Variant being tested against the Control. A role a Variant plays in an Experiment.
_Avoid_: B, challenger

**Assignment**:
The event that an Entity was bucketed into a Variant. Happens automatically at Evaluation. "You are
in arm B." Distinct from Exposure.
_Avoid_: allocation (Statsig's word — Assignment is canonical), bucketing

**Exposure**:
The event that an Entity actually encountered its assigned Variant (the variant-bearing UI rendered or
the branched code path executed). Defaults to coincide with Assignment; can be deferred (e.g. for
below-the-fold UI) via the SDK. **Analysis counts Exposures, not Assignments, as the denominator.**
_Avoid_: impression, view

**Metric**:
A fact (the event/action measured) combined with an aggregation (how it is summarized per Entity).
The thing an Experiment moves or guards.

**Binomial Metric** (Proportion Metric):
A yes/no Metric — the Entity either did the thing or did not (1/0). A **Conversion** is colloquially a
Binomial Metric event; "Conversion" is an alias, not a first-class term.
_Avoid_: conversion-as-a-distinct-concept

**Count Metric**:
A Metric that sums event values per Entity (e.g. pages per visit).

**Revenue Metric** (Mean Metric):
A Metric measuring monetary value or duration per Entity.

**Ratio Metric** (Quotient Metric):
A Metric computed as one Metric divided by another, numerator and denominator aggregated independently.

**Guardrail Metric**:
A Metric watched for unintended harm; warns when its confidence-interval bound breaches a threshold.

**Activation Metric**:
A gate that filters analysis to Entities who first performed a defined action (e.g. only users who
reached checkout).

**Conversion Window**:
The time window after an Entity's first Exposure during which events count toward a Metric.

**Dimension**:
An attribute used to slice Experiment results (e.g. country, plan, device).

**Segment**:
A named, reusable slice of traffic defined by attribute Conditions, that a Flag or Experiment is
delivered to. (Neither Flagship nor OpenFeature defines this; splitch does.)
_Avoid_: audience, cohort

**Hypothesis**:
A formal statement of what an Experiment changes and the effect it is expected to have.

**Statistical Significance**:
An indicator that the difference between Control and Treatment is unlikely to be due to chance.

**P-Value**:
The statistical measure of whether the difference between two Variants is significant.

**Confidence Interval**:
The range in which the true effect is estimated to lie at a chosen Confidence Level.

**Minimum Detectable Effect** (MDE):
The smallest effect an Experiment is powered to detect at the chosen significance and power.

**Sample Ratio Mismatch** (SRM):
A diagnostic failure where observed traffic split across Variants deviates significantly from the
expected split — signals broken bucketing/Assignment and invalidates the Experiment's results.

## Relationships

- An **App** owns many **Flags** and hosts many **Experiments**. The five runtimes of one product
  share a single App.
- A **Flag** has one or more **Variants**; one is the **Default Variant**.
- **Targeting** selects a **Variant** using the **Evaluation Context** (keyed by the **Targeting Key**).
- **Fractional Evaluation** / **Percentage Rollout** splits traffic across **Variants** using the
  **Targeting Key**.
- An **Experiment** controls one or more **Flags** (sets their Variants and the Segments they serve)
  while it runs. Experiment and Flag are siblings under an App; the Experiment drives the Flag, it
  does not own it.
- An **Experiment** randomizes **Entities** across **Variants**; one Variant is the **Control**, the
  rest are **Treatments**.
- An **Entity** is identified by the **Targeting Key** and is served a Variant via **Targeting** /
  **Fractional Evaluation**.
- **Assignment** records which Variant an Entity got; **Exposure** records that the Entity encountered
  it. An Experiment's results are computed over **Exposures**.
- An **Experiment** measures one or more **Metrics** (Binomial / Count / Revenue / Ratio), may have
  **Guardrail** and **Activation** Metrics, and can be sliced by **Dimensions**.
- **SRM** is a diagnostic over the Exposure counts per Variant; a mismatch invalidates results.

## Example dialogue

> **Dev:** "We're running an **Experiment** on `new-checkout`. Is the **Targeting Key** the user or
> the workspace?"
> **Domain expert:** "Workspace — the **Entity** is the account, so everyone in a workspace gets the
> same **Variant**. Set the Targeting Key to `workspaceId`."
> **Dev:** "And we count an **Exposure** when the flag is evaluated?"
> **Domain expert:** "No — **Assignment** happens at evaluation, but the **Exposure** only counts when
> they actually hit the checkout page. The significance math runs over Exposures, not Assignments."
> **Dev:** "Got it. Purchase rate is the **Binomial Metric**, revenue is a **Revenue Metric**, and
> we'll watch error rate as a **Guardrail Metric**. If the **SRM** check fails we throw the results out."

## Flagged ambiguities

- "userId" / "unitId" / "subject" were used interchangeably for the bucketing identity — **resolved**:
  the canonical term is **Targeting Key** (OpenFeature), which spans user/service/workspace and is
  configurable per experiment. The "target the segment vs. bucket the individual" tension is resolved
  by the Targeting Key being configurable (set it to `userId` to split individuals, `workspaceId` to
  give a whole group one variant).
- "targeting" (selecting who gets a flag) vs "the bucketing unit" (what we measure) — **resolved**:
  same identifier (**Targeting Key**) used in two roles, not two terms.
- "Variation" (Flagship) vs "Variant" (OpenFeature) — **resolved**: **Variant** wins because the public
  SDK is OpenFeature-shaped. "Variation" is quarantined to the Flagship adapter, never in SDK/glossary.
- "Site" (user's first word for the ownership root) — **resolved**: it is Flagship's **App**. Adopt App.

## Notes

- This (`~/src/splitch`) is the canonical repo.
- This file is a **glossary only** — no implementation details, no spec, no architecture. Application
  structure (packages, storage, etc.) is undecided and deliberately not scaffolded yet.
