# Control-plane endpoints: SDK credentials

Request/response shapes for Client Key and API Key management on the control-plane Worker.

All endpoints live on the **control-plane Worker** and require a control-plane bearer token. All
requests/responses are `Content-Type: application/json`. Error shape, pagination, and the shared
conventions are described in [control-plane-endpoint-inventory.md](control-plane-endpoint-inventory.md).
See [credentials-and-keys.md](credentials-and-keys.md) for the credential model and record shapes.

## SDK credential endpoints

### `GET /apps/{app_id}/client-key`
Returns: `{ key_id, key_material, origin_allowlist, created_at, revoked_at? }`
`key_material` is the public value; safely returned.

### `PATCH /apps/{app_id}/client-key`
Body: `{ origin_allowlist?: string[] | null, rate_limit_rps?: number }`
Returns: updated Client Key record.

### `POST /apps/{app_id}/client-key/revoke`
Revokes current Client Key, creates a replacement.
Returns: `{ new_key: { key_id, key_material }, revoked_key_id: string }`

### `POST /apps/{app_id}/api-keys`
Creates a new API Key. The raw secret is returned **once only**.
Returns: `{ key_id, secret: string, scopes, created_at }` — the `secret` field is omitted on all future reads.

### `GET /apps/{app_id}/api-keys`
Returns list of API Key metadata (no secrets): `{ key_id, scopes, created_at, revoked_at? }`

### `POST /apps/{app_id}/api-keys/{key_id}/revoke`
Body: `{}`
Returns: `{ key_id, revoked_at }`

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
