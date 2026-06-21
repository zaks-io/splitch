# Control-plane endpoints: Flag, Variant, Targeting Rule, Segment

Request/response shapes for the Flag (with Variants and Targeting Rules) and Segment resource groups.

All endpoints live on the **control-plane Worker** and require a control-plane bearer token. All
requests/responses are `Content-Type: application/json`. Error shape, pagination, and the shared
conventions are described in [control-plane-endpoint-inventory.md](control-plane-endpoint-inventory.md).

## Flag endpoints

### `GET /apps/{app_id}/flags`
Returns: list of Flags.

### `POST /apps/{app_id}/flags`
Body:
```
{
  flag_key: string,          // unique within App; snake_case recommended
  name: string,
  description?: string,
  enabled: boolean,          // defaults true
  variants: [
    { name: string, value: boolean|string|number|object, is_default: boolean }
  ]
}
```
Returns: `{ flag_id, app_id, flag_key, name, enabled, variants, created_at }`
Invariant: exactly one Variant has `is_default: true`.

### `GET /apps/{app_id}/flags/{flag_id}`
Returns: full Flag including Variants and Targeting Rules.

### `PATCH /apps/{app_id}/flags/{flag_id}`
Body: `{ name?, description?, enabled? }`. Does NOT accept `variants` (separate endpoint).
Returns: updated Flag.

### `POST /apps/{app_id}/flags/{flag_id}/variants`
Body: `{ name: string, value: boolean|string|number|object, is_default?: boolean }`
Returns: updated Flag with new Variant.

### `DELETE /apps/{app_id}/flags/{flag_id}/variants/{variant_name}`
Blocked if Variant is referenced in a running Experiment.

### `PUT /apps/{app_id}/flags/{flag_id}/targeting-rules`
Full replace of the Targeting Rule list (ordered; first match wins). Body: `TargetingRule[]`.
Returns: updated Flag.

### `DELETE /apps/{app_id}/flags/{flag_id}`
Blocked if referenced by a running Experiment.

## Segment endpoints

### `GET /apps/{app_id}/segments`
### `POST /apps/{app_id}/segments`
Body: `{ name: string, description?: string, conditions: Condition[] }`
Returns: `{ segment_id, app_id, name, conditions, created_at }`

### `GET /apps/{app_id}/segments/{segment_id}`
### `PATCH /apps/{app_id}/segments/{segment_id}`
Body: `{ name?, description?, conditions? }`
### `DELETE /apps/{app_id}/segments/{segment_id}`
Blocked if referenced by a running Experiment.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
