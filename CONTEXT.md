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
default Provider is Cloudflare Flagship, but the Provider is swappable. A **stateless read-side resolver**:
its only state is an invalidatable cache of flag config, never per-Entity assignment memory. Per-Entity
holdover state lives in the [[Assignment Store]], a sibling seam, not behind the Provider. (This follows
OpenFeature, which routes side-effecting experiment writes through `track()`, not `resolve`.)

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
The bucketing of an Entity into a Variant — the deterministic result of `assign(Run, Targeting Key)`.
A pure computation, **not** an event: it is never recorded on its own, only recomputed when needed.
Determined at Evaluation; the Variant it yields rides on the Exposure event when one fires. "You are
in arm B." Distinct from Exposure.
_Avoid_: allocation (Statsig's word — Assignment is canonical), bucketing; assignment-as-an-event (only
Exposure is an event)

**Run** (Experiment Run):
A time-boxed, immutable window of an Experiment with a start and an end, inside which the config (salt,
allocation, Variant set, Targeting) is frozen. The unit of analysis: every Exposure is stamped with its
`runId`, and SRM, significance, and Conversion Windows are all scoped to a Run. A **material** edit (one that changes
`assign()` or what the numbers mean — salt, allocation, Variant set, Targeting, Targeting Key, Metric
definitions, Conversion Window, Guardrail/Activation config) ends the current Run and opens the next, so
each Run yields a clean, self-consistent dataset; **non-material** edits (description, owner, tags) apply
in place. Runs are **independent**: the latest is the live result, prior Runs are frozen archives, never
pooled (a material edit resets the sample). **Assignment is pure over a Run** — because the Run is
immutable, re-bucketing within a Run is impossible by construction. At a Run boundary a returning Entity
already **exposed** under a prior Run is a **holdover**: it keeps showing its prior Variant (sticky
experience) but is *not* re-counted in the new Run. (GrowthBook calls the window a Phase; Statsig
restarts a version; the holdover-Variant store is their Persistent Assignment / Sticky Bucketing.)
_Avoid_: phase, version, configVersion (Run is canonical), analysis window

**Exposure**:
The event that an Entity actually encountered its assigned Variant (the variant-bearing UI rendered or
the branched code path executed). The **only event recorded on this seam**; it carries the assigned
Variant and its `runId` (Targeting Key, Experiment, Run, Variant, timestamp). Defaults to coincide with
Assignment; can be deferred (e.g. for below-the-fold UI) via the SDK. **Analysis counts Exposures, not
Assignments, as the denominator**, scoped to a Run. Deduped to **unique Entities per Run, first-touch**:
an Entity's earliest Exposure in a Run is the one that counts, anchoring its Conversion Window;
repeat reads, sessions, and edge nodes do not add to the count. The SDK keeps a seen-set as a hot-path
optimization only — the dedup is authoritative in the pipeline (across five edge runtimes, per-node SDK
sets cannot be the source of truth). Reading a Variant through the SDK accessor fires the Exposure; a
distinct, loudly-named "peek without exposing" accessor is the explicit deferral path.
_Avoid_: impression, view; "grain"/session as the denominator unit (the unit is Entity-per-Run; session
is a Dimension; "grain" is warehouse-internal language, never domain/SDK)

**Exposure Pipeline**:
The path from a raw Exposure firing at the edge to a trustworthy, deduplicated analysis dataset. **ELT, not
ETL**: every runtime appends raw Exposures to an **append-only log** (the system of record); first-touch
dedup is a **windowed query at analysis time** (`first-touch per (Entity, Run)`, earliest timestamp), never
a collapse at ingest. Delivery is **at-least-once with an idempotent dedup key** — never exactly-once. The
dedup query is the single place first-touch, the `__multiple__` quarantine, the SRM denominator, and the
Conversion Window anchor are all defined. An Entity showing more than one Variant in a Run is bucketed to
**`__multiple__`**, excluded from arms, and watched as a health metric (a conflict can only be a config
race, SDK bug, or material-edit violation — all defects to surface loudly).
_Avoid_: ETL / streaming-dedup-at-ingest (the log is raw, dedup is at query time); exactly-once

**Assignment Store** (Holdover Store):
The durable per-Entity memory that makes the holdover sticky-experience possible: a record keyed by
`(Experiment, idType, Targeting Key)` holding `(runId, Variant)`, written once at an Entity's first
Exposure and read on the evaluate path. It is the equivalent of Statsig's **Persistent Assignment** and
GrowthBook's **Sticky Bucketing** store. **Dumb storage, zero policy** — it answers "what did this Entity
see, and under which Run" and nothing more; the evaluate path owns the replay-vs-`assign()` decision. A
**sibling seam to the Provider, never behind it**: the Provider resolves flag config (a stateless read);
the Assignment Store persists per-Entity experiment state (a write at Exposure). The stored `Variant`
says what to replay; the stored `runId` says which Run owns this Entity's Exposures (so a holdover stays
counted in its original Run). Read eagerly — one edge-local lookup pre-loads an Entity's holdovers before
flag resolution. Substrate: the read is **Workers KV** (edge-local replica); the first-touch write is
serialized through a **per-key Durable Object** that write-throughs to KV, so concurrent POPs can't both
win a first-touch.
_Avoid_: assignment cache (that is the SDK seen-set, a different thing); putting it behind the Provider

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
A gate that filters analysis to Entities who first performed a defined **activation** action (e.g. only
users who reached checkout) — an Entity is **activated** when it performs that action. The activation must
occur **after** first Exposure (`activation_ts > first_exposure_ts`); a pre-exposure activation never
counts (counting it is post-treatment selection bias). When set, it **re-anchors the Conversion Window to
`activation_ts`** — activation is the true entry moment. **Bias trap**: if the Treatment changes whether an
Entity activates, conditioning on activation biases results in a way the full-population SRM does *not*
catch, so splitch ships two guardrails — **SRM on the activated population** (separate from the full-exposed
SRM) and **per-arm activation rate as a first-class balance metric**; either firing means the gated results
are untrusted. Activation is a **first-class logged event** (own row on the Exposure log), so future
**counterfactual triggering** (logging would-have-activated for Control) is an additive marker, not a
schema change.
_Avoid_: trigger/entry-point as separate concepts (Activation Metric is canonical); gating on a
Treatment-affected action without watching the activated-population SRM

**Conversion Window**:
The time window after an Entity's anchor during which events count toward a Metric. The anchor is
`first_exposure_ts` normally, and **`activation_ts` when an Activation Metric gates the analysis**.

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
expected split — signals broken bucketing/Assignment and invalidates the Experiment's results. Computed by
chi-square over the **same deduped denominator analysis uses** — first-touch unique Entities per arm per
Run, `__multiple__` excluded — against the Run's **declared allocation**. One denominator definition
everywhere, never a separate raw-count denominator.

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
- **Assignment** is the pure, deterministic result of `assign(Run, Targeting Key)` — it records nothing
  on its own. **Exposure** is the only event recorded; it carries the assigned Variant and `runId`. An
  Experiment's results are computed over **Exposures**, scoped to a **Run**.
- An **Experiment** runs as a sequence of **Runs**; each Run freezes the config and is the unit of
  analysis. A material config edit ends one Run and opens the next, keeping each Run's dataset clean.
  Assignment is pure over a Run, so re-bucketing within a Run cannot happen.
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
