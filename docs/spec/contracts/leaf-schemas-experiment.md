# Leaf schemas: Experiment, Run, Metric

Canonical field lists for the experimentation-side glossary nouns. Every noun is ONE Zod schema in
`@splitch/contracts`; request, response, and storage shapes compose these leaves and never redefine them.

Any field addition here propagates to every envelope automatically.

---

## Experiment

One Experiment = one Flag in v1. `targetingKey` lives here, not on each Run. Multi-Flag is a documented additive future extension; the schema does not preclude it.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | `string` | yes | Stable UUID |
| `appId` | `string` | yes | Owning App |
| `key` | `string` | yes | Unique per App |
| `flagId` | `string` | yes | The one Flag this Experiment controls in v1 |
| `name` | `string` | yes | — |
| `description` | `string` | no | — |
| `hypothesis` | `string` | no | Formal statement of expected effect |
| `status` | `ExperimentStatus` | yes | See state machine below |
| `targetingKey` | `string` | yes | Inherited by every Run; changing this requires a new Run |
| `confidenceLevel` | `number` | yes | Default `0.95`; per-Experiment |
| `defaultVariantId` | `string` | yes | Served before first Publish |
| `metrics` | `MetricRef[]` | yes | Goal Metrics |
| `guardrailMetrics` | `MetricRef[]` | yes | Metrics watched for harm |
| `activationMetricId` | `string \| null` | no | Gate metric; setting/changing is an assignment edit |
| `conversionWindowMs` | `number` | yes | Duration in ms; 0 = unbounded |
| `dimensions` | `string[]` | yes | Attribute keys for result slicing |
| `liveRunId` | `string \| null` | yes | `null` before first Publish |
| `createdAt` | `string` (ISO 8601) | yes | — |
| `updatedAt` | `string` (ISO 8601) | yes | — |

`ExperimentStatus` enum: `'draft' | 'running' | 'ended'`
- `draft` — no live Run; new Entities see Default Variant.
- `running` — at least one Publish has occurred; `liveRunId` is non-null.
- `ended` — no further Runs; all Runs are frozen archives.
Pause lives on Experiment.

`MetricRef`: `{ metricId: string }` — reference to a Metric in the same App.

---

## Run

Assignment config is frozen for the Run's life (ADR-0002, ADR-0003). Runs are independent; never pooled.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | `string` | yes | Stable UUID |
| `experimentId` | `string` | yes | Owning Experiment |
| `status` | `RunStatus` | yes | See below |
| `salt` | `string` | yes | Per-Run unique; drives Fractional Evaluation; **immutable** |
| `allocation` | `Record<variantId, number>` | yes | Percentages must sum to 100; **immutable** |
| `variantSet` | `Variant[]` | yes | Snapshot of Flag Variants at Run creation; **immutable** |
| `targetingSegmentId` | `string \| null` | no | Optional Segment gate; **immutable** |
| `configHash` | `string` | yes | SHA-256 of `{salt, allocation, variantSet, targetingSegmentId}`; computed by Worker; integrity anchor |
| `startedAt` | `string` (ISO 8601) | yes | When Publish set this Run live |
| `endedAt` | `string \| null` (ISO 8601) | no | Set when Run transitions to `ended` |
| `createdAt` | `string` (ISO 8601) | yes | — |

`RunStatus` enum: `'running' | 'ended'` (pause lives on Experiment.status).

Note: `targetingKey` is on `Experiment`, not `Run` — Runs inherit it.
Note: `activationMetricId` is on `Experiment` and is frozen per Run — changing it opens a new Run.

---

## Metric

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | `string` | yes | Stable UUID |
| `appId` | `string` | yes | Owning App |
| `key` | `string` | yes | Unique per App |
| `name` | `string` | yes | — |
| `description` | `string` | no | — |
| `kind` | `MetricKind` | yes | Aggregation shape |
| `eventName` | `string` | yes | Tinybird event key to match |
| `eventValueField` | `string \| null` | no | Required for `count` / `revenue`; field path inside event payload |
| `denominator` | `MetricRef \| null` | no | Required for `ratio`; must be in same App |
| `createdAt` | `string` (ISO 8601) | yes | — |

`MetricKind` enum: `'binomial' | 'count' | 'revenue' | 'ratio'`
- `binomial` — 1/0 per Entity; aggregation = proportion.
- `count` — sum of `eventValueField` per Entity.
- `revenue` — mean of `eventValueField` per Entity.
- `ratio` — `numerator Metric / denominator Metric` per Entity (delta-method variance).

## Sources

- [../../adr/0002-run-is-the-immutable-unit-of-analysis.md](../../adr/0002-run-is-the-immutable-unit-of-analysis.md)
- [../../adr/0003-material-edits-including-measurement-open-a-new-run.md](../../adr/0003-material-edits-including-measurement-open-a-new-run.md)
- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
