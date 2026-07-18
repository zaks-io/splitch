# Auth doors: three identity doors, one principal, claim ceremony

How a principal authenticates: the three identity doors (ID-JAG, anonymous/pre-claim, device flow),
the shared-preview `client_credentials` smoke grant, the claim ceremony, the `interaction_required`
error shape, and the provisional demo lifecycle.

For the scopes enumeration, control-plane token shape, trusted-IdP table, and the Worker
responsibility split, see [access-control-matrix.md](access-control-matrix.md).

## One principal, three identity doors

An agent is never a distinct principal. Every door produces a WorkOS user identity; authorization is
single-sourced on D1 membership. Which door was used is audit-only and never branches an authz decision.
The shared-preview `client_credentials` grant is the one non-interactive exception: it can only mint
a scoped token for the configured seeded smoke WorkOS user, and it exists to exercise hosted Auth API
to Control Plane verification in smoke tests.

```
Door A: ID-JAG   ──┐
Door B: Anonymous ─┼──► /oauth2/token ──► control-plane access token ──► D1 membership check
Door C: Device flow┘

Shared-preview smoke client_credentials ──► /oauth2/token ──► scoped smoke access token
```

## Door A: ID-JAG (agent-IdP-verified)

**Endpoint:** `POST /agent/identity` on the auth-api Worker

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
4. Assert `aud` matches splitch's auth-api origin
5. Assert `exp` not passed; assert `auth_time` freshness (default: within 5 min)
6. Assert `email_verified = true` (step 8 resolves the user by `email`, so
   phone-only verification is not sufficient)
7. Check `jti` replay cache (KV key `jti:{jti}`, TTL = exp - now); reject if seen
8. Resolve WorkOS user by `email`; create in WorkOS if first-seen. D1 stores membership references only.
9. Return: `{ identity_assertion: string, user_id: string }`

**Follow-up exchange at `/oauth2/token`:** presents `identity_assertion`, receives short-lived
control-plane access token. No refresh token on ID-JAG path. Hosted access tokens use the
RS256/JWKS trust contract in [access-control-matrix.md](access-control-matrix.md).

## Door B: Anonymous / pre-claim

**Endpoint:** `POST /agent/identity` with no `id_jag` field (anonymous body)

**Flow:**

0. **Turnstile challenge before any row is created (ADR-0034).** This is a public, unauthenticated
   **write** surface that mints WorkOS users and D1 rows; per-IP rate limiting alone is defeated by IP
   rotation. Verify the Cloudflare Turnstile token server-side (siteverify; single-use; 300s expiry)
   before step 2. Reject on failure — no rows created.
1. Rate-limit per source IP **and a global ceiling** (Cloudflare WAF; default: 10 provisional creates
   per IP per hour, plus a global cap — placeholder **10,000 provisional creates/hour across all IPs** —
   so IP rotation cannot make creation unbounded. The number is set deliberately high for launch and
   tuned down against real traffic; the point is that the ceiling exists, not its exact value.)
2. Create WorkOS user (unverified email placeholder)
3. Create provisional Org: `is_provisional = 1`, `demo_expires_at = now + 24h`
4. Create provisional App under the Org (with a default Environment; Environment is per-App, ADR-0027)
5. Issue `identity_assertion` scoped to `pre_claim_scopes = ["app:{app_id}:member"]`
6. Return: `{ identity_assertion, user_id, org_id, app_id, demo_expires_at }`

### Claim ceremony

**Endpoint:** `POST /agent/identity/claim` on the auth-api Worker (also `POST /claim` for human UI)

**Initiation request:**

```
{
  identity_assertion: string,   // the provisional assertion
  email: string                 // address to verify or link
}
```

**OTP verification request:**

```
{
  identity_assertion: string,
  email: string,
  otp: string,                  // one-time password delivered to the user's email
  idempotency_key: string       // caller-supplied; prevents double-claim on retry
}
```

**Consent verification request:**

```
{
  identity_assertion: string,
  email: string,
  verification_id: string,      // returned with interaction_required
  idempotency_key: string
}
```

**Claim steps:**

1. Validate `identity_assertion`; assert provisional. Initiation first asks WorkOS whether the normalized email already belongs to a verified user. A free address is then assigned to the provisional WorkOS user and the email-verification code is sent; a collision creates only durable verification and consent state and returns `interaction_required` without mutating the provisional user.
2. D1 stores only SHA-256 identifier digests plus bounded TTL, attempt, one-use, consent, and idempotency state. It never stores an OTP or a hosted fixture code.
3. For a free address, WorkOS confirms the OTP. Its result is the email-ownership authority.
4. For an existing verified address, the existing AuthKit principal authenticates at the consent URL. The browser can approve or refuse with POST; no provisional WorkOS user email is changed in this branch.
5. The consent page is a dedicated Control Panel route. Its URL is built from the explicit `CONTROL_PANEL_ORIGIN`, never the Control Plane API origin. Its opaque browser session maps to a server-side WorkOS access JWT; the panel forwards that JWT only server-to-server. Auth API verifies its RS256 signature, configured issuer, `client_id`, expiry, and `sub` against WorkOS JWKS. The panel session is bounded by the JWT expiry. Existing splitch membership is not an authorization input for this route.
6. After WorkOS verification or authenticated consent, one guarded D1 batch first acquires the still-provisional Organization only while the signed provisional User still has the matching Org and App memberships. Every membership mutation, state consumption, and idempotency insert is conditional on that acquisition. Retries after a pre-batch failure are safe.
7. Return: `{ access_token, user_id, org_id, app_id }`.

### Claim-state retention

The daily Control Plane scheduled reaper purges expired claim artifacts in bounded batches of 100
verifications. Consent attempts are deleted before their verification rows, and completed or abandoned
idempotency reservations are retained for their full 24-hour replay window before those verification
rows become eligible. This preserves one-use and replay behavior while keeping Door B state bounded.

### `interaction_required` error response

Returned when the claiming email maps to an existing verified user (account-takeover prevention).

```
{
  error: "interaction_required",
  error_description: string,
  consent_url: string,     // URL the real user must visit to approve linking
  consent_expires_at: string  // ISO 8601; consent link valid for 15 min
  verification_id: string     // opaque durable verification state to retry after approval
}
```

The agent must surface `consent_url` to the human. The human authenticates at that URL, approves or
refuses the link, and splitch transfers the provisional memberships only after approval. Approval and
refusal are one-use; an expired or consumed attempt fails closed. After approval, the agent retries the
claim with the returned `verification_id` and idempotency key; no fixture OTP is accepted for this branch.

### Provisional demo reaping

Cron Trigger Worker runs daily. Query:
`SELECT org_id FROM organizations WHERE is_provisional = 1 AND demo_expires_at < now()`

For each row: delete Apps under the Org (and their Environments), delete Org memberships, delete the
Org — all through the D1 data-access seam (app_id scoping enforced, never bypassed).

## Door C: Device flow (human at terminal / agent no-IdP fallback)

WorkOS device flow. Auth-issuer Worker exposes the standard `device_authorization` and `token` endpoints
as thin proxies to WorkOS. The CLI stores the resulting **refresh token** in keychain or `~/.splitch/credentials.json` (mode 0600). The MCP server does not touch disk; it holds its token in the transport session.

## Shared-preview smoke grant: client_credentials

**Endpoint:** `POST /oauth2/token` on the auth-api Worker

**Availability:** shared-preview only, and only when `SPLITCH_SMOKE_CLIENT_SECRET` is configured.
The grant is advertised in OAuth discovery only while enabled.

**Request body:**

```
{
  grant_type: "client_credentials",
  client_id: string,
  client_secret: string,
  scope?: string
}
```

**Flow:**

1. Reject unless the shared-preview smoke client is configured.
2. Compare `client_id` and `client_secret` against the configured smoke client.
3. Resolve the principal to `SPLITCH_SMOKE_USER_ID` (default `user_shared_preview_smoke`).
4. Use configured `SPLITCH_SMOKE_SCOPES`; an optional requested `scope` must be a subset.
5. Mint a short-lived control-plane access token with `auth_door = "client_credentials"`.
6. Hosted access tokens use the RS256/JWKS trust contract in
   [access-control-matrix.md](access-control-matrix.md). No refresh token is issued.

This grant is not a production user or agent auth path. It exists to validate the hosted
Auth API to Control Plane trust contract with a seeded smoke Organization/App.

## Sources

- [../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md](../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md)
- [../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md](../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0034-edge-abuse-controls-are-a-cloudflare-enforced-product-contract.md](../../adr/0034-edge-abuse-controls-are-a-cloudflare-enforced-product-contract.md)
