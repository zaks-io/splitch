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
Body: `{ confirm?: boolean, reason?: string }`
`reason` is an optional human note capturing _intent_ for the new Run ("testing higher exposure to
v2"). It is stored as the Run's `start_reason` and surfaced by the Run-history timeline alongside the
**derived** assignment-config diff from the prior Run (the timeline never depends on it being present —
see [../frontend/screen-inventory.md](../frontend/screen-inventory.md)). Symmetric with the optional
`reason` on `/end`.
Returns: `{ experiment_id, run: RunObject, previous_run_id?: string }`
See [run-state-machine.md](run-state-machine.md) for transition details.
Auth: App `owner` or `admin`. **Subject to the Environment Policy** (ADR-0029): if this Environment's
Policy gates "Start an Experiment Run" at `confirm`, the call must carry `confirm: true` in the body
or it is rejected with `409 CONFIRMATION_REQUIRED` before any state change. When the Policy does not
gate this change type, `confirm` is ignored and the body may be omitted entirely. The CLI/MCP
`--confirm` flag derives from this same `confirm` field (see
[../contracts/mcp-tool-derivation.md](../contracts/mcp-tool-derivation.md)).

### `DELETE /apps/{app_id}/envs/{environment_id}/experiments/{experiment_id}`

Blocked if status is `running`. Soft-deletes; archived experiments and their Runs are retained for
analysis replayability. Hard-delete on explicit archive/purge (future).

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
