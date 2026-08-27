# Control-plane endpoints: SDK credentials

Request/response shapes for Client Key and API Key management on the Control Plane API Worker.

All endpoints live on the **Control Plane API Worker** and require a control-plane bearer token. All
requests/responses are `Content-Type: application/json`. Error shape, pagination, and the shared
conventions are described in [control-plane-endpoint-inventory.md](control-plane-endpoint-inventory.md).
See [credentials-and-keys.md](credentials-and-keys.md) for the credential model and record shapes.

**Per-Environment (ADR-0027).** Both keys are scoped to one Environment, so all credential endpoints
live under `/apps/{app_id}/envs/{environment_id}/…`. A prod Client/API Key reaches prod config only;
keys never span Environments. `environment_id` is the canonical ID in the path.

## Auto-provisioning

Exactly one Client Key is **auto-created when an Environment is created** — there is no separate
Client-Key create endpoint and `GET …/client-key` never 404s for a live Environment. The
auto-provisioned key starts `origin_allowlist = null` (open to all origins, immediately usable),
loudly flagged for lockdown. See
[credentials-and-keys.md](credentials-and-keys.md) for the open-state default and its rationale.
App creation provisions two Environments (see
[endpoints-org-app.md](endpoints-org-app.md)); each gets its own auto-provisioned Client Key.

API Keys are **not** auto-provisioned — they are secret and minted on demand via `POST …/api-keys`.

## SDK credential endpoints

### `GET /apps/{app_id}/envs/{environment_id}/client-key`

Returns: `{ key_id, key_material, origin_allowlist, is_origin_open, created_at, revoked_at? }`
`key_material` is the public value; safely returned. `is_origin_open` is `true` when
`origin_allowlist = null` (open to all origins) — the skins surface it as a loud warning with a
"lock to origins" action.

### `PATCH /apps/{app_id}/envs/{environment_id}/client-key`

Body: `{ origin_allowlist?: string[] | null, rate_limit_rps?: 1 | 2 | 3 | 4 | 5 | 6 | 10 | 12 | 15 | 20 | 25 | 30 | 50 | 60 | 75 | 100 }`
Returns: updated Client Key record. Zero, negative, fractional, and non-exact integers are
`VALIDATION_ERROR` before any D1 or KV mutation.

### `POST /apps/{app_id}/envs/{environment_id}/client-key/revoke`

Revokes current Client Key, creates a replacement.
Returns: `{ new_key: { key_id, key_material }, revoked_key_id: string }`

### `POST /apps/{app_id}/envs/{environment_id}/api-keys`

Creates a new API Key. The raw secret is returned **once only**.
Returns: `{ key_id, secret: string, scopes, created_at }` — the `secret` field is omitted on all future reads.

### `GET /apps/{app_id}/envs/{environment_id}/api-keys`

Returns list of API Key metadata (no secrets): `{ key_id, scopes, created_at, revoked_at? }`

### `POST /apps/{app_id}/envs/{environment_id}/api-keys/{key_id}/revoke`

Body: `{}`
Returns: `{ key_id, revoked_at }`

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
