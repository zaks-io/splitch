# Control-plane endpoints: Metric

Request/response shapes for the Metric resource group (binomial, count, revenue, ratio, guardrail).

All endpoints live on the **Control Plane API Worker** and require a control-plane bearer token. All
requests/responses are `Content-Type: application/json`. Error shape, pagination, and the shared
conventions are described in [control-plane-endpoint-inventory.md](control-plane-endpoint-inventory.md).

## Metric endpoints

### `GET /apps/{app_id}/metrics`
### `POST /apps/{app_id}/metrics`
Body:
```
{
  name: string,
  description?: string,
  type: "binomial" | "count" | "revenue" | "ratio",
  event_name: string,                       // event type to match in Tinybird
  aggregation: "count" | "sum" | "mean",
  value_expression?: string,                // for revenue/count: which field to sum
  // ratio only:
  numerator_metric_id?: string,
  denominator_metric_id?: string,
  conversion_window_hours?: number,         // default: inherit from Experiment
  is_guardrail?: boolean,
  guardrail_direction?: "increase" | "decrease",
  guardrail_threshold?: number
}
```
Returns: `{ metric_id, app_id, type, name, created_at }`

### `GET /apps/{app_id}/metrics/{metric_id}`
### `PATCH /apps/{app_id}/metrics/{metric_id}`
Body: all fields except `type` (type is immutable once set).
If the Metric is in a running Run's locked decision family, changes recompute only exploratory
views for that Run; the Worker returns `DECISION_LOCKED` for attempts to mutate the decision-valid
Metric definition in place.
### `DELETE /apps/{app_id}/metrics/{metric_id}`
Blocked if referenced by a running Experiment.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
