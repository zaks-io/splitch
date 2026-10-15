# Personal Access Token permissions and CLI token mode

**Status:** planned. The decision is the 2026-10-15 amendment to
[ADR-0022](../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md). Until the
slices below land, [personal-access-tokens.md](personal-access-tokens.md) describes running
behavior. Each slice updates that spec, `CONTEXT.md`, and the related specs as its behavior ships.

Goal: an agent runs the CLI headless with one PAT and can manage Apps, Flags, and Experiments
without being able to mint secrets, delete resources, change access, or export personal data,
unless its grants say so.

## Grants

A grant is `{ target, role, permissions }`:

- `target` and `role` keep their current meaning: `all`, `org:<id>`, or `app:<id>`, and a role
  ceiling clamped to the user's live role.
- `permissions` is a subset of the closed set below. Reading the target is implicit; an empty set
  is a read-only grant. Order is not significant; duplicates are a validation error.

| permission    | allows                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `write`       | Configuration changes: Apps, Environments, Flags, Variants, Targeting, Promotion, Segments, Event Definitions, Experiments, Runs, Metrics |
| `delete`      | Every irreversible removal of a resource                                                                                                  |
| `credentials` | Creating, rotating, reconfiguring, or revoking SDK keys and integration credentials                                                       |
| `members`     | Organization and App membership and roles, and Organization name and plan                                                                 |
| `privacy`     | Data exports and Entity erasure                                                                                                           |

At use time, the principal's authority for a route declared with one of the five permissions is
the owner's live membership, clamped by the role ceiling of every grant that covers the target AND
carries that permission. A grant without the permission contributes nothing to that route. When
several grants cover one target, the highest ceiling among those carrying the permission applies,
so `org:X:member:write` plus `app:Y:admin:credentials` gives `credentials` on Y at admin and
`write` on Y at member.

A `read` route uses every grant that covers its target, whatever that grant's permissions, at the
highest covering ceiling. It is never filtered by permission and never needs an `all` grant, so
an App-only token can still run path-less reads such as `principal_capabilities_get`.

A route declared with one of the five permissions whose path names no Organization or App needs
an `all` grant carrying that permission. The special rules below are not subject to either rule.

## Route permission map

Every `control-plane-token` route declares exactly one entry in the contract registry. A route
with none fails typecheck. Routes not listed as `read` or a special rule are mutating.

**`read`.** Every route whose audited effects do not mutate and that is not listed under Special
rules, including the POST reads
`experiment_plan`, `flags_test_eval`, and `experiment_results_post`, plus
`principal_capabilities_get` and `privacy_requests_get`.

**`write`.**

- Organizations and Apps: `organizations_create` (path-less), `apps_create`, `apps_update`
- Environments: `environments_create`, `environments_update`
- Flags: `flags_create`, `flags_update`, `flag_variants_create`, `flag_variants_update`,
  `flag_config_update`, `flag_targeting_rules_replace`, `flags_promote`
- Segments and events: `segments_create`, `segments_update`, `event_definitions_create`,
  `event_definitions_update`, `event_definition_versions_create`
- Experiments and Runs: `experiments_create`, `experiments_update`, `experiments_start`,
  `runs_end`, `runs_conclude`, `conclusion_promotion_requests_create`
- Metrics: `metrics_create`, `metrics_update`
- Client Key: `client_key_get`

`client_key_get` provisions the public Client Key on first read. Today it requires `read-write`,
and it stays a `write` route so a read-only token's behavior does not change. App and
Environment creation also provision a Client Key. That is not secret minting, so they need
`write` only.

**`delete`:** `organizations_delete`, `apps_delete`, `environments_delete`, `flags_delete`,
`flag_variants_delete`, `segments_delete`, `experiments_delete`, `metrics_delete`.

**`credentials`:** `client_key_update` (origin allow-list and rate limit), `client_key_rotate`,
`api_keys_create`, `api_keys_revoke`, `cloudflare_installations_revoke`,
`convex_installations_revoke`, `sentry_installations_create`, `sentry_installations_delete`,
`sentry_secret_rotations_create`. Revoking or deleting a credential is `credentials`, not
`delete`, so one permission covers a credential's whole lifecycle.

**`members`:** `organization_members_add`, `organization_members_update`,
`organization_members_remove`, `app_members_add`, `app_members_update`, `app_members_remove`,
`organizations_update`. Organization update changes the plan, which is an Organization-owner
decision, so it sits with access control rather than `write`.

**`privacy`:** `current_user_privacy_export` (path-less), `organization_privacy_export`,
`app_privacy_export`, `entity_privacy_export`, `entity_privacy_delete`.

**Special rules.**

- `approval_request_reviews_create` derives its permission. `approve_and_apply` requires the
  permission of the stored proposal's operation, at that operation's role, checked against the
  current token before application. A decline requires `write`. Every `ApprovalOperation` maps to a
  permission and role, and a missing mapping fails typecheck. An operation that is a route takes
  that route's entry. `experiment_winner_promote` has no route; it maps to `write` at App admin,
  matching `conclusion_promotion_requests_create`.
- `personal_access_tokens_list`, `personal_access_tokens_revoke`, and
  `personal_access_tokens_revoke_all` are owner cleanup. They bypass permission narrowing; the
  handler's owner check still applies.
- `personal_access_tokens_create`, `personal_access_tokens_update`,
  `personal_access_tokens_rotate`, and `current_user_delete` are session-only. A PAT is refused
  whatever its grants.

A consistency test fails when a route whose effects are destructive and irreversible is declared
`write`, so a new deletion cannot slip into the wrong permission.

## Control Plane bearer door

1. A bearer matching `spl_pat_` + 64 hex is routed to the PAT resolver. Any other bearer takes the
   JWT path unchanged.
2. The resolver hashes the secret and reads `pat:{sha256}` from SESSION_STORE as a fast reject,
   then reads the D1 row as the authority, exactly as for an MCP PAT delegation. The principal
   carries `authDoor: "personal_access_token"`, `liveMembership: true`, and the token id.
3. Authentication failures are bounded before storage work. An attempt limit keyed by client
   address runs before the SESSION_STORE read. Authenticated refusals count against the owner's
   actor limit, keyed by user, so holding more tokens does not multiply a user's allowance.
4. Analysis and Evaluation routes reached through the Control Plane receive the already-narrowed
   identity over the service binding. The PAT secret never leaves the Control Plane.
5. Auth API `/oauth2/token` and every data-plane Worker refuse a PAT.

`principal_capabilities_get` is mounted on the public door. For a PAT it returns the token's id,
name, configured grants, expiry, and effective authority per permission, with configured and
effective authority reported separately.

## CLI token mode

- `SPLITCH_TOKEN` holds the secret. It is read from the environment only, never from a flag,
  because process arguments are visible to other users.
- When it is set, it is the only credential. The CLI makes no credential store call and never
  falls back to a login session. An empty or malformed value fails before any request.
- `splitch login` and `splitch logout` refuse while it is set, naming the variable.
- `splitch context` reports token mode with the token's name, id, grants, expiry, and effective
  authority from `principal_capabilities_get`.
- An authentication failure maps to `CLI_TOKEN_INVALID`. That covers both a 401 and
  `CREDENTIAL_REVOKED`, which the stale-KV path returns as 403. Permission and membership refusals
  stay authorization errors and name the missing permission.
- A session-only refusal tells the caller to unset `SPLITCH_TOKEN` and run `splitch login`.
- `splitch tokens create` writes `SPLITCH_TOKEN` by default, and that variable serves both the CLI
  and the MCP `Authorization` header.
- `--grant <target>:<role>:<permissions>` takes a comma-separated permission list or `read`, for
  example `--grant app:app_x:admin:write,delete` and `--grant all:member:read`.

No installed CLI needs to keep working across the change; the CLI and server move to the new grant
shape together and older CLIs must upgrade.

## Rollout

The permissions slice ships its D1 migration in the same release. The migration rewrites every
stored grant: `read` becomes no extra permissions and `read-write` becomes all five, so existing
tokens keep their exact authority. The new Control Plane reads only the new shape.

Production applies D1 migrations before deploying Workers. Between the two steps the previous
Control Plane cannot parse a migrated grant and fails PAT calls loudly. That deploy window is
accepted rather than engineered around with a dual-shape reader. Rolling the Control Plane back
past this release after the migration is forbidden.

In the same window the previous Control Plane still writes grants in the old shape through
`personal_access_tokens_create` and `personal_access_tokens_update`, so a row can be stored
unmigrated after the migration ran. The new Control Plane refuses such a row loudly; it never
reads it as permitted. The release is complete only after a post-cutover check: a read-only
production D1 query counts stored grants still containing `access`. When the count is above zero,
the migration's idempotent rewrite is run again against production D1 and the count is repeated
until it is zero. The rewrite therefore lives in a file that can be re-run on its own.

The production migration, the deploy, and any post-cutover re-run need explicit approval.

## Slices

Each slice ships something a user can observe and test end to end.

1. **Permissions, live on MCP** (SPL-761). Route permission declarations with the completeness and
   consistency tests, the grant schema and its D1 migration, permission narrowing, approval
   derivation, the owner-cleanup and session-only rules, and the `--grant` syntax in
   `splitch tokens`. The CLI changes here because it shares the grant schema and no installed CLI
   needs to keep working. Updates `personal-access-tokens.md`, `access-control-matrix.md`, and
   `quickstart.md`.
2. **The CLI authenticates with a PAT** (SPL-762, blocked by SPL-761). The Control Plane bearer
   resolver and its abuse limits, public `principal_capabilities_get` with token metadata, CLI
   token mode with `context`, the `CLI_TOKEN_INVALID` mapping, and the default variable. Neither
   half is testable without the other. Updates `auth-doors.md`, `mcp-and-cli-surfaces.md`, and
   `CONTEXT.md`.

Coverage:

| section                   | slice            |
| ------------------------- | ---------------- |
| Grants                    | SPL-761          |
| Route permission map      | SPL-761          |
| Control Plane bearer door | SPL-762          |
| CLI token mode            | SPL-762          |
| Rollout                   | SPL-761          |
| Done                      | SPL-761, SPL-762 |

## Done

- From a clean `HOME` with only `SPLITCH_TOKEN` set, `splitch context` and `splitch apps list`
  work against the local harness and the shared preview, and the credential store is never
  touched.
- A token with `app:X:admin:write` can create and promote a Flag on X. `api-keys create` on X is
  refused naming `credentials`, through both the CLI and MCP.
- A `write` token can approve a Promotion or Run Start proposal but not a pending Flag or Variant
  deletion, including a proposal a login session created.
- An App-only read token can list and revoke itself. A PAT is refused on token create, update, and
  rotate and on `current_user_delete`, and the message tells the caller to unset `SPLITCH_TOKEN`.
- A revoked, expired, or rotated token fails its next CLI call with `CLI_TOKEN_INVALID`, including
  while SESSION_STORE still holds a stale active entry.
- Auth API `/oauth2/token` and the Evaluation API refuse a PAT.
- Overlapping grants with different ceilings resolve as specified above. Removing or demoting the
  owner takes effect on the next call. Slugs and canonical ids authorize identically.
- Results reads through the Analysis Worker respect the token's grants.
- Tokens created before the change keep their exact authority after the migration.
- JWT membership-wide read tokens behave exactly as before.
- No CLI output, error, or log line contains a PAT secret.
- Every Control Plane route declares a permission, and the build fails when one does not.
