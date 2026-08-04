# Control-plane endpoints: Experiment and Experiment Run

Request/response shapes for the Experiment and Experiment Run resource groups, including the
draft/start lifecycle.

**Environment-scoped.** Experiments, Experiment Runs, and their Exposures are per-Environment
(ADR-0027), so these endpoints live under `/apps/{app_id}/envs/{environment_id}/…`. An Experiment in
`dev` and one in `prod` are distinct; their data never mixes. `environment_id` is the canonical ID
(slugs are URL-presentation only — these are API paths, so they carry the ID).

The lifecycle verb is **Start** (not "publish"): `draft → running → ended`. See
[run-state-machine.md](run-state-machine.md).

All endpoints live on the **Control Plane API Worker** and require a control-plane bearer token. All
requests/responses are `Content-Type: application/json`. Error shape, pagination, and the shared
conventions are described in [control-plane-endpoint-inventory.md](control-plane-endpoint-inventory.md).

## Experiment endpoints

### `GET /apps/{app_id}/envs/{environment_id}/experiments`

### `POST /apps/{app_id}/envs/{environment_id}/experiments`

Body (create draft):

```
{
  name: string,
  description?: string,
  hypothesis?: string,
  flag_id: string,
  targeting_key_field: string,       // which attribute is the Targeting Key
  variants: [{ name: string, is_control: boolean }],   // must be available in this Environment (ADR-0028)
  segment_ids?: string[],
  confidence_level?: number           // default 0.95
}
```

Returns: `{ experiment_id, app_id, environment_id, flag_id, name, status: "draft", variants, created_at }`
Status is always `draft` on creation; no Run yet.

**Variant availability invariant:** every Variant referenced must be in the Flag's available set for
`environment_id` (ADR-0028). A Variant not promoted into this Environment is rejected with
`VARIANT_NOT_AVAILABLE` — a Run cannot test a Variant that cannot be served here.

`(app_id, environment_id, key)` stays unique including archived rows. Creating a draft whose key is
still held by an archived Experiment returns `409 EXPERIMENT_KEY_CONFLICT` with
`details.archivedExperimentId` (keys are not freed or renamed on archive).

### `GET /apps/{app_id}/envs/{environment_id}/experiments/{experiment_id}`

Returns: Experiment including `live_run_id` (null if no running Run), draft allocation, draft targeting.

### `PATCH /apps/{app_id}/envs/{environment_id}/experiments/{experiment_id}`

**Draft assignment-config fields** (accumulate on draft, Start to apply):

```
{
  allocation?: { [variant_name]: number },  // must sum to 100
  salt?: string,                             // override auto-generated salt
  targeting_key_field?: string,
  targeting_rules?: TargetingRule[],
  segment_ids?: string[],
  activation_metric_id?: string | null       // assignment-affecting
}
```

While a Run is running, assignment fields require `stageForNextRun: true` in the PATCH body. The
marker is the explicit distinction between configuring the next Run and attempting to mutate the
live Run. Without it, the Worker returns `409 RUN_FROZEN`; with it, the edit accumulates into the
single next-Run draft the Experiment holds. An omitted field keeps whatever that draft already
holds, so a later staged PATCH never reverts an allocation, salt, Targeting Rule set, or Segment
reference staged by an earlier one. Start remains the only operation that ends the current Run.

What happens to a field the draft has **no** value for is not uniform, and the difference is
material:

| Staged field      | Draft empty at Start                                                            |
| ----------------- | ------------------------------------------------------------------------------- |
| `allocation`      | Carried forward from the running Run's frozen allocation.                       |
| `targeting_rules` | Carried forward from the running Run's frozen (already Segment-resolved) rules. |
| `salt`            | **Not** carried forward. Start mints a fresh salt.                              |
| `segment_ids`     | **Not** carried forward. Defaults to the empty list.                            |

The salt row is the consequential one. A staged PATCH that does not set `salt` explicitly leaves
the draft salt null, and Start then generates a new one — so **the next Run re-randomizes the
entire sample**. Every subject may land in a different Variant than it did in the previous Run.
That is deliberate: a new Run is a new bucketing boundary, so an allocation change cannot silently
reshuffle only part of the audience. If the next Run must reuse the current Run's bucketing, send
`salt` explicitly with the running Run's salt value (readable from the Run) in the staged PATCH.

`segment_ids` does not carry forward because a Run stores no Segment references at all: Start
resolves Segments into concrete Targeting Rules and freezes those. The resolved rules are what
`targeting_rules` carries forward, so traffic is not silently widened; the references themselves
have to be re-staged if the next Run should track a live Segment.

`flag_id`, `targeting_key_field`, `targeting_key_type`, and `activation_metric_id` have no draft
column of their own. While a Run is running they are rejected with `409 RUN_FROZEN` even under
`stageForNextRun: true`; the stageable set is exactly `allocation`, `salt`, `targeting_rules`, and
`segment_ids`, and nothing else.

**Measurement-config fields** (apply to live Run in place, no reset):

```
{
  metrics?: MetricRef[],                  // post-start additions are Secondary / exploratory
  conversion_window_hours?: number,
  guardrail_config?: GuardrailConfig[]     // thresholds locked for decision-valid Guardrails
}
```

Decision-locked fields (`confidence_level`, `horizon`, `target_n`, `sample_size_locked`, goal
Metric membership, Guardrail thresholds, and Primary Dimensions) cannot be changed for the current
running Run's decision-valid result after Start. They may be drafted for the next Run or surfaced
as exploratory analysis.

**Non-material fields** (apply in place):

```
{ name?, description?, hypothesis?, owner?, tags? }
```

Returns: updated Experiment.

### `POST /apps/{app_id}/envs/{environment_id}/experiments/{experiment_id}/start`

Starts the draft as a new Run; ends any running Run.
Body:
`{ review?: { action: "approve_and_apply" }, reason?: string, horizon?: "sequential" | "fixed",
sampleSizeLocked?: number | null, idempotency_key: string }`
`horizon` and `sampleSizeLocked` are the Run-only half of the decision spec; they exist as columns on
`runs` alone, so Start is where they are chosen and frozen. `horizon` defaults to `sequential`, both
on the request and on an Approval proposal that recorded none. A `fixed` horizon without a
`sampleSizeLocked`, or a `sequential` horizon carrying one, is refused with `VALIDATION_ERROR` rather
than defaulted (ADR-0036). Both fields are part of what `idempotency_key` identifies: a Start retried
under the same key with different intent is refused with `IDEMPOTENCY_KEY_CONFLICT`, never replayed
as the earlier one.
`reason` is an optional human note capturing _intent_ for the new Run ("testing higher exposure to
v2"). It is stored as the Run's `start_reason` and surfaced by the Run-history timeline alongside the
**derived** assignment-config diff from the prior Run (the timeline never depends on it being present —
see [../frontend/screen-inventory.md](../frontend/screen-inventory.md)). Symmetric with the optional
`reason` on `/end`.
Returns:
`{ experiment_id, run: RunObject, previous_run_id?: string, approval_request: ApprovalRequest | null }`.
`approval_request` is null under `allow` and the applied request under `confirm`.
See [run-state-machine.md](run-state-machine.md) for transition details.
Auth: App `owner` or `admin`. **Subject to the Environment Policy** (ADR-0029): if this Environment's
Policy gates "Start an Experiment Run" at `confirm`, the proposer is authorized to perform the
inline `approve_and_apply` Review. If the Review is omitted, the server persists the immutable
Approval Request and returns `409 APPROVAL_REVIEW_REQUIRED`; no Run state changes. The CLI/MCP
`--confirm` affordance derives `review.action = "approve_and_apply"` (see
[../contracts/mcp-tool-derivation.md](../contracts/mcp-tool-derivation.md)).

Under `allow`, no Review is required and Start enters the same validated application seam directly.
Future `approve` changes Review authority only: the proposer cannot self-review, and an authorized
distinct principal performs the same `approve_and_apply` action. Authorization and target-version
validation happen before mutation. The Run mutation, Review, resulting version, Approval Request
transition, and bounded audit metadata commit atomically in D1. KV is a post-commit projection.

The request and Review lifecycle, idempotency behavior, stale handling, and fail-loud errors are
canonical in [../contracts/error-responses.md](../contracts/error-responses.md#approval-request-and-review-errors).

### `DELETE /apps/{app_id}/envs/{environment_id}/experiments/{experiment_id}`

Blocked if a Run is `running` (`EXPERIMENT_RUNNING`). Otherwise soft-deletes: sets
`status = archived`, clears `live_run_id`, and retains the Experiment row and every Run row in D1.
Archived Experiments are omitted from default list/get surfaces (GET returns `EXPERIMENT_NOT_FOUND`).
Repeat DELETE of an already-archived Experiment is a no-op success (`{ deleted: true }`) after
authz. Retention is storage-internal for analysis joins (Tinybird / warehouse keys); there is no
control-plane list of archived Experiments or their Runs in this surface. `GET …/runs/{run_id}` by
id remains readable. Parent teardown (Flag / Environment / App delete) hard-deletes archived
Experiments and their Runs as part of the cascade once no non-archived Experiment remains.

## Experiment Run endpoints

### `GET /apps/{app_id}/envs/{environment_id}/experiments/{experiment_id}/runs`

Returns: list of Runs (all statuses), newest first.

### `GET /apps/{app_id}/envs/{environment_id}/experiments/{experiment_id}/runs/{run_id}`

Returns: full Run object (frozen assignment config + measurement config snapshot + status).

### `POST /apps/{app_id}/envs/{environment_id}/runs/{run_id}/end`

Ends a running Run. See [run-state-machine.md](run-state-machine.md).
Body: `{ reason?: string }` (optional human-readable note)
Returns: ended Run object.
Auth: App `owner` or `admin`.

**Note:** PATCH on a Run is intentionally not provided. Run fields are either frozen (assignment
config — immutable by construction) or owned on the Experiment (measurement config). The Run is
a record, not a mutable entity.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md](../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
