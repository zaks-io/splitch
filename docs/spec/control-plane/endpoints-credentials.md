# Control-plane endpoints: SDK credentials

Request/response shapes for Client Key and API Key management on the Control Plane API Worker.

All endpoints live on the **Control Plane API Worker** and require a control-plane bearer token. All
requests/responses are `Content-Type: application/json`. Error shape, pagination, and the shared
conventions are described in [control-plane-endpoint-inventory.md](control-plane-endpoint-inventory.md).
See [credentials-and-keys.md](credentials-and-keys.md) for the credential model and record shapes.

**Per-Environment (ADR-0027).** Both keys are scoped to one Environment, so all credential endpoints
live under `/apps/{app_id}/envs/{environment_id}/…`. A prod Client/API Key reaches prod config only;
keys never span Environments. `environment_id` accepts a canonical ID or Environment key in the path.
Every route requires App admin or owner. PAT permission is `write` for `client_key_get`, `read`
for `api_keys_list`, and `credentials` for every other operation. The Temporary Environment
permission fallback applies to the opted-in writes.

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

Operation ID: `client_key_get`.
Returns: `{ keyId, appId, environmentId, keyMaterial, originAllowlist?, isOriginOpen, rateLimitRps, createdAt, revokedAt? }`
`keyMaterial` is the public value; safely returned. `isOriginOpen` is `true` when
`originAllowlist = null` (open to all origins) — the skins surface it as a loud warning with a
"lock to origins" action.

### `PATCH /apps/{app_id}/envs/{environment_id}/client-key`

Operation ID: `client_key_update`.
Body: `{ originAllowlist?: string[] | null, rateLimitRps?: 1 | 2 | 3 | 4 | 5 | 6 | 10 | 12 | 15 | 20 | 25 | 30 | 50 | 60 | 75 | 100 }`
Returns: updated Client Key record. Zero, negative, fractional, and non-exact integers are
`VALIDATION_ERROR` before any D1 or KV mutation.

### `POST /apps/{app_id}/envs/{environment_id}/client-key/revoke`

Revokes current Client Key, creates a replacement.
Operation ID: `client_key_rotate`.
Returns: `{ newKey: { keyId, keyMaterial }, revokedKeyId: string }`

### `POST /apps/{app_id}/envs/{environment_id}/api-keys`

Operation ID: `api_keys_create`. Body: `{ scopes: ApiKeyScope[] }`.
Creates a new API Key. The raw secret is returned **once only**.
Returns: `{ credential: { keyId, appId, environmentId, scopes, createdAt, revokedAt? }, value: string }`.
`value` is the raw secret and is absent on every future read. This operation has no idempotent replay.

### `GET /apps/{app_id}/envs/{environment_id}/api-keys`

Operation ID: `api_keys_list`.
Returns the shared list envelope of API Key metadata (no secrets):
`{ keyId, appId, environmentId, scopes, createdAt, revokedAt? }`.

### `POST /apps/{app_id}/envs/{environment_id}/api-keys/{key_id}/revoke`

Operation ID: `api_keys_revoke`. Body: `{}`.
Returns: `{ keyId, revokedAt }`.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
