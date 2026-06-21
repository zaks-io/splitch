# Auth doors: three doors, one principal, claim ceremony

How a principal authenticates: the three authentication doors (ID-JAG, anonymous/pre-claim, device
flow), the claim ceremony, the `interaction_required` error shape, and the provisional demo lifecycle.

For the scopes enumeration, control-plane token shape, trusted-IdP table, and the Worker
responsibility split, see [access-control-matrix.md](access-control-matrix.md).

## One principal, three doors

An agent is never a distinct principal. Every door produces a WorkOS user identity; authorization is
single-sourced on D1 membership. Which door was used is audit-only and never branches an authz decision.

```
Door A: ID-JAG   ──┐
Door B: Anonymous ─┼──► /oauth2/token ──► control-plane access token ──► D1 membership check
Door C: Device flow┘
```

## Door A: ID-JAG (agent-IdP-verified)

**Endpoint:** `POST /agent/identity` on the auth-issuer Worker

**Request body:**
```
{
  id_jag: string,        // signed JWT from the agent's IdP
  requested_scopes?: string[]
}
```

**Validation steps (all must pass; fail loud on any failure):**
1. Decode JWT header, extract `iss` (issuer)
2. Look up `iss` in `trusted_idps` D1 table; reject with 401 if not found
3. Fetch JWKS from `trusted_idps.jwks_uri`; verify JWT signature
4. Assert `aud` matches splitch's auth-issuer origin
5. Assert `exp` not passed; assert `auth_time` freshness (default: within 5 min)
6. Assert `email_verified = true` (or `phone_verified = true`)
7. Check `jti` replay cache (KV key `jti:{jti}`, TTL = exp - now); reject if seen
8. Resolve WorkOS user by `email`; create in WorkOS if first-seen. D1 stores membership references only.
9. Return: `{ identity_assertion: string, user_id: string }`

**Follow-up exchange at `/oauth2/token`:** presents `identity_assertion`, receives short-lived
control-plane access token. No refresh token on ID-JAG path.

## Door B: Anonymous / pre-claim

**Endpoint:** `POST /agent/identity` with no `id_jag` field (anonymous body)

**Flow:**
1. Rate-limit per source IP (Cloudflare WAF; default: 10 provisional creates per IP per hour)
2. Create WorkOS user (unverified email placeholder)
3. Create provisional Org: `is_provisional = 1`, `demo_expires_at = now + 24h`
4. Create provisional App under the Org (with a default Environment; Environment is per-App, ADR-0027)
5. Issue `identity_assertion` scoped to `pre_claim_scopes = ["app:{app_id}:member"]`
6. Return: `{ identity_assertion, user_id, org_id, app_id, demo_expires_at }`

### Claim ceremony

**Endpoint:** `POST /agent/identity/claim` on the auth-issuer Worker (also `POST /claim` for human UI)

**Request body:**
```
{
  identity_assertion: string,   // the provisional assertion
  otp: string,                  // one-time password delivered to the user's email
  idempotency_key: string       // caller-supplied; prevents double-claim on retry
}
```

**Claim steps:**
1. Validate `identity_assertion`; assert provisional
2. Verify `otp` against D1 OTP record (TTL 10 min); check `idempotency_key` to skip if already processed
3. If `email` maps to an existing real user → return `interaction_required` (see below)
4. If no collision: update WorkOS user email to verified; clear `is_provisional`; clear `demo_expires_at`
5. Upgrade scopes to full `app:{app_id}:{role}` in issued token
6. Return: `{ access_token, user_id, org_id, app_id }`

### `interaction_required` error response

Returned when the claiming email maps to an existing verified user (account-takeover prevention).

```
{
  error: "interaction_required",
  error_description: string,
  consent_url: string,     // URL the real user must visit to approve linking
  consent_expires_at: string  // ISO 8601; consent link valid for 15 min
}
```

The agent must surface `consent_url` to the human. The human authenticates at that URL, approves the
link, and splitch merges the identities. The agent then retries the claim.

### Provisional demo reaping

Cron Trigger Worker runs daily. Query:
`SELECT org_id FROM organizations WHERE is_provisional = 1 AND demo_expires_at < now()`

For each row: delete Apps under the Org (and their Environments), delete Org memberships, delete the
Org — all through the D1 data-access seam (app_id scoping enforced, never bypassed).

## Door C: Device flow (human at terminal / agent no-IdP fallback)

WorkOS device flow. Auth-issuer Worker exposes the standard `device_authorization` and `token` endpoints
as thin proxies to WorkOS. The CLI stores the resulting **refresh token** in keychain or `~/.splitch/credentials.json` (mode 0600). The MCP server does not touch disk; it holds its token in the transport session.

## Sources

- [../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md](../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md)
- [../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md](../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
