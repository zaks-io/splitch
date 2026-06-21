# Control-plane endpoints: Organization and App

Request/response shapes for the Organization and App resource groups on the Control Plane API Worker.

All endpoints live on the **Control Plane API Worker** and require a control-plane bearer token unless
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
`email` is resolved from WorkOS at read time or from the session identity cache; it is not stored in D1.

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
Body: `{ name: string, slug?: string }` (slug auto-derived from name if omitted; unique within Org)
Returns: `{ app_id, org_id, name, slug, created_at }`
Auth: Org `owner` or `admin`.
On create, a `prod` Environment is provisioned by default; more can be added (see Environment endpoints).

### `GET /apps/{app_id}`
Returns: `{ app_id, org_id, name, slug, created_at, updated_at }`
Auth: App member.

### `PATCH /apps/{app_id}`
Body: `{ name?: string, slug?: string }`
Auth: App `owner` or `admin`.

### `DELETE /apps/{app_id}`
Blocked if any Experiment has `status = running` in any Environment. Returns `EXPERIMENT_RUNNING`.
Auth: App `owner`.
Account-closure privacy deletion is the only exception; see
[endpoints-privacy-data.md](endpoints-privacy-data.md).

## Environment endpoints (App-level resource; ADR-0027)

Environments are children of an App. Each has a slug (URL segment), its own credentials, Flag
Configurations, experiment data, and **Environment Policy**.

### `GET /apps/{app_id}/envs`
Returns: list of Environments `{ environment_id, app_id, slug, name, created_at }`.
Auth: App member.

### `POST /apps/{app_id}/envs`
Body: `{ slug: string, name?: string, policy?: EnvironmentPolicy }` (slug unique within App)
Returns: the new Environment, with its default Policy if none supplied (dev-style all-`allow`).
Auth: App `owner` or `admin`.

### `GET /apps/{app_id}/envs/{environment_id}`
Returns: `{ environment_id, app_id, slug, name, policy, created_at }`.

### `PATCH /apps/{app_id}/envs/{environment_id}`
Body: `{ name?: string, policy?: EnvironmentPolicy }`.
`EnvironmentPolicy` maps each change type to a level: `{ variant_availability, targeting_rollout_value,
enabled_state, start_experiment_run: "allow" | "confirm" }` (`approve` reserved, future). Changing the
kill-switch-off behavior is not configurable (always allowed). See ADR-0029.
Returns: updated Environment.
Auth: App `owner` or `admin`.

### `DELETE /apps/{app_id}/envs/{environment_id}`
Blocked if any Experiment is `running` in this Environment, or if it is the last Environment.
Auth: App `owner`.

## Sources

- [../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md](../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md](../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md)
- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [endpoints-privacy-data.md](endpoints-privacy-data.md)
