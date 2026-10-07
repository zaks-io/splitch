# Agent and human auth via the auth.md protocol: one principal, three doors, splitch as resource server

**Status:** accepted; amended 2026-07-19, 2026-08-28, 2026-08-31, 2026-10-03

## 2026-10-03 amendment: Personal Access Tokens for the remote MCP server

Browser OAuth cannot complete on a remote server or sandbox that has no browser
and no reachable loopback, and an hour-long access token cannot sit in an MCP
client's static `Authorization` header. A **Personal Access Token (PAT)** fills
that gap without creating a second principal class.

- **One user, never a service account.** A PAT belongs to exactly one WorkOS
  User. Its authority is that user's LIVE Organization and App membership,
  intersected with the token's own grants on every request. A grant names a
  target (`all`, one Organization, or one App), a role ceiling, and `read` or
  `read-write` access. A grant never adds a membership or raises a role.
- **MCP only.** Only the MCP Worker accepts a PAT. It authenticates the secret
  against a SESSION_STORE entry, then delegates with the token id and the
  `personal_access_token` door. The Control Plane re-reads the D1 row on every
  delegated call, so a revoked, expired, or narrowed token takes effect on its
  next use. The Control Plane API and Auth API never accept a PAT as a bearer,
  and no issuer mints that door as a JWT claim.
- **Managed by a human session, never by MCP.** Create, update, rotate, and
  revoke are CLI-only Control Plane routes on the public bearer door. They derive
  no MCP tool and are not mounted on the MCP binding, so a PAT can never mint,
  widen, or extend a PAT.
- **The secret is surfaced once and never printed.** The CLI writes it to a 0600
  file (optionally appended to an env file) and prints metadata only, so an agent
  can operate tokens without reading one.
- **Expiry is the user's choice.** The default is 90 days. A token that never
  expires must be asked for explicitly, and it is always labelled in list
  output.
- **Independent of CLI sessions.** Logging out of the CLI does not revoke PATs.
  The session revocation marker covers hour-long access tokens and would only
  suspend a long-lived PAT temporarily. A PAT is revoked on its own, durably in
  D1 (`splitch tokens revoke` or `splitch tokens revoke-all`).

**Accepted risk: a CLI device-flow token can mint a broad PAT.** Grants are
checked against the user's live membership, not against the scopes of the
Control Plane access token that creates or updates them. Creating, updating,
and rotating PATs explicitly allow only `device_flow` and `client_credentials`.
The latter is the shared-preview-only smoke grant. Every other door, including
missing or unknown doors, is refused. Un-pausing ID-JAG or adding a door does
not silently grant PAT management. Listing and revocation remain available to
any authenticated door of the owning user so credential cleanup is never
blocked by this allow-list.

The residual risk is bounded to the CLI device-flow door and the preview-only
smoke grant. A one-hour, App-bound CLI token can still create an `all` grant that
never expires. Device-flow access tokens live in the CLI credential store,
next to the refresh token that can already rebind to any membership, so stealing
one usually means stealing both. Closing this fully needs a step-up ("sudo")
credential for PAT management from Auth API. That remains deferred.

This narrows the earlier rejection of "a raw API key from the agent flow". That
rejection protected two properties: every action ties to a real, revocable user,
and the agent credential stays distinct from the SDK API Key. A PAT keeps both. It
is user-bound, individually and collectively revocable, clamped to live
membership, and never valid on the data plane.

## 2026-08-31 amendment: AuthKit is the browser OAuth authorization server

Remote MCP clients that implement the MCP authorization-code flow discover the
configured WorkOS AuthKit issuer directly from the MCP Protected Resource
Metadata. AuthKit owns CIMD, Dynamic Client Registration, consent, S256 PKCE,
authorization codes, refresh rotation, and OAuth token issuance. Splitch remains
the resource server: it verifies the AuthKit JWT against the issuer's OAuth JWKS
and the exact MCP Resource Indicator, then signs a closed live-membership marker
into the operation-, request-, and replay-bound one-call delegation. Only after
the Control Plane validates that delegation does it resolve the WorkOS User's
current Splitch Organization and App memberships from D1. Membership lists never
ride in bearer tokens or delegation headers, and provider OAuth scopes are never
interpreted as Splitch membership authority.

The existing Splitch auth-api remains the auth.md and device-flow issuer. This is
one principal reached through provider-managed browser OAuth, not a new principal
class, and authorization continues to derive from live D1 membership.

## 2026-08-28 amendment: path-selected App binding

An MCP delegation may carry signed scopes for several Apps, so its initial
Principal has no single App binding. On an App-scoped route, the authenticated
selector resolver may bind that null axis to exactly one App already named by a
matching signed `app:<id>:<role>` scope. The request may name that App by canonical
ID or by a membership-bounded slug; both forms authorize identically. This
binding grants no new authority, and the resolved App is co-scoped before any
Environment or Flag lookup and again by the shared guard before the handler.

## 2026-07-19 amendment: resource-bound access tokens

The original phrase "the same control-plane access token" meant one principal, claim shape, signing
contract, and authorization model. It did not authorize one bearer across resources. `/oauth2/token`
now binds each access token to the exact selected protected resource: the Control Plane origin, the
MCP origin, or the MCP `/mcp` endpoint. All runtime targets, including local, mint RS256 tokens and
publish the verification key through Auth API JWKS. Door A remains paused and absent from discovery;
this amendment does not enable it.

The control plane is driven by both **AI agents** and **humans**, and the design goal is **minimum friction
for both** — especially for an agent logging in on a user's behalf. splitch adopts WorkOS's **auth.md**
protocol (an open protocol over OAuth Protected Resource Metadata + ID-JAG identity assertions) and
implements **splitch itself as the auth.md resource server**. WorkOS provides the user store and OAuth
surfaces; splitch owns the protocol endpoints at its own edge.

**One principal, many doors.** An agent is **never a distinct principal** — it is a WorkOS user reached
through a different door. Authorization is single-sourced on the user (resolved to D1 Org/App membership per
ADR-0018/0021); _which_ door was used is recorded for **audit only** and never branches an authz decision.
An agent can do exactly what the user it acts for can do — no more, no less. Future per-session limits are
expressed as **scopes on the issued credential**, not as a new class of principal.

**Three doors, all terminating at the same auth-api and minting the same resource-bound access-token
shape:**

1. **ID-JAG (agent-verified)** — the frictionless primary for agents. The agent's IdP (Anthropic, OpenAI,
   Cursor) issues an audience-specific ID-JAG attesting to the user; the agent POSTs it to splitch's
   `/agent/identity`; splitch validates it (JWKS, `aud`, `exp`, `jti` replay cache, `email_verified`/
   `phone_verified`, `auth_time` freshness) and resolves to a **real, persistent** user. No demo expiry — the
   attestation _is_ verification.
2. **Anonymous / pre-claim** — first-class, not a fallback (not every runtime supports ID-JAG). The agent
   self-registers, gets a credential immediately scoped to limited `pre_claim_scopes`, provisioning a **24h
   provisional demo** account. The user later completes a claim ceremony (`/claim`, OTP) to upgrade scopes
   **in place** and convert the demo's data to a real account; unclaimed demos are reaped (see Consequences).
3. **Device flow** — the primary for a **human at a terminal** (who has no ID-JAG), and the agent's no-IdP
   fallback. Browser-approve once; a refresh token is stored client-side for silent renewal.

**The trusted-IdP allow-list is config-driven, not hardcoded.** Each trusted issuer is a structured record
(`issuer`, `jwks_uri`, `client_ids`) stored in **D1** (the relational config home, ADR-0018), so adding or
removing a trusted provider is a row change, not a deploy. Seed rows: **Anthropic, OpenAI, Cursor**. An
unknown issuer is **rejected — fail loud** (design principle), never silently trusted.

**Email collision on claim forces a step-up; never a silent merge.** If an anonymous/claiming agent presents
an email that already maps to a real user, splitch returns `interaction_required` and requires the _real_
user to authenticate through splitch's own login and **consent** to linking the provider identity. Binding on
verified email alone is an account-takeover vector and is forbidden — matching the auth.md spec.

**Two credential systems, deliberately not unified.** The resource access token from this flow is
**separate from the SDK data-plane API key** (ADR-0018, validated per-request in KV on the hot path). They
never mix: agents/humans _manage_ config with short-lived resource tokens; deployed SDKs _evaluate_
flags with long-lived KV-validated API keys. **This agent-auth work touches zero of the serving hot path.**

## Considered options

- **M2M / client_credentials for agents** — rejected. The user explicitly does not want machine-to-machine
  service accounts; every action must tie to a real, revocable user. ID-JAG + device flow keep one principal
  model; M2M would create a second, user-less principal class — the thing this ADR forbids.
- **Loopback-redirect (PKCE) as the human/fallback door instead of device flow** — rejected as the
  Splitch CLI's primary door, but required for interoperable remote MCP clients.
  Agents (and remote terminals) frequently run in sandboxes with no browser and no reachable localhost, where
  loopback breaks; device flow degrades gracefully (approve from any device). Device flow is WorkOS's
  first-class "CLI Auth" answer for exactly this.
- **Issue a raw API key from the agent flow** — rejected: the auth.md protocol mandates assertion →
  token-exchange (the agent gets splitch's `identity_assertion`, exchanges it at `/oauth2/token` for a
  short-lived access token, re-exchanges on expiry; no refresh token on the ID-JAG path). It also keeps the
  agent credential distinct from the SDK API key.
- **Unify the agent token and the SDK API key into one credential** — rejected: forces short-lived bearer
  tokens onto the per-request hot path, fighting ADR-0018's stable-key-hash KV validation, for no benefit.
- **Lean entirely on WorkOS to broker ID-JAG so splitch never sees an assertion** — rejected: owning the
  `/agent/identity` + `/oauth2/token` endpoints is what lets splitch scope credentials to Org/App + role and
  publish its own `auth.md`. The user chose to follow the protocol, not wait for a turnkey broker.
- **Hardcode the trusted-IdP list** — rejected: the user will change it; a D1-backed config row makes
  add/remove an operation, not a deploy, and keeps the trust list auditable.

## Consequences

- **splitch implements the full auth.md surface** on a dedicated **auth-api Worker** (ADR-0023): the
  discovery chain (401 `WWW-Authenticate` → `/.well-known/oauth-protected-resource` →
  `/.well-known/oauth-authorization-server` with the `agent_auth` block), `/agent/identity`,
  `/agent/identity/claim`, the user-facing `/claim` page, `/oauth2/token`, `/oauth2/revoke`, and the SET
  receiver `/agent/event/notify`. The issuer is its **own service** so its `aud` origin is stable (every
  ID-JAG's `aud` points at it) and the credential-minting surface is isolated for security review.
- **The durable client-side artifact is splitch's `identity_assertion`** (re-exchanged for short-lived access
  tokens), _not_ a refresh token, on the ID-JAG path. The device-flow path stores a WorkOS refresh token.
  Auth API stores only its hash with the provider Organization/session and canonical selected App
  authority, rotates it through WorkOS, and rechecks live membership before each mint.
- **Anonymous registration is the abuse surface** (mints accounts with no auth), so the auth-api Worker
  **rate-limits it at the Cloudflare edge** (per-IP / per-issuer).
- **24h provisional demos must be reaped.** Unclaimed provisional Orgs/Apps are swept from D1 by a Cloudflare
  **Cron Trigger** Worker, going through the ADR-0018 data-access seam (so tenant scoping is enforced in one
  place). This is the auth-side instance of the self-cleaning design principle; raw-event retention is a
  separate Tinybird-TTL concern.
- **Revocation is bidirectional and standards-based** (`/oauth2/revoke` RFC 7009; provider-signed events at
  `/agent/event/notify`). Killing a user's WorkOS session or a delegation revokes the agent's reach, because
  the agent is that user.
- **Likely a CONTEXT.md note, not new glossary terms** — "ID-JAG", "claim", "door" are auth-implementation
  vocabulary, not domain language; they stay out of the glossary unless one proves to be a domain concept.
