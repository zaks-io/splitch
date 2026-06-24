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

| Field                | Required | Notes                                                                     |
| -------------------- | -------- | ------------------------------------------------------------------------- |
| `appId`              | yes      | —                                                                         |
| `environmentId`      | yes      | Co-scoped with `appId`; Experiment is per-Environment (ADR-0027)          |
| `name`               | yes      | —                                                                         |
| `key`                | yes      | Unique per `(App, Environment)`                                           |
| `flagId`             | yes      | One Flag per Experiment                                                   |
| `targetingKey`       | yes      | Inherited by all Runs; changing it on a running Experiment → `RUN_FROZEN` |
| `description`        | no       | —                                                                         |
| `hypothesis`         | no       | —                                                                         |
| `confidenceLevel`    | no       | Defaults to `0.95`                                                        |
| `metrics`            | yes      | `MetricRef[]`, min 0                                                      |
| `guardrailMetrics`   | no       | Defaults to `[]`                                                          |
| `activationMetricId` | no       | Assignment-affecting when set                                             |
| `conversionWindowMs` | no       | Defaults to `0` (unbounded)                                               |
| `dimensions`         | no       | Defaults to `[]`                                                          |

Worker sets: `id`, `status = 'draft'`, `liveRunId = null`, `createdAt`, `updatedAt`, and
`defaultVariantId` — copied from the bound Flag's per-Environment `defaultVariantId` (resolved via
`flagId` + `environmentId`). It is **not** a caller input: the Experiment's pre-Start default is the
Flag's default by construction, so there is exactly one source of truth and no way for the two to
diverge. If the bound Flag has no `defaultVariantId` for this Environment the create is rejected with
`VALIDATION_ERROR` (a Flag must have a default before it can back an Experiment).

### PatchExperimentRequest

Sorted by edit type. The Worker enforces the edit taxonomy (ADR-0003):

**Assignment edits** — rejected with `RUN_FROZEN` when Experiment.status = `'running'`:

- `targetingKey` — changing Entity type
- `activationMetricId` — Activation Metric change is an assignment edit
- `flagId` — changing the controlled Flag

**Measurement edits** — applied to existing Run, triggers recompute, no sample reset:

- `metrics` — Secondary / exploratory Metrics recompute; goal Metric membership and locked goal Metric definitions are decision-locked
- `guardrailMetrics` — exploratory Guardrails recompute; locked Guardrail thresholds/directions are decision-locked
- `conversionWindowMs`
- `dimensions` — new post-start Dimensions are Secondary / exploratory; Primary Dimensions are locked at Run Start

**Decision-locked fields** — rejected for decision use when Experiment.status = `'running'`:

- `confidenceLevel`
- `horizon`, `targetN`, `sampleSizeLocked`
- goal Metric membership / roles
- Guardrail thresholds and directions
- Primary Dimension membership / declared values

**Non-material edits** — applied in place:

- `name`
- `description`
- `hypothesis`

**Status transitions** (non-material):

- `status: 'ended'` — ends the running Run (if any) and freezes the Experiment

`PatchExperimentRequest` field set (all optional, Worker validates taxonomy on each):

| Field                | Required | Edit type                                        |
| -------------------- | -------- | ------------------------------------------------ |
| `name`               | no       | non-material                                     |
| `description`        | no       | non-material                                     |
| `hypothesis`         | no       | non-material                                     |
| `targetingKey`       | no       | assignment                                       |
| `activationMetricId` | no       | assignment                                       |
| `metrics`            | no       | measurement                                      |
| `guardrailMetrics`   | no       | measurement                                      |
| `conversionWindowMs` | no       | measurement                                      |
| `dimensions`         | no       | measurement                                      |
| `confidenceLevel`    | no       | decision-locked                                  |
| `status`             | no       | non-material (only `'ended'` accepted via PATCH) |

---

## Experiment Run endpoints

### StartRunRequest (opens a new Experiment Run)

The Start action ends the current running Experiment Run (if any) and opens a new Experiment Run. This
is the only path to open an Experiment Run (first-Start Run rule "first Experiment Run opens on first
Start"). All assignment config is supplied here.

| Field                | Required | Notes                                                              |
| -------------------- | -------- | ------------------------------------------------------------------ |
| `experimentId`       | yes      | —                                                                  |
| `variantSet`         | yes      | `Variant[]`; snapshot of the Flag's current Variants at Start time |
| `allocation`         | yes      | `Record<variantId, number>`; must sum to 100                       |
| `salt`               | no       | Auto-generated UUID4 if omitted; guaranteed unique per Experiment  |
| `targetingSegmentId` | no       | Optional Segment gate                                              |

Worker computes: `id`, `configHash`, `status = 'running'`, `startedAt`.
Worker writes `liveRunId` to Experiment and KV.
`targetingKey` is read from `Experiment.targetingKey` (not supplied here).

### PatchRunRequest (non-material only)

Explicitly rejects all assignment-config fields.
Accepted Zod shape uses `.strict()` to fail on any unrecognized key.

| Field         | Required | Notes      |
| ------------- | -------- | ---------- |
| `description` | no       | —          |
| `owner`       | no       | —          |
| `tags`        | no       | `string[]` |

**Rejected fields** (Worker returns `RUN_FROZEN` if present):
`salt`, `allocation`, `variantSet`, `targetingSegmentId`, `targetingKey`

### RunResponse

Returns full Run leaf. `configHash` included for integrity verification. `variantSet` and `allocation`
are included (immutable snapshots). `endedAt` is `null` on running Runs.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0002-run-is-the-immutable-unit-of-analysis.md](../../adr/0002-run-is-the-immutable-unit-of-analysis.md)
- [../../adr/0003-material-edits-including-measurement-open-a-new-run.md](../../adr/0003-material-edits-including-measurement-open-a-new-run.md)
- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
