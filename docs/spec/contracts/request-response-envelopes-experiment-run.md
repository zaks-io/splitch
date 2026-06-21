# Request/response envelopes: Experiment and Run endpoints

Wire shapes for Experiment and Run control-plane endpoints: the edit taxonomy (assignment vs
measurement vs non-material) and Run immutability guards.

Envelopes compose leaf schemas from [leaf-schemas-experiment.md](./leaf-schemas-experiment.md). They are
**distinct** — never fused — because create and patch have different required fields. Shared conventions
live in [request-response-envelopes-conventions.md](./request-response-envelopes-conventions.md).
(ADR-0025 "reuse at the leaf".)

---

## Experiment endpoints

### CreateExperimentRequest

| Field | Required | Notes |
|---|---|---|
| `appId` | yes | — |
| `name` | yes | — |
| `key` | yes | Unique per App |
| `flagId` | yes | One Flag per Experiment in v1 (v1 Flag/Experiment scope) |
| `targetingKey` | yes | Inherited by all Runs; changing it on a running Experiment → `RUN_FROZEN` |
| `description` | no | — |
| `hypothesis` | no | — |
| `confidenceLevel` | no | Defaults to `0.95` |
| `metrics` | yes | `MetricRef[]`, min 0 |
| `guardrailMetrics` | no | Defaults to `[]` |
| `activationMetricId` | no | Assignment-affecting when set |
| `conversionWindowMs` | no | Defaults to `0` (unbounded) |
| `dimensions` | no | Defaults to `[]` |

Worker sets: `id`, `status = 'draft'`, `liveRunId = null`, `createdAt`, `updatedAt`.

### PatchExperimentRequest

Sorted by edit type. The Worker enforces the edit taxonomy (ADR-0003):

**Assignment edits** — rejected with `RUN_FROZEN` when Experiment.status = `'running'`:
- `targetingKey` — changing Entity type
- `activationMetricId` — Activation Metric change is an assignment edit
- `flagId` — changing the controlled Flag

**Measurement edits** — applied to existing Run, triggers recompute, no sample reset:
- `metrics`
- `guardrailMetrics`
- `conversionWindowMs`
- `dimensions`
- `confidenceLevel`

**Non-material edits** — applied in place:
- `name`
- `description`
- `hypothesis`

**Status transitions** (non-material):
- `status: 'ended'` — ends the running Run (if any) and freezes the Experiment

`PatchExperimentRequest` field set (all optional, Worker validates taxonomy on each):

| Field | Required | Edit type |
|---|---|---|
| `name` | no | non-material |
| `description` | no | non-material |
| `hypothesis` | no | non-material |
| `targetingKey` | no | assignment |
| `activationMetricId` | no | assignment |
| `metrics` | no | measurement |
| `guardrailMetrics` | no | measurement |
| `conversionWindowMs` | no | measurement |
| `dimensions` | no | measurement |
| `confidenceLevel` | no | measurement |
| `status` | no | non-material (only `'ended'` accepted via PATCH) |

---

## Run endpoints

### PublishRunRequest (opens a new Run)

The Publish action ends the current running Run (if any) and opens a new Run. This is the only path
to open a Run (first-Publish Run rule "first Run opens on first Publish"). All assignment config is supplied here.

| Field | Required | Notes |
|---|---|---|
| `experimentId` | yes | — |
| `variantSet` | yes | `Variant[]`; snapshot of the Flag's current Variants at publish time |
| `allocation` | yes | `Record<variantId, number>`; must sum to 100 |
| `salt` | no | Auto-generated UUID4 if omitted; guaranteed unique per Experiment |
| `targetingSegmentId` | no | Optional Segment gate |

Worker computes: `id`, `configHash`, `status = 'running'`, `startedAt`.
Worker writes `liveRunId` to Experiment and KV.
`targetingKey` is read from `Experiment.targetingKey` (not supplied here).

### PatchRunRequest (non-material only)

Explicitly rejects all assignment-config fields.
Accepted Zod shape uses `.strict()` to fail on any unrecognized key.

| Field | Required | Notes |
|---|---|---|
| `description` | no | — |
| `owner` | no | — |
| `tags` | no | `string[]` |

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
