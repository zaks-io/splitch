# Control-plane endpoints: Organization and App

Request/response shapes for the Organization and App resource groups on the control-plane Worker.

All endpoints live on the **control-plane Worker** and require a control-plane bearer token unless
noted. All requests/responses are `Content-Type: application/json`. Error shape, pagination, and the
shared conventions are described in [control-plane-endpoint-inventory.md](control-plane-endpoint-inventory.md).

## Organization endpoints

### `GET /orgs/{org_id}`
Returns: `{ org_id, name, plan, sso_enabled, is_provisional, demo_expires_at?, created_at }`
Auth: any member of the Org.

### `PATCH /orgs/{org_id}`
Body: `{ name?: string, plan?: string }` (billing plan changes gated by Stripe seam in future)
Returns: updated Org object.
Auth: Org `owner`.

### `GET /orgs/{org_id}/members`
Returns: `{ items: [{ user_id, email, role, created_at }], total, limit, offset }`
Auth: Org `owner` or `admin`.

### `POST /orgs/{org_id}/members`
Body: `{ user_id: string, role: "owner" | "admin" | "member" }`
Returns: `{ user_id, role, created_at }`
Auth: Org `owner` or `admin`.

### `PATCH /orgs/{org_id}/members/{user_id}`
Body: `{ role: "owner" | "admin" | "member" }`
Auth: Org `owner`.

### `DELETE /orgs/{org_id}/members/{user_id}`
Auth: Org `owner`. Cannot remove yourself if last owner.

## App endpoints

### `GET /orgs/{org_id}/apps`
Returns: list of Apps for the Org.
Auth: Org member (any role).

### `POST /orgs/{org_id}/apps`
Body: `{ name: string }`
Returns: `{ app_id, org_id, name, created_at }`
Auth: Org `owner` or `admin`.

### `GET /apps/{app_id}`
Returns: `{ app_id, org_id, name, created_at, updated_at }`
Auth: App member.

### `PATCH /apps/{app_id}`
Body: `{ name?: string }`
Auth: App `owner` or `admin`.

### `DELETE /apps/{app_id}`
Blocked if any Experiment has `status = running`. Returns `EXPERIMENT_RUNNING` error code.
Auth: App `owner`.

## Sources

- [../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md](../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md)
- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
