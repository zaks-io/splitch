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

Returns: `{ items: [{ user_id, email: string | null, role, created_at }], total, limit, offset }`
Auth: Org `owner` or `admin`.
`email` is resolved from WorkOS at read time or from the session identity cache; it is not stored in D1.
`email: null` means the member has not signed in yet. The membership remains in the roster.

### `POST /orgs/{org_id}/members`

Body: `{ user_id: string, role: "owner" | "admin" | "member" }`
Returns: `{ user_id, role, created_at }`
Auth: Org `owner` or `admin`.
An existing membership returns `409 MEMBERSHIP_CONFLICT` with `details.existingRole`; add never
changes an existing role.

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

`slug` is the App's URL segment. It is unique within the Organization; a collision returns
`409 SLUG_CONFLICT` with `details: { resourceType: "app", conflictingSlug, recommendedAction:
"CHOOSE_DIFFERENT_SLUG" }`. It is never silently deduplicated, and changing it moves every URL for
the App, so the surface that offers it says so.

### `GET /apps/{app_id}/members`

Returns: `{ items: [{ app_id, user_id, email, role, created_at }] }`
Auth: App member (any role) — the App role matrix grants "view config" to every role.
`email` is resolved from the session identity cache, exactly as the Org member list resolves it. A
member who has been granted access but has not signed in yet has no cached profile, so `email` is
`null` rather than a placeholder (ADR-0036).

### `POST /apps/{app_id}/members`

Body: `{ user_id: string, role: "owner" | "admin" | "member" }`
Returns: the App member envelope.
Auth: App `owner` or `admin`. Only an `owner` may grant `owner`.
The user must already be a member of the App's Organization; otherwise `USER_NOT_FOUND`. App
membership is a grant WITHIN an Organization, never a way into one.

### `PATCH /apps/{app_id}/members/{user_id}`

Body: `{ role: "owner" | "admin" | "member" }`
Auth: App `owner`. Demoting the last `owner` returns `LAST_OWNER_REQUIRED` with
`details: { appId }`.

### `DELETE /apps/{app_id}/members/{user_id}`

Auth: App `owner`. Removing the last `owner` returns `LAST_OWNER_REQUIRED` with
`details: { appId }`.

### `DELETE /apps/{app_id}`

Blocked if any Experiment has `status = running` in any Environment. Returns `EXPERIMENT_RUNNING`.
Also blocked with `RESOURCE_NOT_EMPTY` while non-cascaded child resources remain, including Flags,
Segments, Metrics, privacy rows, and non-archived Experiments. The error's `details.blockers` lists
**every** current blocker group with child IDs and the CLI command that removes each child, using
CLI vocabulary (`flag-config`, not `flag_configs`).

Query flags (mutually exclusive):

- `dryRun=true` — return `{ deleted: false, dryRun: true, blockers }` and mutate nothing.
- `force=true` — cascade non-gated children in dependency order and return a removal manifesto.
  Policy-gated Flag deletes create Approval Requests and stop with
  `{ deleted: false, force: true, removed, pendingApprovals }` (force never auto-resolves Reviews).
  Retry `--force` after Review to finish.

Credentials are revoked and tombstoned before the cascade, then hard-deleted with Environments,
Approval Requests / Reviews, archived Experiments (and their Runs), memberships, and the App row
inside one atomic D1 batch — so a late FK failure cannot remove memberships or credential rows while
leaving the App stranded. A failed delete must leave App membership and credential management intact
(no partial cascade). Auth: App `owner`.
Account-closure privacy deletion is the only exception; see
[endpoints-privacy-data.md](endpoints-privacy-data.md).

## Environment endpoints (App-level resource; ADR-0027)

Environments are children of an App. Each has a key (URL segment), its own credentials, Flag
Configurations, experiment data, and **Environment Policy**.

The Environment response is
`{ id, appId, key, name, policy, createdAt, updatedAt }`. The Client Key response nested by
Environment creation is
`{ keyId, appId, environmentId, keyMaterial, originAllowlist?, isOriginOpen, rateLimitRps, revokedAt?, createdAt }`.

### `GET /apps/{app_id}/envs`

Returns: `{ items: Environment[], readLimit, readTruncated, cursor }`, where `cursor` is
`string | null`.
Auth: App member.

### `POST /apps/{app_id}/envs`

Body: `{ key: string, name?: string, policy?: EnvironmentPolicy }` (key unique within App). New keys
are 2–63 lowercase alphanumerics separated by single hyphens; `_` is not accepted. Existing rows may
retain older key shapes so selector resolution remains backward-compatible.
Returns: `{ ...Environment, clientKey: ClientKey }`, with the default Policy if none was supplied
(dev-style all-`allow`) and the public Client Key auto-provisioned for it. A caller can point an SDK
at the Environment without a second call. Provisioning failure rolls the Environment back; there is
no success response without `clientKey`. No API Key material rides this response.
Auth: App `owner` or `admin`.

### `GET /apps/{app_id}/envs/{environment_id}`

Returns: `Environment`.

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
Returns: `{ deleted: true }`.
Auth: App `owner`.

## Sources

- [../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md](../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md](../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md)
- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [endpoints-privacy-data.md](endpoints-privacy-data.md)
