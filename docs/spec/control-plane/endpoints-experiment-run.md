# Control-plane endpoints: Experiment and Run

Request/response shapes for the Experiment and Run resource groups, including the draft/publish lifecycle.

All endpoints live on the **control-plane Worker** and require a control-plane bearer token. All
requests/responses are `Content-Type: application/json`. Error shape, pagination, and the shared
conventions are described in [control-plane-endpoint-inventory.md](control-plane-endpoint-inventory.md).

## Experiment endpoints

### `GET /apps/{app_id}/experiments`
### `POST /apps/{app_id}/experiments`
Body (create draft):
```
{
  name: string,
  description?: string,
  hypothesis?: string,
  flag_id: string,
  targeting_key_field: string,       // which attribute is the Targeting Key
  variants: [{ name: string, is_control: boolean }],
  segment_ids?: string[],
  confidence_level?: number           // default 0.95
}
```
Returns: `{ experiment_id, app_id, flag_id, name, status: "draft", variants, created_at }`
Status is always `draft` on creation; no Run yet.

### `GET /apps/{app_id}/experiments/{experiment_id}`
Returns: Experiment including `live_run_id` (null if no running Run), draft allocation, draft targeting.

### `PATCH /apps/{app_id}/experiments/{experiment_id}`
**Draft assignment-config fields** (accumulate on draft, Publish to apply):
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
  metrics?: MetricRef[],
  conversion_window_hours?: number,
  guardrail_config?: GuardrailConfig[]
}
```
**Non-material fields** (apply in place):
```
{ name?, description?, hypothesis?, owner?, tags? }
```
Returns: updated Experiment.

### `POST /apps/{app_id}/experiments/{experiment_id}/publish`
Publishes the draft as a new Run; ends any running Run.
Body: `{}` (no body required)
Returns: `{ experiment_id, run: RunObject, previous_run_id?: string }`
See [run-state-machine.md](run-state-machine.md) for transition details.
Auth: App `owner` or `admin`.

### `DELETE /apps/{app_id}/experiments/{experiment_id}`
Blocked if status is `running`. Soft-deletes; archived experiments and their Runs are retained for
analysis replayability. Hard-delete on explicit archive/purge (future).

## Run endpoints

### `GET /apps/{app_id}/experiments/{experiment_id}/runs`
Returns: list of Runs (all statuses), newest first.

### `GET /apps/{app_id}/experiments/{experiment_id}/runs/{run_id}`
Returns: full Run object (frozen assignment config + measurement config snapshot + status).

### `POST /runs/{run_id}/end`
Ends a running Run. See [run-state-machine.md](run-state-machine.md).
Body: `{ reason?: string }` (optional human-readable note)
Returns: ended Run object.
Auth: App `owner` or `admin`.

**Note:** PATCH on a Run is intentionally not provided. Run fields are either frozen (assignment
config — immutable by construction) or owned on the Experiment (measurement config). The Run is
a record, not a mutable entity.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
