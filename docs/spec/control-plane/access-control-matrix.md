# Access control matrix: scopes, resource access tokens, trusted IdPs, Worker split

The resource access-token shape and claims, the `app:{app_id}:{role}` scope format, the
trusted-IdP allow-list table, the Worker responsibility split, and revocation.

For how a principal authenticates (the three identity doors, claim ceremony, and shared-preview
`client_credentials` smoke grant), see [auth-doors.md](auth-doors.md).

## Resource access token

Short-lived bearer token (JWT, default TTL 1h) issued by `/oauth2/token`.

Every runtime target uses one trust contract: Auth API signs access tokens with RS256 and serves the
matching public key at `/.well-known/jwks.json`. Hosted targets read the RSA private JWK from
`ACCESS_TOKEN_SECRET` and fail closed when it is missing or invalid. Local runtime generates one
ephemeral RSA private JWK and exercises the same Auth API JWKS verification path end to end. HS256
access tokens exist only in isolated unit-test fixtures; they are not the local Worker contract.

**Claims:**

```
{
  typ: "access_token",
  sub: string,             // WorkOS user_id
  iss: string,             // auth-api origin
  aud: string,             // exact selected protected resource
  exp: number,             // unix timestamp
  iat: number,
  scopes: string[],        // e.g. ["app:app_abc123:admin"]
  auth_door: string,       // "id_jag" | "anonymous" | "device_flow" | "client_credentials"
  authorization?: "membership-wide-read"
}
```

`aud` is either the Control Plane protected-resource origin or the exact MCP resource advertised for
the challenged endpoint (the MCP origin or its `/mcp` URL). A token for one is rejected by every
other resource. `client_credentials` is reserved for the shared-preview smoke client. It mints a
short-lived resource-bound token for the configured seeded smoke user and scopes; it is not a general
user or agent onboarding path.

`authorization: "membership-wide-read"` is a Control Plane-only, read-only grant. Its token must
carry an explicitly empty `scopes` array and cannot be combined with an App or Organization
selector. The claim carries no membership rows. On `GET`, the Control Plane resolves the principal's
complete Organization and App membership set through the `memberships:{user_id}` SESSION_STORE
cache. A miss loads the complete set from D1 and writes it with a 60-second TTL. The registrar
accepts the grant only for `GET`, applies path co-scope against that set, and rejects every other
method before the handler runs. Session revocation uses the same principal-keyed check as
selector-bound tokens. The Auth API refuses this authorization for the MCP audience.

**Scope format:** `app:{app_id}:{role}` where role is `owner`, `admin`, or `member`.
A token may carry multiple App scopes (e.g. user is admin on two Apps). Org-level operations require
`org:{org_id}:owner` or `org:{org_id}:admin`.

**Principal-keyed discovery:** `GET /orgs` is the one collection whose tenant key is the principal
itself rather than a path id. It answers "which Organizations am I a member of?" from live D1
membership, because the token a cold-start device login mints carries no scopes — filtering by them
would return an empty list and deadlock the first step of every agent journey.

The scope filter is dropped for the `device_flow` door and for membership-wide authority. Device
flow can rebind to any current Organization; the structural grant names the complete cached
membership reach regardless of its auth door. Other refresh-less access tokens remain narrowed by
scopes. Every Organization route with an `:orgId` path performs an uncached D1 Organization
membership check in its handler. `GET /orgs` and Organization-scoped App listing read D1 directly.

**Token validation at the selected protected resource:**

1. Verify JWT signature as RS256 against the configured Auth API `AUTH_JWKS_URI`
2. Assert `iss` matches the Auth API origin and `typ` is `access_token`
3. Assert `aud` exactly matches the protected resource handling the request
4. Assert `exp` not passed
5. Session-validation hot read: a revoked session is `CREDENTIAL_REVOKED`
6. Resolve every Organization and App membership axis the token carries through
   `memberships:{user_id}`. Cache misses read the complete set from D1. Only `GET` and `HEAD`
   requests fill the cache; mutating requests read D1 on a miss without filling. Membership
   mutations delete the affected key before the D1 write and again after commit. A cache entry
   expires after 60 seconds even if either delete is not yet visible at another Cloudflare location.
   This runs on the public bearer path and again on the MCP Control Plane door after delegation is
   verified. Tokens whose authority does not derive from membership keep their existing path.
7. For `authorization: "membership-wide-read"`, require an empty `scopes` array,
   resolve the complete membership set through the same cache, refuse non-`GET` methods, and
   co-scope any Organization or App path against that set. Internal delegation carries the grant
   and resolved set, binds only the already-authorized path axes, and reruns Organization/App
   co-scope in the owner Worker.
8. Otherwise, extract `scopes` and match against the required scope for the
   requested operation.
9. Extract `sub` as `user_id` for audit logging

The membership cache is a scope-resolution optimization, not the final authorization decision.
Every Control Plane `GET` route whose canonical path contains `:appId` performs an uncached
`getAppMembership` read before its handler can return App data. The hand-mounted live-update route
performs the same check before reading the Environment or opening the stream. App and Organization
mutation handlers perform their role-specific uncached D1 checks. Organization-scoped reads perform
an uncached `getOrgMembership` check, while `GET /orgs` reads the principal's memberships directly
from D1. These live handler checks make removal effective on the next request; the 60-second TTL
only bounds stale scope resolution and does not authorize an App-scoped response.

## Trusted IdP allow-list

### D1: `trusted_idps` table

| column       | type    | required | meaning                                                       |
| ------------ | ------- | -------- | ------------------------------------------------------------- |
| `idp_id`     | TEXT PK | yes      | Splitch-generated identifier                                  |
| `issuer`     | TEXT    | yes      | JWT `iss` value; must be unique                               |
| `jwks_uri`   | TEXT    | yes      | URL to fetch JWKS for signature verification                  |
| `client_ids` | TEXT    | yes      | JSON array of expected `aud` values (client IDs for this IdP) |
| `enabled`    | INTEGER | yes      | 0 \| 1; disabled IdPs are rejected, not silently skipped      |
| `created_at` | TEXT    | yes      | ISO 8601                                                      |

**Seed rows:** Anthropic, OpenAI, Cursor.

**Who can CRUD:** Org `owner` role only. CRUD is an Org-level operation (not App-level). An org owner
can add/remove trusted IdPs for their Organization. Global (cross-Org) IdP config is splitch-internal
only (seeded at deploy; not user-facing).

**Failure contract:** Unknown `iss` → 401 `unknown_issuer`. Never silently trusted. Never falls through.

## Worker responsibility split

(resolves fused-responsibility seam findings)

**Auth-issuer Worker** owns (minimal surface, stable `aud`, isolated for security review):

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`
- `POST /agent/identity` (ID-JAG and anonymous door entry points)
- `POST /agent/identity/claim`
- `GET /claim` (human claim UI redirect)
- `POST /oauth2/device_authorization`
- `POST /oauth2/token`
- `POST /oauth2/revoke` (RFC 7009)
- `POST /agent/event/notify` (SET receiver)
- Anon provisional Org+App create (initial create only, through D1 seam)

**Control Plane API Worker** owns authenticated management mutations and D1/KV-backed reads:

- Org CRUD (rename, billing, member management, SSO config) — auth-api creates on anon register;
  control-plane manages everything after
- App CRUD; Environment CRUD (per App, ADR-0027)
- Flag **definition** CRUD (App-level), Flag **Configuration** + Promotion across Environments (per-Env, ADR-0028)
- Environment Policy edits (per-change-type confirm gates, ADR-0029)
- Variant, Targeting Rule CRUD
- Experiment, Run CRUD and lifecycle operations (Start, End, Conclude; per-Environment)
- Segment, Metric CRUD
- SDK credential (Client Key, API Key) management (per-Environment)
- Privacy request intake, export jobs, deletion jobs, and Entity tombstones
- `GET /.well-known/openapi.json` (generated OpenAPI, unauthenticated)

**MCP Worker** owns the remote MCP protocol surface:

- MCP OAuth PRM/auth.md handshake
- RS256/JWKS verification of the exact MCP-resource bearer; the client bearer terminates here and is
  never forwarded to a downstream Worker
- Tool registry and schema derivation
- Calls the Control Plane SDK; no direct D1/KV/Tinybird bindings, no Analysis or Evaluation
  binding, and no domain invariants

Each MCP tool call receives a separate 30-second, one-use delegated credential over a named Worker
service-binding entrypoint. MCP has exactly one downstream, the Control Plane, so it holds exactly
one least-privilege credential: `MCP_CONTROL_PLANE_DELEGATION_SECRET`. MCP and the Control Plane
receive the same named value. Analysis and Evaluation are reached only through the Control Plane's
registered delegation routes, after its membership, Environment scope, and Policy gates, so MCP
holds no Analysis or Evaluation credential. Hosted workflows validate this contract before
deploying, and missing secrets or replay bindings fail closed.

**Evaluation Worker** owns resolution:

- Public SDK evaluate and peek endpoints (Client Key or API Key for evaluate; peek is API Key only,
  ADR-0034). For delegated `POST /api/sdk/events`, Evaluation authenticates the data-plane
  credential and enforces the Client Key origin allow-list at the public edge, then forwards caller
  identity to Event Ingest over the service binding.
- Control-plane dry-run test-evaluation using the control-plane bearer token
- Provider and Assignment Store read orchestration
- No config writes, no analytics reads, and no direct result calculation

**Event Ingest Worker** owns append-only intake:

- Delegated public SDK Metric Event `track` (`POST /api/sdk/events`): Event Ingest owns schema,
  rate, identity, and storage validation and persistence after Evaluation forwards the authenticated
  caller identity over the service binding
- Public SDK Web Event `web.track` (`POST /api/sdk/web-events`) under Client Key or API Key
- Evaluation usage, Exposure, Activation, Metric Event, and Web Event validation
- Per-scope Admission Gate Durable Objects, durable claim/outbox shards, datasource queues, write-ahead
  Tinybird attempt/reconciliation state, DLQs, and microbatch delivery
- No Variant resolution, no Experiment result calculation, and no control-plane CRUD

**Analysis Worker** owns result reads:

- Experiment and Web Analytics proxy endpoints
- Tinybird-backed Web Session, Web Event, SRM, Metric, and statistical result reads
- App `owner`, `admin`, and `member` roles may read Web Analytics under the existing **View
  config/results** permission
- `app_id` and `environment_id` injection from auth/path context
- No SDK evaluate, no event ingest, and no config mutation

## Revocation

- `/oauth2/revoke` (RFC 7009): revokes a resource access token or refresh token. Requires a
  first-party `client_id`, like every other OAuth endpoint: revocation destroys authority, so
  it must not be the one door that accepts an unidentified caller
- `POST /agent/event/notify`: receives provider-signed SET (Security Event Token) for session revocation
- Killing the WorkOS user session revokes agent reach (agent is that user)

## Sources

- [../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md](../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md)
- [../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md](../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md](../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md)
- [../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md](../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md)
- [../platform/privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md)
