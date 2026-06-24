# Leaf schemas: Experiment, Run, Metric

Canonical field lists for the experimentation-side glossary nouns. Every noun is ONE Zod schema in
`@splitch/contracts`; request, response, and storage shapes compose these leaves and never redefine them.

Any field addition here propagates to every envelope automatically.

---

## Experiment

One Experiment controls one Flag. `targetingKey` lives here, not on each Run. Multi-Flag is a documented additive extension; the schema does not preclude it.

| Field                | Type                | Required | Meaning                                                                                                                                                                     |
| -------------------- | ------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | `string`            | yes      | Stable UUID                                                                                                                                                                 |
| `appId`              | `string`            | yes      | Owning App                                                                                                                                                                  |
| `environmentId`      | `string`            | yes      | Owning Environment; co-scoped with `appId` (ADR-0027)                                                                                                                       |
| `key`                | `string`            | yes      | Unique per `(App, Environment)`                                                                                                                                             |
| `flagId`             | `string`            | yes      | The one Flag this Experiment controls                                                                                                                                       |
| `name`               | `string`            | yes      | —                                                                                                                                                                           |
| `description`        | `string`            | no       | —                                                                                                                                                                           |
| `hypothesis`         | `string`            | no       | Formal statement of expected effect                                                                                                                                         |
| `status`             | `ExperimentStatus`  | yes      | See state machine below                                                                                                                                                     |
| `targetingKey`       | `string`            | yes      | EC **field name** to bucket on (e.g. `"userId"`); inherited by every Run; changing it requires a new Run                                                                    |
| `targetingKeyType`   | `string`            | yes      | **Entity type label** the key identifies (e.g. `"user"`); stamped as `id_type` on every Exposure and validated against requests; changing it requires a new Run             |
| `confidenceLevel`    | `number`            | yes      | Default `0.95`; per-Experiment                                                                                                                                              |
| `defaultVariantId`   | `string`            | yes      | Served before first Start. Not caller-supplied — the Worker copies it from the bound Flag's per-Environment `defaultVariantId` at create time (see CreateExperimentRequest) |
| `metrics`            | `MetricRef[]`       | yes      | Goal Metrics                                                                                                                                                                |
| `guardrailMetrics`   | `MetricRef[]`       | yes      | Metrics watched for harm                                                                                                                                                    |
| `activationMetricId` | `string \| null`    | no       | Gate metric; setting/changing is an assignment edit                                                                                                                         |
| `conversionWindowMs` | `number`            | yes      | Duration in ms; 0 = unbounded                                                                                                                                               |
| `dimensions`         | `string[]`          | yes      | Attribute keys for result slicing                                                                                                                                           |
| `liveRunId`          | `string \| null`    | yes      | `null` before first Start                                                                                                                                                   |
| `createdAt`          | `string` (ISO 8601) | yes      | —                                                                                                                                                                           |
| `updatedAt`          | `string` (ISO 8601) | yes      | —                                                                                                                                                                           |

`ExperimentStatus` enum: `'draft' | 'running' | 'ended'`

- `draft` — no live Run; new Entities see Default Variant.
- `running` — at least one Start has occurred; `liveRunId` is non-null.
- `ended` — no further Runs; all Runs are frozen archives.
  Pause lives on Experiment.

`MetricRef`: `{ metricId: string }` — reference to a Metric in the same App.

---

## Run

Assignment config is frozen for the Run's life (ADR-0002, ADR-0003). Runs are independent; never pooled.

| Field              | Type                          | Required | Meaning                                                                                                |
| ------------------ | ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `id`               | `string`                      | yes      | Stable UUID                                                                                            |
| `experimentId`     | `string`                      | yes      | Owning Experiment                                                                                      |
| `environmentId`    | `string`                      | yes      | Owning Environment; co-scoped with the Experiment (ADR-0027)                                           |
| `status`           | `RunStatus`                   | yes      | See below                                                                                              |
| `targetingKeyType` | `string`                      | yes      | Entity type label frozen from the Experiment at Start (the Run's `id_type`); **immutable**             |
| `salt`             | `string`                      | yes      | Per-Run unique; drives Fractional Evaluation; **immutable**                                            |
| `allocation`       | `Record<variantName, number>` | yes      | Variant **name** → percentage; must sum to 100; **immutable**                                          |
| `variantSet`       | `Variant[]`                   | yes      | Snapshot of Flag Variants at Run creation; **immutable**                                               |
| `targetingRules`   | `TargetingRule[]`             | yes      | Resolved targeting snapshot frozen at Run creation (empty `[]` = all Entities eligible); **immutable** |
| `configHash`       | `string`                      | yes      | SHA-256 of `{salt, allocation, variantSet, targetingRules}`; computed by Worker; integrity anchor      |
| `startedAt`        | `string` (ISO 8601)           | yes      | When Start set this Run live                                                                           |
| `endedAt`          | `string \| null` (ISO 8601)   | no       | Set when Run transitions to `ended`                                                                    |
| `createdAt`        | `string` (ISO 8601)           | yes      | —                                                                                                      |

`RunStatus` enum: `'running' | 'ended'` (pause lives on Experiment.status).

Note: `targetingKey` is on `Experiment`, not `Run` — Runs inherit it.
Note: `activationMetricId` is on `Experiment` and is frozen per Run — changing it opens a new Run.

**`allocation` is keyed by Variant name, not Variant ID.** Names are what the Exposure
row records (`variant`) and what the analysis denominator groups by, what an agent or human
types when starting a Run, and — since a Variant rename is an assignment-affecting edit that
opens a new Run — stable for a Run's entire life. Keying by name keeps the integrity anchor,
the wire payload, and the analysis path on one term with no id↔name join.

**`targetingRules` is a resolved snapshot, not a Segment reference.** A draft may _select_ a
Segment, but Start resolves that Segment to its concrete `TargetingRule[]` and freezes the rules
into the Run. The Run never points at a mutable Segment: if the Segment definition changes later,
a finished Run still reflects exactly the population it actually randomized. This is why
`configHash` hashes `targetingRules` (the frozen rules), not a segment id.

---

## Metric

| Field             | Type                | Required | Meaning                                                           |
| ----------------- | ------------------- | -------- | ----------------------------------------------------------------- |
| `id`              | `string`            | yes      | Stable UUID                                                       |
| `appId`           | `string`            | yes      | Owning App                                                        |
| `key`             | `string`            | yes      | Unique per App                                                    |
| `name`            | `string`            | yes      | —                                                                 |
| `description`     | `string`            | no       | —                                                                 |
| `kind`            | `MetricKind`        | yes      | Aggregation shape                                                 |
| `eventName`       | `string`            | yes      | Tinybird event key to match                                       |
| `eventValueField` | `string \| null`    | no       | Required for `count` / `revenue`; field path inside event payload |
| `denominator`     | `MetricRef \| null` | no       | Required for `ratio`; must be in same App                         |
| `createdAt`       | `string` (ISO 8601) | yes      | —                                                                 |

`MetricKind` enum: `'binomial' | 'count' | 'revenue' | 'ratio'`

- `binomial` — 1/0 per Entity; aggregation = proportion.
- `count` — sum of `eventValueField` per Entity.
- `revenue` — sum of `eventValueField` per Entity; reported as the mean across Entities.
- `ratio` — `numerator Metric / denominator Metric` per Entity (delta-method variance).

## Sources

- [../../adr/0002-run-is-the-immutable-unit-of-analysis.md](../../adr/0002-run-is-the-immutable-unit-of-analysis.md)
- [../../adr/0003-material-edits-including-measurement-open-a-new-run.md](../../adr/0003-material-edits-including-measurement-open-a-new-run.md)
- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
