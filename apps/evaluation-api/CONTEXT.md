# Evaluation API context

Read this when touching `apps/evaluation-api`, flag resolution, experiment assignment, holdover
behavior, or test evaluation.

## Owns

- Flag resolution language.
- Targeting and Fractional Evaluation.
- Assignment, Experiment Run, and holdover replay.
- Provider and Assignment Store seams.
- Non-exposing test evaluation behavior.

## Flag and targeting terms

**Flag**:
A named feature toggle with a key, a set of Variants, Targeting Rules, and enabled state. It defines
alternative codepaths chosen at runtime based on a rule set.

Avoid: toggle or switch as nouns for the Flag itself.

**Flag Key**:
A string that logically identifies a particular Flag. Unique within an App.

**Variant**:
A possible value a Flag can return, referenced by a semantic name. Supported value shapes are
Boolean, String, Number, or JSON. Variant is OpenFeature's term and splitch's canonical word because
the public SDK is OpenFeature-shaped. Flagship's API calls this a Variation; that word is
adapter-internal and never appears in SDK or glossary language.

The full Variant catalog is App-level. Which Variants are available is per-Environment: an
Environment's Flag Configuration names a subset of the catalog. A Variant that has not been promoted
into an Environment cannot be served there.

Avoid: variation outside the Flagship adapter; arm; bucket; group; treatment for the Flag value
itself.

**Default Variant**:
The Variant returned when a Flag is disabled or no Targeting Rule matches.

**Targeting Rule**:
A priority-ordered rule of Conditions that serves a Variant when matched, optionally with a
Percentage Rollout. Conditions are attribute, operator, value triples and can combine with AND/OR.
First match wins.

**Percentage Rollout**:
A Targeting Rule component that splits traffic across Variants deterministically using the Targeting
Key. The mechanism is OpenFeature Fractional Evaluation.

**Targeting Key**:
A string logically identifying the subject of evaluation. It is the single stable identifier splitch
buckets on and measures against. Configure it per Flag or Experiment. It may identify an individual,
a session, or a group such as a workspace depending on the desired unit.

Avoid: userId; unitId; subjectId; sessionId as the domain term.

**Evaluation Context**:
The object carrying the Targeting Key and attributes used for Targeting at evaluation time.

**Targeting**:
The application of rules, overrides, or fractional evaluations during flag resolution.

**Fractional Evaluation**:
Pseudorandomly resolving a Flag value from a context property, usually the Targeting Key, by a
configured percentage. This is the concept behind percentage rollouts and A/B splits.

Avoid: bucketing or hashing as domain terms.

**Provider**:
An implementation that resolves flag values from a flag management system. splitch's default Provider
is Cloudflare Flagship, but the Provider is swappable. Provider is a stateless read-side resolver. Its
only state is an invalidatable cache of flag config, never per-Entity assignment memory.

Per-Entity holdover state lives in the Assignment Store, a sibling seam, not behind the Provider.

**Evaluation vs Resolution**:
Evaluation is the full retrieval of a flag value, including hooks and default fallback. Resolution is
the Provider retrieving the value from its source of truth. Evaluation wraps Resolution.

## Experiment and assignment terms

**Experiment**:
A test that compares Variants of one or more Flags to measure their effect on Metrics for a
population of Entities. First-class and sibling to Flags under an App. It controls Flags while
running; it does not own them.

**Entity**:
The randomization unit under experiment: what the Targeting Key identifies. It may be a user,
session, workspace, restaurant, driver, or another unit. An App may experiment on more than one
Entity type.

Avoid: subject; unit; userId.

**Control**:
The baseline Variant in an Experiment. It is the existing version being improved on. Control is a role
a Variant plays, not a separate thing.

Avoid: baseline as a noun; A.

**Treatment**:
A non-baseline Variant being tested against the Control. Treatment is a role a Variant plays in an
Experiment.

Avoid: B; challenger.

**Assignment**:
The bucketing of an Entity into a Variant: the deterministic result of
`assign(Experiment Run, Targeting Key)`. Assignment is a pure computation, not an event. It is never
recorded on its own, only recomputed when needed. The Variant it yields rides on the Exposure event
when one fires.

Avoid: allocation; bucketing; assignment-as-an-event.

**Experiment Run**:
A time-boxed, immutable window of an Experiment with a start and an end. Inside a Run, assignment
config is frozen: salt, allocation, Variant set, Targeting, Targeting Key, and Activation Metric.
Started and ended are its lifecycle verbs. The Run is the unit of analysis. Every Exposure is stamped
with its `runId`.

An assignment edit ends the current Run and opens the next, so each Run yields a clean dataset. A
measurement edit recomputes over the existing Run because raw events are the system of record.
The decision spec is locked at Run start for decision-valid results: confidence level, horizon mode
and tuning, goal Metric family, Guardrail thresholds, and Primary Dimensions. Post-start changes to
those fields are exploratory for the current Run. Non-material edits apply in place. Runs are
independent: the latest Run is the live result; prior Runs are frozen archives and are never pooled.

Assignment is pure over a Run. Because the Run is immutable, re-bucketing within a Run is impossible
by construction.

At a Run boundary, a returning Entity already exposed under a prior Run is a holdover. It keeps
showing its prior Variant for sticky experience, but is not re-counted in the new Run.

Avoid: phase; version; configVersion; analysis window; publish as the start verb; bare Run where
experiment context is unclear.

**Assignment Store** (Holdover Store):
The durable per-Entity memory that makes holdover sticky experience possible. It is keyed by
`(Experiment, idType, Targeting Key)` and stores `(runId, Variant)`, written once at an Entity's first
Exposure and read on the evaluate path.

The Assignment Store is dumb storage with zero policy. It answers what this Entity saw and under
which Run. The evaluate path owns the replay vs `assign()` decision. It is a sibling seam to the
Provider, never behind it.

Read eagerly: one edge-local lookup preloads an Entity's holdovers before flag resolution. The
physical substrate is Workers KV for reads, with first-touch writes serialized through a per-key
Durable Object that write-throughs to KV.

Avoid: assignment cache; putting it behind the Provider.

## Exposure behavior on evaluation

Reading a Variant through the SDK accessor fires an Exposure. A distinct, loudly named "peek without
exposing" accessor is the explicit deferral path. The control-plane test-evaluation dry-run endpoint
is also non-exposing: it resolves a Variant and reason for debugging and records nothing.

Exposure event ownership lives in [`../event-ingest-api/CONTEXT.md`](../event-ingest-api/CONTEXT.md).

## Ambiguities resolved here

- Targeting Key is the canonical bucketing identity and measurement identity.
- Targeting who receives a Flag and selecting the bucketing unit both use the Targeting Key.
- Variant wins over Variation in all public and domain language.
- Experiment Run is canonical. Bare Run is allowed only in clearly experimental context.
- Start and End are Experiment Run lifecycle verbs. Publish is retired.

## Related context

- Environment and Promotion: [`../control-plane-api/CONTEXT.md`](../control-plane-api/CONTEXT.md)
- Exposure ingest and dedup: [`../event-ingest-api/CONTEXT.md`](../event-ingest-api/CONTEXT.md)
- SDK accessors and Client Key: [`../../packages/sdk/CONTEXT.md`](../../packages/sdk/CONTEXT.md)
- Analysis and Metrics: [`../analysis-api/CONTEXT.md`](../analysis-api/CONTEXT.md)
