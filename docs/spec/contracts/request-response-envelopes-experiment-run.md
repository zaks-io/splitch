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

| Field                | Required | Notes                                                                                                                                                                      |
| -------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appId`              | yes      | —                                                                                                                                                                          |
| `environmentId`      | yes      | Co-scoped with `appId`; Experiment is per-Environment (ADR-0027)                                                                                                           |
| `name`               | yes      | —                                                                                                                                                                          |
| `key`                | yes      | Unique per `(App, Environment)`                                                                                                                                            |
| `flagId`             | yes      | One Flag per Experiment                                                                                                                                                    |
| `targetingKey`       | yes      | EC field name to bucket on; inherited by all Runs; changing it on a running Experiment → `RUN_FROZEN`                                                                      |
| `targetingKeyType`   | yes      | Entity type label (the `id_type`); open vocabulary, typo-shaped values rejected at create/patch; inherited by all Runs; changing it on a running Experiment → `RUN_FROZEN` |
| `description`        | no       | —                                                                                                                                                                          |
| `hypothesis`         | no       | —                                                                                                                                                                          |
| `confidenceLevel`    | no       | Defaults to `0.95`                                                                                                                                                         |
| `metrics`            | yes      | `MetricRef[]`, min 0                                                                                                                                                       |
| `guardrailMetrics`   | no       | Defaults to `[]`                                                                                                                                                           |
| `activationMetricId` | no       | Assignment-affecting when set                                                                                                                                              |
| `conversionWindowMs` | no       | Defaults to `0` (unbounded)                                                                                                                                                |
| `dimensions`         | no       | Defaults to `[]`                                                                                                                                                           |
| `allocation`         | no       | Draft assignment field staged for the first Start; must sum to 100 at Start                                                                                                |
| `salt`               | no       | Draft assignment field staged for the first Start; generated at Start when omitted                                                                                         |
| `targetingRules`     | no       | Draft assignment field staged for the first Start                                                                                                                          |
| `segmentIds`         | no       | Draft assignment field staged for the first Start; resolved to frozen targeting rules at Start                                                                             |

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
- `owner`
- `tags`

**Status transitions**:

Experiment status is not patchable. Start and End are lifecycle endpoints, not `PATCH
/experiments/:id` fields. A PATCH body containing `status` is rejected by the strict request schema
with `VALIDATION_ERROR`; callers end a Run with `POST .../runs/{run_id}/end`.

`PatchExperimentRequest` field set (all optional, Worker validates taxonomy on each):

| Field                | Required | Edit type                        |
| -------------------- | -------- | -------------------------------- |
| `name`               | no       | non-material                     |
| `description`        | no       | non-material                     |
| `hypothesis`         | no       | non-material                     |
| `owner`              | no       | non-material                     |
| `tags`               | no       | non-material                     |
| `targetingKey`       | no       | assignment                       |
| `targetingKeyType`   | no       | assignment                       |
| `activationMetricId` | no       | assignment                       |
| `allocation`         | no       | draft assignment                 |
| `salt`               | no       | draft assignment                 |
| `variantSet`         | no       | **not editable** — always `400`  |
| `targetingRules`     | no       | draft assignment                 |
| `segmentIds`         | no       | draft assignment                 |
| `metrics`            | no       | measurement                      |
| `guardrailMetrics`   | no       | measurement                      |
| `conversionWindowMs` | no       | measurement                      |
| `dimensions`         | no       | measurement                      |
| `confidenceLevel`    | no       | decision-locked                  |
| `stageForNextRun`    | no       | explicit next-Run staging marker |

`variantSet` is the one field the schema accepts and the Worker always rejects. A Run's Variant set
is **derived** at Start from the Flag's Variant catalog and the staged allocation; the Experiment has
no Variant-set column to write, so there is nothing a PATCH could mean. It stays in
`PatchExperimentRequestSchema` on purpose: dropping it would make `.strict()` answer with a bare
"unrecognized key", whereas keeping it lets the Worker answer with `VALIDATION_ERROR` pointing at
`/flags/:flagId/variants` and at `allocation`. The rejection is unconditional — it does not depend on
Run state, and `stageForNextRun: true` does not change it.

On a running Run, assignment fields without `stageForNextRun: true` return `RUN_FROZEN`. The marker
does not weaken Run immutability: it writes only the Experiment's draft staging fields. Start still
owns the atomic boundary that ends Run N and opens Run N+1.

---

## Experiment Run endpoints

### StartRunRequest (opens a new Experiment Run)

The Start action ends the current running Experiment Run (if any) and opens a new Experiment Run. This
is the only path to open an Experiment Run (first-Start Run rule "first Experiment Run opens on first
Start"). Assignment config is not supplied in the Start body. It lives on the Experiment draft,
staged by `CreateExperimentRequest` or `PatchExperimentRequest` fields such as `allocation`, `salt`,
`variantSet`, `targetingRules`, and `segmentIds`. Start validates that staged draft, freezes it onto
the new Run, and then consumes the draft so an unchanged second Start returns `EXPERIMENT_NO_DRAFT`.

The request body is lifecycle metadata plus the Run-only half of the decision spec. `horizon` and
`sampleSizeLocked` are columns on `runs` and exist on no Experiment row, so there is nowhere else to
stage them; every other decision-spec field (`confidenceLevel`, the goal Metric family, the Guardrail
Metric set, `dimensions`) is staged on the Experiment and frozen from there. All of them lock at
Start (ADR-0002 Run immutability, ADR-0003 assignment-vs-measurement edits):

| Field              | Required | Notes                                                                                               |
| ------------------ | -------- | --------------------------------------------------------------------------------------------------- |
| `review`           | no       | `{ action: 'approve_and_apply' }`; inline use of the canonical Review action under `confirm`        |
| `reason`           | no       | Human or agent-readable Start reason copied onto the Run                                            |
| `horizon`          | no       | `sequential` (default) or `fixed`; frozen onto `runs.horizon`                                       |
| `sampleSizeLocked` | no       | Required when `horizon = 'fixed'`, refused when `sequential`; frozen onto `runs.sample_size_locked` |
| `idempotency_key`  | yes      | Idempotently owns Approval Request creation and any inline Review; no assignment config is accepted |

A `fixed` horizon with no `sampleSizeLocked`, or a `sequential` horizon carrying one, is refused with
`VALIDATION_ERROR` at `["body","sampleSizeLocked"]` rather than defaulted: a silently chosen stopping
rule would change what the reported result means (ADR-0036). An absent `horizon` is not that case: it
is the documented default and applies as `sequential`, on the request and equally on an Approval
proposal that recorded none.

Both values ride the Approval proposal, so a gated Start freezes the horizon the proposer chose, not
the one in effect at Review time — and both are part of what `idempotency_key` identifies. A Start
retried under the same key with a different `horizon`, `sampleSizeLocked`, or `reason` is a different
request and is refused with `IDEMPOTENCY_KEY_CONFLICT` rather than replaying the proposal it does not
match. Retried with identical intent, it still replays.

There is no `confirm` boolean or confirmation-retry pipeline. The CLI `--confirm` affordance and the
panel Confirmation modal produce `review.action = 'approve_and_apply'`. The Control Plane then uses
the same Approval Request, Review authorization, target-version check, and atomic D1 application
path as future second-person Review.

Policy changes only Review authority:

- `allow`: no Review is required; Start enters the same validated application seam directly.
- `confirm`: the proposer may supply the inline `approve_and_apply` Review.
- future `approve`: the proposer cannot self-review. Start creates a `pending` Approval Request, and
  an authorized distinct principal submits the same action through the Review endpoint.

The Approval target is the Experiment draft. Its opaque target version hashes the complete draft
assignment and decision projection, `liveRunId`, and the relevant Environment Policy projection. A
draft, live-Run, or Policy change before Review moves the request to `stale`; it never starts a
different Run or uses weaker authority than the immutable proposal.
The canonical Approval Request, Review, diff, and application-result shapes are in
[storage-schemas-d1.md](./storage-schemas-d1.md#approval_requests) and executable in
`packages/contracts/src/routes/route-shapes.ts`.

Worker computes: `id`, dense `runNumber`, `configHash`, `status = 'running'`, `startedAt`,
`variantSet`, `allocation`, and **`targetingRules`** from the staged draft. Draft `segmentIds` are
resolved at Start into frozen `TargetingRule[]`; the Run stores the frozen rules, never Segment ids,
so a later Segment edit cannot change a finished Run's population. `targetingKey` and
`targetingKeyType` are read from the Experiment, not supplied here.

Worker writes `Experiment.liveRunId`, `ExperimentConfigKV.liveRunId`, the new `RunConfigKV`, and the
explicit `live_run:{appId}:{environmentId}:{experimentId}` pointer. Edge readers use
`ExperimentConfigKV.liveRunId` plus `RunConfigKV` as the reader model; they never derive a live Run
from the latest D1 Run.

For a reviewed Start, the new Run row, prior-Run End, `Experiment.liveRunId`, successful Review,
resulting target version, and Approval Request `applied` transition commit in one owning D1
transaction. KV writes are post-commit projections. A KV projection failure is retried and surfaced
loudly; it cannot roll back or relabel an already-applied canonical D1 mutation.

Applied response:

```
{
  experimentId: string
  run: RunResponse
  previousRunId: string | null
  approvalRequest: ApprovalRequest | null
  frozenTargetingRules: TargetingRule[]  // sibling of run; same snapshot evaluation uses; [] = all eligible
  runSnapshotShipped?: boolean           // present on the direct (allow) Start door
}
```

`frozenTargetingRules` is a Start-response sibling of `run`, not a field on the Run object. It is
the resolved Targeting Rule snapshot frozen into the Run and matches `run.targetingRules` and the
`RunConfigKV` evaluation reads. An empty array means all Entities are eligible via allocation; Flag
Configuration Targeting Rules do not apply while this Run is live.

Deploy order: `frozenTargetingRules` is required on `StartRunResponseSchema` and control-plane
clients parse Start responses strictly. Publish / deploy the Worker that emits the field before CLI
or SDK clients that validate against this schema, or every `experiments start` fails body parse.

`approvalRequest` is null under `allow` and contains the applied request and latest Review under
`confirm`. When required Review is omitted or future `approve` awaits a distinct reviewer, the
mutation returns the canonical `APPROVAL_REVIEW_REQUIRED` error with the durable pending request ID;
no Run response is synthesized.

### PatchExperimentRequest response under a live Run

A successful PATCH that stages assignment fields (`allocation`, `salt`, `targetingRules`,
`segmentIds`) with `stageForNextRun: true` **while a Run is live** returns the Experiment leaf plus:

```
liveRunUnaffected?: {
  runId: string
  frozenTargetingRules: TargetingRule[]
}
```

The notice is omitted when no Run is live, and when the PATCH does not stage an assignment field.
The draft write succeeded; evaluation continues on the named Run's frozen snapshot until the next
Start.

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

GET also returns `draftTargetingRules` (nullable): the Experiment's current next-Run draft Targeting
Rules, so operators can compare the frozen `targetingRules` on this Run against the draft without a
second call. List and Start nested `run` objects omit this field.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0002-run-is-the-immutable-unit-of-analysis.md](../../adr/0002-run-is-the-immutable-unit-of-analysis.md)
- [../../adr/0003-material-edits-including-measurement-open-a-new-run.md](../../adr/0003-material-edits-including-measurement-open-a-new-run.md)
- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
