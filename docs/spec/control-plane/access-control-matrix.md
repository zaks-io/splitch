# Access control matrix: scopes, control-plane token, trusted IdPs, Worker split

The control-plane access token shape and claims, the `app:{app_id}:{role}` scope format, the
trusted-IdP allow-list table, the auth-issuer vs control-plane Worker responsibility split, and revocation.

For how a principal authenticates (the three doors and claim ceremony), see [auth-doors.md](auth-doors.md).

## Control-plane access token

Short-lived bearer token (JWT, default TTL 1h) issued by `/oauth2/token`.

**Claims:**
```
{
  sub: string,             // WorkOS user_id
  iss: string,             // auth-issuer origin
  aud: string,             // control-plane Worker origin
  exp: number,             // unix timestamp
  iat: number,
  scopes: string[],        // e.g. ["app:app_abc123:admin"]
  auth_door: string        // "id_jag" | "anonymous" | "device_flow"  (audit only, not authz)
}
```

**Scope format:** `app:{app_id}:{role}` where role is `owner`, `admin`, or `member`.
A token may carry multiple App scopes (e.g. user is admin on two Apps). Org-level operations require
`org:{org_id}:owner` or `org:{org_id}:admin`.

**Token validation on the control-plane Worker:**
1. Verify JWT signature (JWKS from auth-issuer `/.well-known/oauth-authorization-server`)
2. Assert `aud` matches control-plane Worker origin
3. Assert `exp` not passed
4. Extract `scopes`; match against required scope for the requested operation
5. Extract `sub` as `user_id` for audit logging

## Trusted IdP allow-list

### D1: `trusted_idps` table

| column       | type    | required | meaning                                                        |
|--------------|---------|----------|----------------------------------------------------------------|
| `idp_id`     | TEXT PK | yes      | Splitch-generated identifier                                   |
| `issuer`     | TEXT    | yes      | JWT `iss` value; must be unique                                |
| `jwks_uri`   | TEXT    | yes      | URL to fetch JWKS for signature verification                   |
| `client_ids` | TEXT    | yes      | JSON array of expected `aud` values (client IDs for this IdP)  |
| `enabled`    | INTEGER | yes      | 0 \| 1; disabled IdPs are rejected, not silently skipped       |
| `created_at` | TEXT    | yes      | ISO 8601                                                       |

**Seed rows:** Anthropic, OpenAI, Cursor.

**Who can CRUD:** Org `owner` role only. CRUD is an Org-level operation (not App-level). An org owner
can add/remove trusted IdPs for their Organization. Global (cross-Org) IdP config is splitch-internal
only (seeded at deploy; not user-facing in v1).

**Failure contract:** Unknown `iss` → 401 `unknown_issuer`. Never silently trusted. Never falls through.

## Auth-issuer Worker vs control-plane Worker split

(resolves fused-responsibility seam finding)

**Auth-issuer Worker** owns (minimal surface, stable `aud`, isolated for security review):
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`
- `POST /agent/identity` (all three door entry points)
- `POST /agent/identity/claim`
- `GET /claim` (human claim UI redirect)
- `POST /oauth2/token`
- `POST /oauth2/revoke` (RFC 7009)
- `POST /agent/event/notify` (SET receiver)
- Anon provisional Org+App create (initial create only, through D1 seam)

**Control-plane Worker** owns all other mutations and reads:
- Org CRUD (rename, billing, member management, SSO config) — auth-issuer creates on anon register;
  control-plane manages everything after
- App CRUD
- Flag, Variant, Targeting Rule CRUD
- Experiment, Run CRUD and lifecycle operations
- Segment, Metric CRUD
- SDK credential (Client Key, API Key) management
- Analytics proxy endpoints (injects app_id from auth context into Tinybird queries)
- Test-evaluation endpoint
- `GET /.well-known/openapi.json` (generated OpenAPI, unauthenticated)

## Revocation

- `/oauth2/revoke` (RFC 7009): revokes a control-plane token or refresh token
- `POST /agent/event/notify`: receives provider-signed SET (Security Event Token) for session revocation
- Killing the WorkOS user session revokes agent reach (agent is that user)

## Sources

- [../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md](../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md)
- [../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md](../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
