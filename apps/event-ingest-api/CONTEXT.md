# Event Ingest API context

Read this when touching `apps/event-ingest-api`, event append paths, Exposure row contracts,
activation events, Metric Events, Web Events, or dedup handoff.

## Owns

- Recorded event language.
- Raw append-only Exposure log behavior.
- Delivery, dedup key, and first-touch analysis handoff.
- Activation events as logged facts.
- Metric Event validation, version stamping, and append behavior.
- Web Event validation, version stamping, and append behavior.

## Terms

**Exposure**:
The event that an Entity actually encountered its assigned Variant: the variant-bearing UI rendered
or the branched codepath executed. Exposure is the only event recorded on the assignment seam. It
carries Targeting Key, Experiment, Run, Variant, and timestamp.

Analysis counts Exposures, not Assignments, as the denominator. Exposures are scoped to a Run and
deduped to unique Entities per Run, first-touch. The earliest Exposure in a Run anchors the
Conversion Window. Repeat reads, sessions, and edge nodes do not add to the count.

Avoid: impression; view; session as the denominator; counting a dry-run or test evaluation as an
Exposure.

**Exposure Pipeline**:
The path from a raw Exposure firing at the edge to a trustworthy, deduplicated analysis dataset. This
is ELT, not ETL. Every runtime appends raw Exposures to an append-only log as the system of record.
First-touch dedup is a windowed query at analysis time: first-touch per `(Entity, Run)` by earliest
timestamp. It is never collapsed at ingest.

Delivery is at-least-once with an idempotent dedup key. It is never exactly-once.

The dedup query is the single place first-touch, `__multiple__` quarantine, SRM denominator, and
Conversion Window anchor are defined.

Avoid: ETL; streaming dedup at ingest; exactly-once.

**`__multiple__` quarantine**:
If an Entity shows more than one Variant in a Run, analysis buckets it to `__multiple__`, excludes it
from arms, and tracks it as a health metric. A conflict can only be a config race, SDK bug, or
material-edit violation.

**Activation event**:
A first-class logged event used by Activation Metrics. It gets its own row on the Exposure log.
Future counterfactual triggering can add would-have-activated markers without a schema rewrite.

See [`../analysis-api/CONTEXT.md`](../analysis-api/CONTEXT.md) for Activation Metric interpretation.

**Event Definition**:
An App-level schema for one named Metric Event or Web Event whose family is immutable after creation.

**Metric Event**:
An App/Environment/Entity product fact submitted through `track()`. It is validated against the
Event Definition's current published version and appended to the separate `metric_events` log.
Metric Events supply Metric values but never become the Exposure denominator.

**Web Event**:
An App/Environment browser telemetry fact used for exploratory web analytics, never as a Metric
input or the Exposure denominator.

**Web Session**:
A bounded browser activity scope that correlates Web Events without creating Entity identity.

**Holdover write**:
The first Exposure is when the Assignment Store record is written. That record makes sticky holdover
experience possible at future Run boundaries. The Assignment Store itself is owned by evaluation.

See [`../evaluation-api/CONTEXT.md`](../evaluation-api/CONTEXT.md#assignment-store-holdover-store).

## Relationships

- Assignment is pure and records nothing.
- Exposure is the recorded fact.
- `raw_events` is the system of record for Exposures and Activations.
- `metric_events` is the system of record for Metric Events.
- Metric Event ingest accepts only Event Definitions in the `metric` family.
- Web Event ingest accepts only Event Definitions in the `web` family.
- Every Web Event belongs to one Web Session; explicit Entity identity is optional but `idType` and
  Targeting Key appear together.
- A `web` Event Definition Version with no Entity type is anonymous-only. A non-null Entity type
  permits anonymous Web Events or a complete matching identity pair.
- Web Session stitching is exploratory and never participates in Experiment measurement.
- Dedup and analysis are downstream query behavior, not ingest mutation.
- Event ingest must preserve enough raw evidence for SRM, `__multiple__`, Activation Metrics, and
  Conversion Windows.
- Event ingest never stores a raw Targeting Key and never accepts client-selected Event Definition
  versions.

## Related context

- Evaluation and assignment: [`../evaluation-api/CONTEXT.md`](../evaluation-api/CONTEXT.md)
- Metrics and SRM: [`../analysis-api/CONTEXT.md`](../analysis-api/CONTEXT.md)
- Event row contracts: [`../../packages/contracts/CONTEXT.md`](../../packages/contracts/CONTEXT.md)
