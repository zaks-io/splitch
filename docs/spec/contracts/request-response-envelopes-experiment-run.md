# Request/response envelopes: Experiment and Experiment Run endpoints

Wire shapes for Experiment and Experiment Run control-plane endpoints: the edit taxonomy (assignment vs
measurement vs non-material) and Experiment Run immutability guards.

All Experiment and Experiment Run endpoints are per-Environment (ADR-0027): control-plane paths are
`/apps/{app_id}/envs/{environment_id}/experiments/...`. Experiments, Experiment Runs, and Exposures are
scoped by `(app_id, environment_id)`.

Envelopes compose leaf schemas from [leaf-schemas-experiment.md](./leaf-schemas-experiment.md). They are
**distinct** — never fused — because create and patch have different required fields. Shared conventions
live in [request-response-envelopes-conventions.md](./request-response-envelopes-conventions.md).
(ADR-0025 "reuse at the leaf".)

---

## Experiment endpoints

### CreateExperimentRequest

| Field                | Required | Notes                                                                                                        |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `appId`              | yes      | —                                                                                                            |
| `environmentId`      | yes      | Co-scoped with `appId`; Experiment is per-Environment (ADR-0027)                                             |
| `name`               | yes      | —                                                                                                            |
| `key`                | yes      | Unique per `(App, Environment)`                                                                              |
| `flagId`             | yes      | One Flag per Experiment                                                                                      |
| `targetingKey`       | yes      | EC field name to bucket on; inherited by all Runs; changing it on a running Experiment → `RUN_FROZEN`        |
| `targetingKeyType`   | yes      | Entity type label (the `id_type`); inherited by all Runs; changing it on a running Experiment → `RUN_FROZEN` |
| `description`        | no       | —                                                                                                            |
| `hypothesis`         | no       | —                                                                                                            |
| `confidenceLevel`    | no       | Defaults to `0.95`                                                                                           |
| `metrics`            | yes      | `MetricRef[]`, min 0                                                                                         |
| `guardrailMetrics`   | no       | Defaults to `[]`                                                                                             |
| `activationMetricId` | no       | Assignment-affecting when set                                                                                |
| `conversionWindowMs` | no       | Defaults to `0` (unbounded)                                                                                  |
| `dimensions`         | no       | Defaults to `[]`                                                                                             |
| `allocation`         | no       | Draft assignment field staged for the first Start; must sum to 100 at Start                                  |
| `salt`               | no       | Draft assignment field staged for the first Start; generated at Start when omitted                           |
| `targetingRules`     | no       | Draft assignment field staged for the first Start                                                            |
| `segmentIds`         | no       | Draft assignment field staged for the first Start; resolved to frozen targeting rules at Start               |

Worker sets: `id`, `status = 'draft'`, `liveRunId = null`, `createdAt`, `updatedAt`, and
`defaultVariantId` — copied from the bound Flag's per-Environment `defaultVariantId` (resolved via
`flagId` + `environmentId`). It is **not** a caller input: the Experiment's pre-Start default is the
Flag's default by construction, so there is exactly one source of truth and no way for the two to
diverge. If the bound Flag has no `defaultVariantId` for this Environment the create is rejected with
`VALIDATION_ERROR` (a Flag must have a default before it can back an Experiment).

### PatchExperimentRequest

Sorted by edit type. The Worker enforces the edit taxonomy (ADR-0003):

**Assignment edits** — rejected with `RUN_FROZEN` when Experiment.status = `'running'`:

- `targetingKey` — changing the EC field bucketed on
- `targetingKeyType` — changing the Entity type (`id_type`)
- `activationMetricId` — Activation Metric change is an assignment edit
- `flagId` — changing the controlled Flag
- `allocation` — draft assignment allocation for the next Start
- `salt` — draft assignment salt for the next Start
- `variantSet` — draft assignment Variant set for the next Start
- `targetingRules` — draft assignment inline rules for the next Start
- `segmentIds` — draft assignment Segment ids for the next Start

**Measurement edits** — applied to existing Run, triggers recompute, no sample reset:

- `metrics` — Secondary / exploratory Metrics recompute; goal Metric membership and locked goal Metric definitions are decision-locked
- `guardrailMetrics` — exploratory Guardrails recompute; locked Guardrail thresholds/directions are decision-locked
- `conversionWindowMs`
- `dimensions` — new post-start Dimensions are Secondary / exploratory; Primary Dimensions are locked at Run Start

**Decision-locked fields** — rejected for decision use when Experiment.status = `'running'`:

- `confidenceLevel`
- goal Metric membership / roles
- Guardrail thresholds and directions
- Primary Dimension membership / declared values

`horizon`, `targetN`, and `sampleSizeLocked` are **Run-level**, not Experiment fields: they are
frozen at Run Start and immutable for the Run's life (see [storage-schemas-d1-experiment.md](./storage-schemas-d1-experiment.md)
`runs` table). They are not patchable here at all, so they need no decision-lock on the Experiment patch.

**Non-material edits** — applied in place:

- `name`
- `description`
- `hypothesis`

**Status transitions**:

Experiment status is not patchable. Start and End are lifecycle endpoints, not `PATCH
/experiments/:id` fields. A PATCH body containing `status` is rejected by the strict request schema
with `VALIDATION_ERROR`; callers end a Run with `POST .../runs/{run_id}/end`.

`PatchExperimentRequest` field set (all optional, Worker validates taxonomy on each):

| Field                | Required | Edit type        |
| -------------------- | -------- | ---------------- |
| `name`               | no       | non-material     |
| `description`        | no       | non-material     |
| `hypothesis`         | no       | non-material     |
| `targetingKey`       | no       | assignment       |
| `targetingKeyType`   | no       | assignment       |
| `activationMetricId` | no       | assignment       |
| `allocation`         | no       | draft assignment |
| `salt`               | no       | draft assignment |
| `variantSet`         | no       | draft assignment |
| `targetingRules`     | no       | draft assignment |
| `segmentIds`         | no       | draft assignment |
| `metrics`            | no       | measurement      |
| `guardrailMetrics`   | no       | measurement      |
| `conversionWindowMs` | no       | measurement      |
| `dimensions`         | no       | measurement      |
| `confidenceLevel`    | no       | decision-locked  |

---

## Experiment Run endpoints

### StartRunRequest (opens a new Experiment Run)

The Start action ends the current running Experiment Run (if any) and opens a new Experiment Run. This
is the only path to open an Experiment Run (first-Start Run rule "first Experiment Run opens on first
Start"). Assignment config is not supplied in the Start body. It lives on the Experiment draft,
staged by `CreateExperimentRequest` or `PatchExperimentRequest` fields such as `allocation`, `salt`,
`variantSet`, `targetingRules`, and `segmentIds`. Start validates that staged draft, freezes it onto
the new Run, and then consumes the draft so an unchanged second Start returns `EXPERIMENT_NO_DRAFT`.

The request body is optional. When present, it is lifecycle metadata only:

| Field             | Required | Notes                                                              |
| ----------------- | -------- | ------------------------------------------------------------------ |
| `confirm`         | no       | `true` self-confirms when Environment Policy requires confirmation |
| `reason`          | no       | Human or agent-readable Start reason copied onto the Run           |
| `idempotency_key` | no       | Optional caller retry key; no assignment config is accepted here   |

Worker computes: `id`, dense `runNumber`, `configHash`, `status = 'running'`, `startedAt`,
`variantSet`, `allocation`, and **`targetingRules`** from the staged draft. Draft `segmentIds` are
resolved at Start into frozen `TargetingRule[]`; the Run stores the frozen rules, never Segment ids,
so a later Segment edit cannot change a finished Run's population. `targetingKey` and
`targetingKeyType` are read from the Experiment, not supplied here.

Worker writes `Experiment.liveRunId`, `ExperimentConfigKV.liveRunId`, the new `RunConfigKV`, and the
explicit `live_run:{appId}:{environmentId}:{experimentId}` pointer. Edge readers use
`ExperimentConfigKV.liveRunId` plus `RunConfigKV` as the reader model; they never derive a live Run
from the latest D1 Run.

### PatchRunRequest (non-material only)

Explicitly rejects all assignment-config fields.
Accepted Zod shape uses `.strict()` to fail on any unrecognized key.

| Field         | Required | Notes      |
| ------------- | -------- | ---------- |
| `description` | no       | —          |
| `owner`       | no       | —          |
| `tags`        | no       | `string[]` |

**Rejected fields** (Worker returns `RUN_FROZEN` if present):
`salt`, `allocation`, `variantSet`, `targetingSegmentId`, `targetingRules`, `targetingKey`

### RunResponse

Returns full Run leaf. `configHash` included for integrity verification. `variantSet` and `allocation`
are included (immutable snapshots). `endedAt` is `null` on running Runs.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0002-run-is-the-immutable-unit-of-analysis.md](../../adr/0002-run-is-the-immutable-unit-of-analysis.md)
- [../../adr/0003-material-edits-including-measurement-open-a-new-run.md](../../adr/0003-material-edits-including-measurement-open-a-new-run.md)
- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
