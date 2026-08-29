# Auth doors: three identity doors, one principal, claim ceremony

How a principal authenticates: the three identity doors (ID-JAG, anonymous/pre-claim, device flow),
the shared-preview `client_credentials` smoke grant, the claim ceremony, the `interaction_required`
error shape, and the provisional demo lifecycle.

For the scopes enumeration, resource access-token shape, trusted-IdP table, and the Worker
responsibility split, see [access-control-matrix.md](access-control-matrix.md).

## One principal, three identity doors

An agent is never a distinct principal. Every door produces a WorkOS user identity; authorization is
single-sourced on D1 membership. Which door was used is audit-only and never branches an authz decision.
The shared-preview `client_credentials` grant is the one non-interactive exception: it can only mint
a scoped token for the configured seeded smoke WorkOS user, and it exists to exercise hosted Auth API
to Control Plane verification in smoke tests.

```
Door A: ID-JAG   ──┐
Door B: Anonymous ─┼──► /oauth2/token ──► resource-bound access token ──► resource verification
Door C: Device flow┘

Shared-preview smoke client_credentials ──► /oauth2/token ──► scoped smoke access token
```

## Door A: ID-JAG (agent-IdP-verified, paused)

Door A remains disabled and absent from authorization-server discovery and `auth.md`. The flow below
records the approved design for later activation; it is not an enabled runtime path.

**Endpoint:** `POST /agent/identity` on the auth-api Worker

**Request body:**

```
{
  id_jag: string,        // signed JWT from the agent's IdP
  requested_scopes?: string[]
}
```

**Validation steps (all must pass; fail loud on any failure):**

1. Decode the JWT payload, extract `iss` (issuer), and read `kid`/`alg` from the header
2. Look up `iss` in `trusted_idps` D1 table; reject with 401 if not found
3. Fetch JWKS from `trusted_idps.jwks_uri`; verify JWT signature
4. Assert `aud` matches splitch's auth-api origin
5. Assert `exp` not passed; assert `auth_time` freshness (default: within 5 min)
6. Assert `email_verified = true` (step 8 resolves the user by `email`, so
   phone-only verification is not sufficient)
7. Check `jti` replay cache (KV key `jti:{jti}`, TTL = exp - now); reject if seen
8. Resolve WorkOS user by `email`; create in WorkOS if first-seen. D1 stores membership references only.
9. Return: `{ identity_assertion: string, user_id: string }`

**Follow-up exchange at `/oauth2/token`:** presents `identity_assertion` and the selected protected
resource, then receives a short-lived access token whose `aud` is that exact resource. No refresh
token on the ID-JAG path. Every runtime target uses the RS256/JWKS trust contract in
[access-control-matrix.md](access-control-matrix.md).

## Door B: Anonymous / pre-claim

**Endpoint:** `POST /agent/identity` with no `id_jag` field (anonymous body)

**Flow:**

0. **Turnstile challenge before any row is created (ADR-0034).** This is a public, unauthenticated
   **write** surface that mints WorkOS users and D1 rows; per-IP rate limiting alone is defeated by IP
   rotation. Verify the Cloudflare Turnstile token server-side (siteverify; single-use; 300s expiry)
   before step 2. Reject on failure — no rows created.
1. Rate-limit per source IP **and a global ceiling** in app (default: 10 provisional creates per IP per
   hour, plus a coarse per-isolate cap of 10,000 provisional creates/hour). Cloudflare Free also applies
   the verified short-window source-IP rule on exact path `/agent/identity`. It is not the authoritative
   one-hour cross-IP/global ceiling: host/method scoping and that global WAF control remain deferred until
   traffic justifies the paid plan (ADR-0034).
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
  email: string,                // address to verify or link
  resource?: string             // exact protected resource; defaults to Control Plane
}
```

**OTP verification request:**

```
{
  identity_assertion: string,
  email: string,
  otp: string,                  // one-time password delivered to the user's email
  idempotency_key: string,      // caller-supplied; prevents double-claim on retry
  resource?: string             // must match initiation when provided
}
```

**Consent verification request:**

```
{
  identity_assertion: string,
  email: string,
  verification_id: string,      // returned with interaction_required
  idempotency_key: string,
  resource?: string             // must match initiation when provided
}
```

**Claim steps:**

1. Validate `identity_assertion`; assert provisional. Initiation first asks WorkOS whether the normalized email already belongs to a verified user. A free address is then assigned to the provisional WorkOS user and the email-verification code is sent; a collision creates only durable verification and consent state and returns `interaction_required` without mutating the provisional user.
2. D1 stores only SHA-256 identifier digests plus bounded TTL, attempt, one-use, consent, and idempotency state. It never stores an OTP or a hosted fixture code.
   The initiation row also stores the exact selected protected resource, using the Control Plane as
   the default. A legacy row without persisted resource authority cannot adopt a verifier-supplied
   resource and fails loud.
3. For a free address, WorkOS confirms the OTP. Its result is the email-ownership authority.
4. For an existing verified address, the existing AuthKit principal authenticates at the consent URL. The browser can approve or refuse with POST; no provisional WorkOS user email is changed in this branch.
5. The consent page is a dedicated Control Panel route. Its URL is built from the explicit `CONTROL_PANEL_ORIGIN`, never the Control Plane API origin. Its opaque browser session maps to a server-side WorkOS access JWT; the panel forwards that JWT only server-to-server. Auth API verifies its RS256 signature, configured issuer, `client_id`, expiry, and `sub` against WorkOS JWKS. The panel stores the WorkOS refresh token server-side and refreshes the JWT when it expires. The session ends when WorkOS refuses refresh due to its configured maximum session length or inactivity timeout, or when the panel reaches its absolute 30-day cap. Existing splitch membership is not an authorization input for this route.
6. After WorkOS verification or authenticated consent, one guarded D1 batch first acquires the still-provisional Organization only while the signed provisional User still has the matching Org and App memberships. Every membership mutation, state consumption, and idempotency insert is conditional on that acquisition. Retries after a pre-batch failure are safe.
7. Mint the access token for the canonical protected resource selected at initiation. The selected
   resource is part of the durable idempotency result, so retries cannot fall back to Control Plane
   or widen to another resource. Return: `{ access_token, user_id, org_id, app_id }`.

### Claim-state retention

The daily Control Plane scheduled reaper purges expired claim artifacts in bounded batches of 100
verifications. Consent attempts are deleted before their verification rows, and completed or abandoned
idempotency reservations use a five-minute in-flight lease that is extended to the full 24-hour replay
window only after completion. This lets a valid ceremony recover an abandoned reservation while keeping
completed retries stable before those verification rows become eligible for deletion.

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

WorkOS device flow. Auth-issuer Worker exposes the standard `device_authorization` and `token`
endpoints. The caller's `client_id` must name a registered first-party public client
(`splitch-cli`); an unknown id fails `invalid_client` naming the id, and the caller's value is
**never** forwarded to WorkOS — every provider call authenticates as the one configured WorkOS
client. An App selector at login is **optional**: cold start is the first-class path
(quickstart.md step 1 — authenticate, then create the Org and App), and a login with no App mints
an unbound session token, which is exactly the authority `orgs list` / `orgs create` need.

**One approval, many rebinds.** The single human approval mints a durable provider session. Each
access-token mint binds to at most one resource, resolved against live D1 membership keyed by the
WorkOS User at mint time — never against a WorkOS Organization grant, which personal AuthKit
sign-ins do not have. `grant_type=refresh_token` accepts an optional `app` or `org` selector (ID
or slug) to rebind the minted token to another resource the user's live membership allows;
`splitch use` and per-command scoping are rescopes, never re-logins. The single-binding token
model and the guard's Org/App co-scope checks are unchanged: a mint for a resource outside live
membership fails `invalid_grant`, and a grant's App selection cannot be widened while polling.
The binding is resolved **before** the provider is called: WorkOS refresh tokens are single-use, so
an unresolvable selector must fail the one request rather than burn the session.

A Control Plane token request may instead set `authorization=membership-wide-read`. This option is
mutually exclusive with `app`, `org`, and a device grant's selected App. It mints no selector scopes;
the Control Plane resolves the principal's complete membership set through the bounded
`memberships:{user_id}` cache defined by
[ADR-0053](../../adr/0053-membership-cache-is-bounded-and-not-an-authorization-decision.md). The
route registrar accepts that structural grant only for `GET` and rejects every mutation before its
handler runs. Internal delegation carries the grant and request-resolved membership set, binds only
axes the surface registrar already authorized, and reruns Organization/App co-scope in the owner
Worker. App-scoped reads retain an uncached D1 App membership backstop. The CLI reuses any unexpired device-flow token for principal-keyed Organization
discovery. When it must refresh, it refreshes the session default without requesting wide authority;
`organizations_list` already returns the principal's complete live Organization membership set for
device-flow principals. The CLI-side request and cache path for wide authority lands in SPL-530, where
selector-free App reads consume it. Selector-scoped commands continue to mint selector-bound tokens.
Both device-code exchange and refresh refuse wide authority when the session has a selected App. The
authorization is refused for MCP resources, does not change token TTL, and uses the same session
revocation check as every other access token.

**Selector resolution is two-pass, ID before key.** An App ID is globally unique; an App key is
unique per Organization only, and any user may add another user to an Organization they own. So a
selector is matched against the canonical ID across every reachable App first, and only then
against keys, where a match count other than one fails `invalid_grant` and demands the ID. Without
that order, an attacker could key their own App `app_<victim App ID>` and capture a victim's rebind
by winning enumeration order. The ID-first pass is what closes this; it holds on its own, because an
App ID is the `apps` primary key and a duplicate key refuses rather than picks.

App keys accepted through `apps_create` are additionally constrained to the shared slug alphabet
(`SlugSchema`, no `_`), which is defence in depth rather than the load-bearing control: it is a
request-schema rule, not a storage invariant, so it does not describe every row. Door B's provisional
App is written through the repo seam with `key` set to its own App ID, and rows created before the
constraint were never migrated. Neither is attacker-chosen, but do not rely on "no stored key is
identifier-shaped" as a property.

`splitch use` applies the identical two-pass rule client-side; the two must not drift, and
`apps/cli/src/cli-context.test.ts` pins the client half against the same two attacks.

Auth API stores only a hash of the provider refresh token plus its provider session ID, WorkOS
User grant (and Organization grant when one exists), and the canonical selected App ID or none.
Roles are never stored — the scope's role is reintersected with live membership at every mint.
Missing or changed authority, expired/revoked provider sessions, and removed membership fail
loud. The CLI stores the resulting **refresh token** in keychain or `~/.splitch/credentials.json`
(mode 0600). The MCP server does not touch disk or forward the client bearer; MCP clients present
their exact-resource access token on transport requests.

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
  resource?: string,
  scope?: string
}
```

**Flow:**

1. Reject unless the shared-preview smoke client is configured.
2. Compare `client_id` and `client_secret` against the configured smoke client.
3. Resolve the principal to `SPLITCH_SMOKE_USER_ID` (default `user_shared_preview_smoke`).
4. Use configured `SPLITCH_SMOKE_SCOPES`; an optional requested `scope` must be a subset.
5. Mint a short-lived resource-bound access token with `auth_door = "client_credentials"`. The
   Control Plane is the default resource; an explicitly requested MCP resource must exactly match the
   configured MCP origin or its `/mcp` endpoint.
6. Every runtime target uses the RS256/JWKS trust contract in
   [access-control-matrix.md](access-control-matrix.md). No refresh token is issued.

This grant is not a production user or agent auth path. It exists to validate the hosted
Auth API to Control Plane trust contract with a seeded smoke Organization/App.

## Sources

- [../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md](../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md)
- [../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md](../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0034-edge-abuse-controls-are-a-cloudflare-enforced-product-contract.md](../../adr/0034-edge-abuse-controls-are-a-cloudflare-enforced-product-contract.md)
