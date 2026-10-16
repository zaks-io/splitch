# Personal Access Tokens: headless MCP and CLI access

How a user connects the remote MCP server or runs the CLI from machines that cannot complete browser
sign-in (remote servers, sandboxes), and how those tokens are created, scoped, rotated, and revoked.
The decision record includes the 2026-10-03 and 2026-10-15 amendments to
[ADR-0022](../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md).

## Shape

| property     | value                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| secret       | `spl_pat_` + 64 lowercase hex characters (32 random bytes)                                                |
| id           | `pat_` + 32 lowercase hex characters                                                                      |
| owner        | exactly one WorkOS User; never a service account                                                          |
| accepted by  | the MCP Worker and the Control Plane public bearer door; Auth API and data-plane Workers refuse it        |
| authority    | the owner's live membership ∩ the token's grants, recomputed on every request                             |
| expiry       | 90 days by default; any future instant; or never (explicit `null`, always flagged `neverExpires: true`)   |
| storage      | D1 `personal_access_tokens` holds the SHA-256 hash only; the secret is returned once, at create or rotate |
| active limit | 50 unrevoked tokens per user                                                                              |

## Grants

A token carries 1 to 32 grants. Each grant is `{ target, role, permissions }`:

- `target`: `all` (every current and future membership), `org:<org id>` (that Organization and every
  App in it), or `app:<app id>` (that App only). Canonical ids only, never slugs.
- `role`: `member`, `admin`, or `owner`. A **ceiling**. The effective role on a target is the lower of
  the user's live role and the highest applicable grant ceiling.
- `permissions`: a subset of `write`, `delete`, `credentials`, `members`, `privacy`, in that
  canonical order. Reads are implicit; `[]` is read-only. Unknown permissions and duplicates are
  refused. The grant is strict: the former `access` field is not accepted.

`write` permits configuration changes, `delete` irreversible resource removal, `credentials` SDK
keys and integration credentials, `members` membership, roles, and Organization name and plan,
and `privacy` data exports and Entity erasure. Creating an App or Environment provisions a public
Client Key and needs only `write`; reading the Client Key also needs `write` because it can
provision one. Rotating or reconfiguring it needs `credentials`.

At create and update, an `org:` or `app:` grant must name a membership the caller holds now, with a
ceiling at or below the caller's live role. `all` is checked at use time.

Grants are checked against live membership, not against the scopes of the access token that creates
or updates them. The accepted residual risk is bounded to the CLI `device_flow` door and the
shared-preview-only `client_credentials` smoke grant. An App-bound CLI token can still mint an `all`,
never-expiring PAT. Its access token lives next to the refresh token in the CLI credential store.
Creating, updating, and rotating PATs explicitly allow only those two doors. Un-pausing ID-JAG or
adding a door does not silently grant PAT management; missing and unknown doors are also refused.
A step-up credential from Auth API remains the deferred full fix, as recorded in the ADR amendment.

At use time, the Control Plane resolves the owner's live memberships and keeps only those a grant
covers, at the clamped role. That set is the principal's read authority. Every Control Plane route
explicitly declares its permission. Before selector binding, co-scope, and role checks, a route
needing a permission narrows the principal to grants carrying that permission. An overlapping grant
without that permission contributes no role ceiling: `org:X:member:write` plus
`app:Y:admin:credentials` gives `write` on Y at member and `credentials` on Y at admin.

A refusal returns `FORBIDDEN` naming the missing permission and target. Only a route declared with
one of the five permissions whose path names no Organization or App needs an `all` grant carrying
that permission. Reads use every covering grant at the highest covering ceiling, without filtering
by permission. Path-less reads such as `principal_capabilities_get` work with an App-only token.
`experiment_plan`, `flags_test_eval`, and `experiment_results_post` also need no extra permission. See the
[route permission map](personal-access-token-permissions.md#route-permission-map).

Approval `approve_and_apply` checks the stored proposal operation's permission and role against the
current token before application; every `ApprovalOperation` has a typed mapping, and winner Promotion
uses `write` at App admin. A decline needs `write`. Listing and revoking one's own PATs bypass
permission narrowing. Create, update, rotate, and `current_user_delete` refuse every PAT.

## Request path

The CLI sends `SPLITCH_TOKEN` as the `Authorization` bearer directly to the Control Plane. A bearer
matching `spl_pat_` plus 64 hex characters selects PAT authentication; every other bearer follows the
JWT path. A client-address attempt limit runs before the SESSION_STORE lookup. Authenticated
refusals count against the owner's user-keyed actor limit, shared by all of that user's tokens.

The direct bearer door and MCP delegation share the same verification rules:

1. Hash the presented secret and read `pat:{sha256}` from SESSION_STORE as a fast reject. Unknown,
   revoked, or expired entries are refused. The CLI session-revocation marker does not apply to PATs.
2. Read the D1 row as the authority for owner, expiry, revocation, and current secret hash. The hash
   of the presented secret must equal the row's current hash. A stale active KV entry cannot accept
   a token whose D1 state no longer permits it.
3. Resolve the owner's live memberships, clamp them by the grants, and apply the route's permission
   and role checks. The principal carries `authDoor: "personal_access_token"`, `liveMembership: true`,
   and the token id.

For MCP, the Worker first checks SESSION_STORE and returns 401 with
`WWW-Authenticate: Bearer` and `error="invalid_token"` for an unknown, revoked, or expired entry.
Each tool call delegates an empty scope list, the token id, and the presented secret's SHA-256,
all signed into the one-call delegation. A PAT door without the id and hash, or either on another
door, is rejected as a forgery. The Control Plane then applies the shared D1 and membership checks.
A missing, revoked, expired, or owner-mismatched row, or an obsolete hash, returns
`CREDENTIAL_REVOKED`.

Revoking, narrowing, expiring, or rotating a token takes effect on its next call, even before KV
converges. Rotating an expired token is refused; extend it with `update` first. When the Control
Plane delegates to Analysis or Evaluation, it sends the already-narrowed identity, never the PAT
secret. Auth API `/oauth2/token` and data-plane Workers never accept a PAT.

`principal_capabilities_get` is available on the public bearer door. For a PAT it returns the id,
name, configured grants, expiry, and effective authority per permission. Configured grants and
effective authority are reported separately so a caller can see the effect of current membership.

## Routes

CLI-only Control Plane routes on the public bearer door, keyed by the calling user. They derive no MCP
tool and are never mounted on the MCP or panel bindings. Create, update, and rotate require
`device_flow` or `client_credentials` authentication. Every other door gets `FORBIDDEN` with guidance
to sign in with `splitch login`. List, revoke, and revoke-all remain available to any authenticated
door of the owning user. Listing returns metadata only, and revocation reduces authority, so this
allow-list must never block credential cleanup. A PAT can list and revoke its owner's tokens,
including itself. Session-only refusals tell CLI callers to unset `SPLITCH_TOKEN` and run
`splitch login`.

| operation                           | method + path                                  | returns                    |
| ----------------------------------- | ---------------------------------------------- | -------------------------- |
| `personal_access_tokens_list`       | `GET /personal-access-tokens`                  | list envelope of metadata  |
| `personal_access_tokens_create`     | `POST /personal-access-tokens`                 | `{ token, secret }` (once) |
| `personal_access_tokens_update`     | `PATCH /personal-access-tokens/:tokenId`       | metadata                   |
| `personal_access_tokens_rotate`     | `POST /personal-access-tokens/:tokenId/rotate` | `{ token, secret }` (once) |
| `personal_access_tokens_revoke`     | `POST /personal-access-tokens/:tokenId/revoke` | metadata (idempotent)      |
| `personal_access_tokens_revoke_all` | `POST /personal-access-tokens/revoke-all`      | `{ revokedCount }`         |

Every write updates the SESSION_STORE entry, and a failed write fails loud. A create whose KV write
fails revokes its own row before raising, so no unusable active token remains. Re-running revoke
rewrites the tombstone.

## CLI

Set `SPLITCH_TOKEN` in the environment to run headless. It is the only credential while set: the CLI
never calls the credential store, exchanges the PAT for a JWT, refreshes it, or falls back to a
login session. An empty or malformed value fails before any request. There is no `--token` flag or
token file option. `splitch login` and `splitch logout` refuse while the variable is set.

`splitch context` reports token mode, token metadata, configured grants, and effective authority
from `principal_capabilities_get`. A 401 or `CREDENTIAL_REVOKED` maps to `CLI_TOKEN_INVALID`;
permission and membership refusals remain authorization errors. Revoked, expired, and rotated-out
secrets fail on the next call. Logging out of a CLI session does not revoke its PATs.

`splitch tokens list|create|update|rotate|revoke|revoke-all`. The secret is never printed:

- `create` and `rotate` require `--output-file <path>`.
- `--secret-format env` (the default) writes `SPLITCH_TOKEN=<secret>`; `--env-var` renames the
  variable. The same variable supplies the CLI and an MCP client's `Authorization` header.
  `raw` writes the bare secret.
- Without `--append`, the file is created with mode 0600. An existing file is refused unless
  `--force` is passed.
- `--append` adds the env line to an existing file and creates it (0600) when missing. It refuses a
  file readable by group or others. It refuses a file that already defines the variable, unless
  `--force` replaces that definition in place.
- `-`, `/dev/*`, and `/proc/*` targets are refused.
- Every refusal happens before a request is sent. If the write fails after the secret is minted, the
  CLI revokes the unusable token.
- Output is metadata only: id, grants, expiry, status, a hash fingerprint, `secretWrittenTo`, and
  `envVar`.

`--grant <target>:<role>:<permissions>` is repeatable. Pass `read` for no extra permissions or a
comma-separated list, for example `--grant app:app_123:admin:write,delete`. The old `:read-write`
syntax is refused before any request. To retain its authority, use
`:write,delete,credentials,members,privacy`. Installed CLIs must upgrade to this syntax.
`--expires-at` takes `never`, a day count such as `90d`, or an ISO 8601 date.

## Rollout

Migration `0042_personal_access_token_permissions.sql` rewrites stored `read` grants to
`permissions: []` and `read-write` grants to all five permissions, preserving targets and role
ceilings. Re-applying it leaves new-shape rows unchanged. There is no dual-shape reader.

Production applies D1 migrations before deploying Workers. The previous Control Plane cannot parse
migrated grants and fails PAT calls loudly during that accepted deploy window. Rolling the Control
Plane back past this release after the migration is forbidden. The production migration and deploy
require explicit approval. Completion evidence is the production deploy run for the merge SHA with
`Apply D1 migrations` and `Deploy Cloudflare Workers` both succeeded.

The previous Worker can still create or update old-shape grants during the deploy window. The new
reader refuses those rows. After cutover, follow the
[post-cutover check and standalone rewrite](../platform/deployment-pipeline.md#d1-migrations)
until no stored grant contains `access`. Any production rewrite requires explicit approval.
