# Control-plane endpoints: Organization and App

Request/response shapes for the Organization and App resource groups on the Control Plane API Worker.

All endpoints live on the **Control Plane API Worker** and require a control-plane bearer token unless
noted. All requests/responses are `Content-Type: application/json`. Error shape, pagination, and the
shared conventions are described in [control-plane-endpoint-inventory.md](control-plane-endpoint-inventory.md).

## Organization endpoints

The Organization envelope is `{ id, name, slug, plan, created_at, updated_at }` for every endpoint
below. It is a whitelist: `sso_enabled`, the Stripe ids, the claim-ceremony columns, and the
provisional-reaper columns (`is_provisional`, `demo_expires_at`) stay in D1 and never reach the wire.

### `POST /orgs`

Body: `{ name: string, slug?: string }`
Returns: `201` + the Organization envelope.
Auth: any authenticated **non-provisional** principal. The caller becomes the Org `owner`, written in
the same transaction as the Org itself — an Organization with no owner is unreachable, because every
other Org route authorizes through live membership.

`slug` is derived from `name` when omitted. It is unique across all Organizations; a collision returns
`409 SLUG_CONFLICT` with `details.recommendedAction: "CHOOSE_DIFFERENT_SLUG"`.

A **provisional** (anonymous, unclaimed) principal is rejected with `403 FORBIDDEN`. It reached the
control plane through an unauthenticated `POST /register`, so allowing it here would make unbounded
Organization creation an unauthenticated operation. Its one demo Organization is the limit until the
claim ceremony (`POST /api/auth/claim/start`) yields an identified principal.

### `GET /orgs/{org_id}`

Returns: the Organization envelope.
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
Returns: `{ app, environments, client_keys }` with the two default Environments and their public
Client Keys.
Auth: Org `owner` or `admin`.
On create, **two Environments are provisioned by default: `dev` and `prod`**. `dev` ships with an
all-`allow` Environment Policy (no confirmation gates) so the first flag/experiment lands in a
safe, non-production place by default; `prod` ships with the stricter default Policy. A developer
or agent never has to create an Environment before getting their first value, and the obvious
first move ("try a flag") cannot accidentally target production. More Environments can be added
(see Environment endpoints). This is a DX default, not a constraint — an App may later delete
`dev` (subject to the last-Environment guard).

Each provisioned Environment also gets **one auto-provisioned Client Key** (open-to-all-origins,
loudly flagged for lockdown) so the public SDK is usable with zero extra steps; see
[endpoints-credentials.md](endpoints-credentials.md#auto-provisioning). API Keys are not
auto-provisioned. Any Environment created later (via the Environment endpoints) provisions its
Client Key the same way.

### `GET /apps/{app_id}`

Returns: `{ app_id, org_id, name, slug, created_at, updated_at }`
Auth: App member.

### `GET /apps/{app_id}/attention-rollup`

Returns the minimal Environment-explicit SRM and Guardrail attention contract for the App:
`{ appId, items: [{ environmentId, state: "no_data" | "clear" | "attention", srm, guardrail }] }`.
Only current running Experiments contribute. `no_data` is distinct from a measured `clear` result;
neither state may carry an SRM or Guardrail failure flag. An Environment with any firing SRM or
breached Guardrail is `attention`, with the exact reason boolean set. Analysis read failures return
`SERVICE_UNAVAILABLE` rather than silently clearing attention. SRM attention uses the same predicate
as the Experiment list health signal, so the two surfaces cannot disagree about whether a Run is
firing.

An Environment whose running Experiments have no Analysis results at all is `no_data`. An
Environment that mixes readable and unreadable results reports on the results it has, so a
partially-snapshotted Environment with no firing signal reads `clear` rather than `no_data`. This is
deliberate: `attention` must never be missed, and per-Run detail belongs to the Experiment list, not
to a per-Environment rollup. `no_data` therefore means "nothing measurable here", not "everything
here was measured".

The rollup issues one Analysis read per running Experiment per Environment, bounded to 8 in flight
per request across all Environments. Two budgets are enforced, each before the work it bounds, and
neither truncates, because a truncated rollup would render as `clear` for the Environments it
dropped:

- More than 200 Environments: refused before planning, since planning costs one read per
  Environment. Reported with `runningExperiments: null`, because no plan ran.
- More than 200 planned Analysis reads: refused before any read is issued.

Both refusals are `ATTENTION_FANOUT_LIMIT_EXCEEDED`
(`{ appId, limit, environments, runningExperiments: number | null, recommendedAction:
"READ_PER_ENVIRONMENT" }`) with status `409`. The status
is deliberate and is not retryable: `429`/`503` would promise that waiting helps, and a polling
agent would then retry forever against a condition that only an App-shape change can resolve. The
details name the budget and the observed counts so the caller can see exactly what was exceeded;
the remediation is to read attention per Environment through the Experiment list instead, which is
what `recommendedAction: "READ_PER_ENVIRONMENT"` names for the `recover_from_error` MCP prompt.

Auth: live Organization and App member. The Worker rejects a token bound to another App or stale
membership before any analysis read. Control Panel callers use the configured signed binding-only
`SignedControlPanelEntrypoint`; the browser/session bearer never crosses the binding. The
Control Plane Worker calls Analysis through its binding-only entrypoint with an exact
actor/App/Environment/Experiment/Run service identity.

### `PATCH /apps/{app_id}`

Body: `{ name?: string, slug?: string }`
Auth: App `owner` or `admin`.

### `DELETE /apps/{app_id}`

Blocked if any Experiment has `status = running` in any Environment. Returns `EXPERIMENT_RUNNING`.
Also blocked with `RESOURCE_NOT_EMPTY` while non-credential child resources remain, including
non-archived Experiments. Archived Experiments (and their Runs) are hard-purged as part of App /
Environment teardown once only archived rows remain.
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
`EnvironmentPolicy` maps each change type to a level:
`{ variantAvailability, targetingRolloutValue, enabledState, startExperimentRun: "allow" | "confirm" }`
(`approve` reserved, future). Changing the
kill-switch-off behavior is not configurable (always allowed). See ADR-0029.
Returns: updated Environment.
Auth: App `owner` or `admin`.

### `DELETE /apps/{app_id}/envs/{environment_id}`

Blocked if any Experiment is `running` in this Environment, if it is the last Environment, or if
non-credential child resources remain (non-archived Experiments count; archived Experiments and
their Runs are hard-purged on teardown).
Auth: App `owner`.

## Sources

- [../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md](../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md](../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md)
- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [endpoints-privacy-data.md](endpoints-privacy-data.md)
