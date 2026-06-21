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

**Organization**:
The **account / ownership unit** — who owns and is billed for splitch, and who its members are. An
Organization owns one or more Apps and has Users as members (with roles). Every account is an
Organization: self-serve signups get a **personal Organization**; **enterprise** accounts are sibling
Organizations of the same shape that additionally carry SSO/SCIM. The term is adopted verbatim from
**WorkOS**, where the Organization physically lives on the identity side. Distinct from App: an
Organization is an _organizational/ownership_ unit, **not** a product. (See ADR-0021.)
_Avoid_: using "App" for this (App is a product, not an owner); Tenant, Workspace, Account (Organization
is canonical, matching WorkOS)

**App**:
A **product / service surface**; groups related flags. Maps to one product/service surface. In
splitch, the **five runtimes of one product share a single App** (define a flag once, consume it
everywhere). Owns Flags; hosts Experiments. **Belongs to exactly one Organization** — an App is _not_
an ownership unit; the Organization is. The `app_id` boundary remains splitch's data-isolation seam
(ADR-0018). An App spans one or more **Environments** (dev, prod, …): the Flag's _definition_ — key,
schema, full Variant catalog — is App-level and defined once, but its _configuration_ (which Variants
are available, targeting, rollout, enabled state) is held **per Environment** (ADR-0027).
_Avoid_: Site, Project, Tenant, Workspace (Site was the user's first word — App is canonical); treating
an App as an org/account/tenant (that is the Organization); treating an App as a single environment
(an App spans Environments)

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
The full set of a Flag's Variants — the **Variant catalog** — is **App-level** (defined once against the
Flag's schema). **Which Variants are available is per-Environment**: an Environment's [[Flag Configuration]]
names a subset of the catalog, and a Variant that has not been **promoted** into an Environment cannot be
served there. So a half-tested model name can exist in the catalog and be served in dev while being
structurally unable to reach prod traffic (ADR-0028).
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
_Evaluation_ is the full retrieval of a flag value including hooks and default fallback.
_Resolution_ is the Provider retrieving the value from its source of truth. (Evaluation wraps Resolution.)

### Credential terms (how an SDK authenticates to the data plane — standard public/secret SDK keys)

The standard two-key SDK model, same as every provider (LaunchDarkly, Statsig, the `pk_`/`sk_` shape):
a **secret API Key** for server-side code, a **public Client Key** for client-side code. Which one you
use is determined by context — trusted server runtime vs untrusted client. (See ADR-0018.) **Both keys
are scoped to one Environment** (ADR-0027): a credential reaches exactly one Environment's data plane.
A customer's server-side runtime selects its API Key the same way it selects any per-environment config
— its own `ENV` decides which env-scoped key it loads; one credential never spans environments.

**API Key** (Secret / Server API Key):
The **secret** credential a **server-side SDK** (the customer's own backend, a trusted runtime) presents for
full data-plane access. Stored as a record (hash, scopes, revoked) and validated per-call in KV (ADR-0018).
Secret because the runtime holding it is private; **never** shipped to a browser/client. **Scoped to one
Environment** — a prod API Key reads prod config only (ADR-0027). An agent provisions
and revokes API Keys but **does not read or paste a key's value** (consistent with ADR-0022's secret
discipline) — it surfaces the key once at creation the way every provider does, then directs the developer
to where it lives.
_Avoid_: shipping it client-side; using it as the client-side SDK credential (that's the Client Key)

**Client Key** (Public / Publishable Client Key):
The **public, non-secret** identifier a **client-side SDK** (browser, mobile, any untrusted runtime) presents.
**Safe to embed in shipped client code** — public by design. Grants exactly one capability: **evaluate flags
for its App in its Environment** (scoped to one Environment, ADR-0027) for the Targeting Key in the request.
It **cannot** read the full flag config / rule set / salt,
cannot write, cannot mint keys, cannot reach another App. Abuse is bounded at the edge (origin/referrer
allow-list, rate limiting), not by hiding the value. The control plane (CLI / MCP / agent) **freely retrieves
and shares** it to wire up a client SDK.
_Avoid_: treating it as secret (it ships in the browser); using it for server-side full access (that's the
API Key)

### Environment & promotion terms (defined by splitch)

**Environment**:
A named **deployment context** under an App — `dev`, `prod`, and any others the user defines. An App
spans one or more Environments. Each Environment holds its **own** [[Flag Configuration]] per Flag, its
**own** SDK credentials (a [[Client Key]] and [[API Key]] scoped to it), its **own** experiment data
(Exposures from dev never pollute prod analysis), and its **own** [[Environment Policy]]. The familiar
LaunchDarkly/Statsig environment model; the second axis under App, orthogonal to the Flag catalog. In the
control panel it is a URL scope segment (`/{orgSlug}/{appSlug}/{env}/…`) and an environment switcher, the
same no-hidden-state discipline as App. (ADR-0027.)
_Avoid_: stage, tier, instance, deployment (Environment is canonical); treating an App as one environment

**Flag Configuration** (per-Environment Flag config):
The configuration of a single Flag **within one Environment**: `available_variant_names` (the subset of
the Flag's App-level [[Variant]] catalog that may be served here), the Targeting Rules, the rollout, and
the enabled/disabled state. The unit that is edited, audited, diffed, and **promoted**. The Flag's
_definition_ (key, schema, full catalog, Default Variant) is App-level and shared; the Flag _Configuration_
is per-Environment and diverges freely between Environments. (ADR-0028.)
_Avoid_: env config, flag state (Flag Configuration is canonical); putting availability on the Variant
itself (it lives in the Environment's Flag Configuration)

**Promotion** (verb: **Promote**):
Moving [[Flag Configuration]] — a whole config, or a single Variant's availability — **from one Environment
to another** (the headline flow: build/tune in dev, promote to prod). Distinct from **Start** (which opens
an Experiment Run for measurement) and from a plain flag edit (which changes one Environment in place).
Promotion is the _deployment_ verb; Start is the _measurement_ verb. A Promotion is subject to the target
Environment's [[Environment Policy]] (it may require a [[Confirmation]]). (ADR-0028.)
_Avoid_: deploy, ship, publish, push (Promote is canonical; "publish" is retired entirely)

**Environment Policy**:
The per-Environment rule set declaring, **per change type**, whether a change is allowed freely or must
pass a [[Confirmation]] (and, future, an approval). Change types include: **Variant availability** (promote
a Variant into this env), **targeting/rollout/value**, **enabled state** (kill switch), and **Start an
Experiment Run**. Each is independently set to `allow` | `confirm` (| `approve`, future). Dev's Policy is
typically all-`allow`; prod's Policy is the user's choice — confirm on availability only, on value too, or
on everything. This makes "prod is more careful" **configurable and structural**, not a hardcoded special
case. (ADR-0029.)
_Avoid_: guardrail (that is a Metric concept), approval flow (approval is one Policy _level_, future),
"prod is special" as a hardcoded rule (Policy is configurable per env)

**Confirmation**:
The intentionality gate an [[Environment Policy]] interposes between an intended change and its commit —
the "are you sure, this affects production" step. Not a draft and not optimistic state: the change is still
live and per-change once confirmed; Confirmation only guards the _commit_. The kill switch is never blocked
from turning a flag **off** regardless of Policy (incident control always wins).
_Avoid_: review, approval (approval is the future Policy level above Confirmation); staging/draft (a
Confirmation does not batch or stage the change)

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

**Experiment Run** (short form: **Run**, in unambiguous experiment context):
A time-boxed, immutable window of an Experiment with a start and an end, inside which the **assignment
config** (salt, allocation, Variant set, Targeting, Targeting Key) is frozen. **Started** and **ended**
are its lifecycle verbs (`draft → running → ended`); "publish" is not used for Experiment Runs (that
word is retired here to avoid colliding with [[Promotion]]). The unit of analysis: every
Exposure is stamped with its `runId`, and SRM, significance, and Conversion Windows are all scoped to a Run.
An **assignment edit** (one that changes `assign()` — salt, allocation, Variant set, Targeting, Targeting
Key, Activation Metric) ends the current Run and opens the next, so each Run yields a clean,
self-consistent dataset. A **measurement edit** (Secondary Metric definitions, Conversion Window, exploratory
Guardrail config) changes what the numbers mean but not who is in which arm, so it **recomputes losslessly
over the existing Run** — no new Run, no sample reset (the raw log is the system of record; the dedup/metric
query re-runs). The decision spec (confidence level, horizon mode/tuning, goal Metric family, Guardrail
thresholds, Primary Dimensions) is locked at Run start for decision-valid results; post-start changes are exploratory for the
current Run. **Non-material** edits (description, owner, tags) apply in place. The Run freezes _bucketing_ and
the decision spec, while allowing exploratory recomputes. Runs are **independent**: the latest is the live result, prior Runs are frozen archives, never
pooled (an assignment edit resets the sample; a measurement edit recomputes). **Assignment is pure over a Run** — because the Run is
immutable, re-bucketing within a Run is impossible by construction. At a Run boundary a returning Entity
already **exposed** under a prior Run is a **holdover**: it keeps showing its prior Variant (sticky
experience) but is _not_ re-counted in the new Run. (GrowthBook calls the window a Phase; Statsig
restarts a version; the holdover-Variant store is their Persistent Assignment / Sticky Bucketing.)
_Avoid_: phase, version, configVersion (Experiment Run is canonical), analysis window; bare "Run" where
the experiment context is not already clear (say "Experiment Run"); "publish" as the start verb (use
**Start**)

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
distinct, loudly-named "peek without exposing" accessor is the explicit deferral path. The control-plane
**test-evaluation (dry-run)** endpoint is likewise a **non-exposing** path: it resolves a Variant and its
reason for debugging/verification and records nothing (ADR-0026).
_Avoid_: impression, view; "grain"/session as the denominator unit (the unit is Entity-per-Run; session
is a Dimension; "grain" is warehouse-internal language, never domain/SDK); counting a dry-run/test
evaluation as an Exposure

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
A Metric that sums event values per Entity (e.g. pages viewed per Entity).

**Revenue Metric** (Mean Metric):
A Metric measuring summed monetary value or duration per Entity, reported as the mean of those
per-Entity sums across arms. Average order value and revenue per session are Ratio Metrics, not
Revenue Metrics.

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
Entity activates, conditioning on activation biases results in a way the full-population SRM does _not_
catch, so splitch ships two guardrails — **SRM on the activated population** (separate from the full-exposed
SRM) and **per-arm activation rate as a first-class balance metric** tested by activated / not-activated
chi-square at `p < 0.001`; either firing means the gated results are untrusted. Activation is a
**first-class logged event** (own row on the Exposure log), so future
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
An indicator that the difference between Control and Treatment is unlikely to be due to chance. splitch's
default engine is **sequential / always-valid** (you may peek continuously without inflating the
false-positive rate) and **frequentist**; fixed-horizon is an opt-in for a pre-committed sample size.
Across many Metrics and Variants, false positives are controlled by **Benjamini-Hochberg FDR** over the
goal-metric × Variant family (Guardrail and secondary Metrics excluded).
_Avoid_: fixed-horizon as the default (peeking inflates it); "peeking is unsafe" (with always-valid it is safe)

**P-Value**:
The statistical measure of whether the difference between two Variants is significant. In splitch it is an
**always-valid** p-value (valid under continuous monitoring), not a fixed-horizon one.

**Confidence Interval**:
The range in which the true effect is estimated to lie at a chosen Confidence Level. splitch's CI is an
**asymptotic confidence sequence** (always-valid), and is the single object the whole engine flows through:
delta-method variance → winsorization (additive Metrics) → CUPED (gated) → always-valid sequence →
relative-lift CI → Guardrail bound. **Variance is always computed over per-Entity aggregates** (denominator
`COUNT DISTINCT Entity`, never events/sessions); **Ratio Metrics and any Metric finer than the Entity use
the delta method** (the naive ratio-of-means/independent-events variance silently understates variance and
inflates false positives, so that path does not exist in the engine).
_Avoid_: naive ratio-of-means variance; events/sessions as the variance denominator (always the Entity)

**CUPED** (variance reduction):
Controlled-experiment Using Pre-Experiment Data — a regression adjustment using pre-period covariates to cut
Metric variance (~40–65%), shortening Experiments for the same power. **On by default, gated** on pre-period
data + coverage; falls back to assignment/attribute covariates for new-Entity Experiments (which have no
history). Never silently degrades.

**Minimum Detectable Effect** (MDE):
The smallest effect an Experiment is powered to detect at the chosen significance and power.

**Sample Ratio Mismatch** (SRM):
A diagnostic failure where observed traffic split across Variants deviates significantly from the
expected split — signals broken bucketing/Assignment and invalidates the Experiment's results. Computed by
chi-square over the **same deduped denominator analysis uses** — first-touch unique Entities per arm per
Run, `__multiple__` excluded — against the Run's **declared allocation**. One denominator definition
everywhere, never a separate raw-count denominator.

## Relationships

- An **Organization** owns one or more **Apps** and has **Users** as members. Every account is an
  Organization (personal for self-serve, enterprise as siblings); an App belongs to exactly one
  Organization. Organization is the ownership/account unit; App is the product unit.
- An **App** owns many **Flags** and hosts many **Experiments**. The five runtimes of one product
  share a single App.
- An **App** spans one or more **Environments** (dev, prod, …). A Flag's _definition_ (key, schema,
  Variant catalog, Default Variant) is App-level; its **Flag Configuration** (available Variants,
  targeting, rollout, enabled state) is per-Environment. **Promotion** moves a Flag Configuration (or one
  Variant's availability) from one Environment to another. Each Environment has an **Environment Policy**
  that may interpose a **Confirmation** before a change commits.
- An **App** issues two kinds of SDK credential **per Environment**: a secret **API Key** (server-side,
  full data-plane) and a public **Client Key** (client-side, evaluate-only). Each key reaches exactly one
  Environment. The control plane (CLI / MCP / agent) freely shares a Client Key; it provisions/revokes
  API Keys but never reads an existing key's value.
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
- An **Experiment** runs as a sequence of **Runs**; each Run freezes the _assignment_ config and is the
  unit of analysis. An assignment edit ends one Run and opens the next, keeping each Run's dataset clean; a
  measurement edit recomputes over the existing Run. Assignment is pure over a Run, so re-bucketing within a
  Run cannot happen.
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
- "API key" vs "client key" — **resolved**: the standard two-key SDK model. **API Key** = secret,
  server-side, full data-plane. **Client Key** = public, client-side, evaluate-only. A client-side SDK can't
  hold a secret (it ships in the browser), so it gets the public Client Key and the endpoint is made safe by
  edge controls. The agent shares Client Keys; it provisions API Keys but never reads their value. Both keys
  are **per-Environment** (ADR-0027).
- "Environment" was absent from the original model ("five runtimes share one App, define once everywhere")
  — **resolved**: Environment is a first-class **second axis** under App. "Define once" applies to the Flag
  _definition_ (key, schema, Variant catalog); the per-Environment **Flag Configuration** is what diverges
  and is **promoted** between Environments. Variant _catalog_ is App-level, Variant _availability_ is
  per-Environment (ADR-0027/0028).
- "publish" vs "promote" vs "start" — **resolved**: three distinct verbs, none overlapping. **Start/End** an
  **Experiment Run** (measurement). **Promote** a **Flag Configuration** between **Environments** (deployment).
  **Confirm** a change through an **Environment Policy** gate. "Publish" is retired (it conflated Start and
  Promote).
- "Run" alone is too generic — **resolved**: the canonical term is **Experiment Run**; bare "Run" is allowed
  only where the experiment context is already unambiguous.
- slugs vs IDs — **resolved**: `orgSlug`/`appSlug` exist **only** for human/agent-readable URLs. IDs
  (`org_…`, `app_…`) are canonical everywhere in code, data, and the API; the router resolves slug → ID once
  at the edge and everything below speaks IDs. Never key data or internal lookups on a slug.

## Notes

- This (`~/src/splitch`) is the canonical repo.
- This file is a **glossary only** — no implementation details, no spec, no architecture. Application
  structure, package layout, storage seams, and deployment workflow live in the specs and repo config.
