# Personal Access Tokens: headless MCP access

How a user connects the remote MCP server from machines that cannot complete browser OAuth (remote
servers, sandboxes), and how those tokens are created, scoped, rotated, and revoked. The decision
record includes the 2026-10-03 and 2026-10-15 amendments to
[ADR-0022](../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md).

## Shape

| property     | value                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| secret       | `spl_pat_` + 64 lowercase hex characters (32 random bytes)                                                |
| id           | `pat_` + 32 lowercase hex characters                                                                      |
| owner        | exactly one WorkOS User; never a service account                                                          |
| accepted by  | the MCP Worker only; the Control Plane API and Auth API refuse it as a bearer                             |
| authority    | the owner's live membership ∩ the token's grants, recomputed on every delegated call                      |
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

A refusal returns `FORBIDDEN` naming the missing permission and target. A route whose path names no
Organization or App needs an `all` grant carrying its permission. Reads, including `experiment_plan`,
`flags_test_eval`, and `experiment_results_post`, need no extra permission. See the
[route permission map](personal-access-token-permissions.md#route-permission-map).

Approval `approve_and_apply` checks the stored proposal operation's permission and role against the
current token before application; decline needs `write`. Listing and revoking one's own PATs bypass
permission narrowing. Create, update, rotate, and `current_user_delete` refuse every PAT.

## Request path

1. The MCP client sends `Authorization: Bearer spl_pat_…` to the MCP Worker.
2. The MCP Worker hashes the secret and reads `pat:{sha256}` from SESSION_STORE. Unknown, revoked,
   or expired entries get a 401 whose `WWW-Authenticate` carries `error="invalid_token"` and an
   `error_description` an agent can act on. The CLI session-revocation marker does not apply to PATs.
3. Each tool call is delegated with `authDoor: "personal_access_token"`, `liveMembership: true`, an
   empty scope list, and `personalAccessTokenId`. The token id is signed with the rest of the
   one-call delegation, together with the SHA-256 of the presented secret (never the secret). A PAT
   door without both, or either on any other door, is rejected as a forgery.
4. The Control Plane reads the D1 row by id. It refuses with `CREDENTIAL_REVOKED` when the row is
   missing, revoked, expired, or owned by anyone other than the delegation subject. It then applies
   the grants as above.

D1 is authoritative at step 4, so revoking, narrowing, expiring, or rotating a token takes effect on
its next tool call even before the KV entry converges. The MCP Worker signs the SHA-256 of the
presented secret into the delegation, and the Control Plane requires it to equal the row's current
hash, so a rotated-out secret is refused immediately. Rotating an expired token is refused; extend it
with `update` first.

## Routes

CLI-only Control Plane routes on the public bearer door, keyed by the calling user. They derive no MCP
tool and are never mounted on the MCP or panel bindings. Create, update, and rotate require
`device_flow` or `client_credentials` authentication. Every other door gets `FORBIDDEN` with guidance
to sign in with `splitch login`. List, revoke, and revoke-all remain available to any authenticated
door of the owning user. Listing returns metadata only, and revocation reduces authority, so this
allow-list must never block credential cleanup. A PAT secret remains invalid as a Control Plane
bearer.

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

`splitch tokens list|create|update|rotate|revoke|revoke-all`. The secret is never printed:

- `create` and `rotate` require `--output-file <path>`.
- `--secret-format env` (the default) writes `SPLITCH_MCP_TOKEN=<secret>`; `--env-var` renames the
  variable. `raw` writes the bare secret.
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
