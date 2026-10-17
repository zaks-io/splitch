# Temporary Environments, Sync, and the `temporary_environments` permission

**Status:** planned. The decision is
[ADR-0060](../../adr/0060-temporary-environments-are-expiring-scratch-environments-with-their-own-permission.md).
Each slice below moves its part of this file into the canonical specs it names when it ships.

Goal: an agent working on one branch creates its own copy of `dev` or `prod`, points its local
server and client at that copy, changes Flags freely, and never touches an Environment anyone else
uses. The token it holds cannot change a permanent Environment. The copy and its keys stop working
on their own within 7 days.

## Glossary additions

These land in `CONTEXT.md` and `apps/control-plane-api/CONTEXT.md` with the first lifecycle slice,
not before, because the MCP Worker serves root `CONTEXT.md` to agents.

**Temporary Environment**: an Environment created as a scratch copy of another Environment in the
same App. It expires at most 7 days after creation and is then torn down with its configuration
and credentials. Its Policy is always all-`allow` and it cannot host Experiments. Every other
Environment is permanent; the kind is fixed at creation.

**Sync**: replacing every Flag Configuration in a Temporary Environment with the configuration of a
source Environment in the same App, including the salt and never the live Run. Sync only ever writes
into a Temporary Environment.

Reserved language: use **Sync** only for that whole-Environment copy into a Temporary Environment.
**Promote** stays the deployment verb. Use **temporary**, not ephemeral, sandbox, scratch, preview,
or branch, as the domain term.

## Environment shape

The Environment response gains one member:

```
temporary: {
  expiresAt:              string   // ISO 8601
  syncedFromEnvironmentId: string  // last Sync source; may name an Environment deleted since
  syncedAt:               string   // ISO 8601
} | null                           // null for a permanent Environment
```

`environments_list` and `environments_get` return both kinds. The list stays bounded by the
existing `LIST_READ_LIMIT`.

## Rules

- **Kind is immutable.** No route converts a permanent Environment to temporary or back.
- **Expiry.** `expiresAt` defaults to creation plus 7 days. A caller may choose an earlier instant
  more than 1 minute out. Later than 7 days is `VALIDATION_ERROR`. No route extends it; to keep
  working, create a new Temporary Environment from the same source.
- **Policy.** Always the all-`allow` Policy. `policy` on create with `temporary`, or on
  `environments_update` of a Temporary Environment, is refused with `ENVIRONMENT_KIND_UNSUPPORTED`.
  Renaming is allowed.
- **No Experiments.** `experiments_create` in a Temporary Environment is refused with
  `ENVIRONMENT_KIND_UNSUPPORTED`. With no Runs there is no Run freeze, no Run Snapshot, and nothing
  for teardown to preserve.
- **Live limit.** An App holds at most 50 unexpired Temporary Environments. Create beyond that is
  refused with `TEMPORARY_ENVIRONMENT_LIMIT_EXCEEDED`. An expired one stops counting at its expiry,
  before teardown.
- **Expired is read-only.** After `expiresAt`, every mutation addressed to the Environment
  (configuration, Sync, keys, rename) is refused with `ENVIRONMENT_EXPIRED`. Reads work until
  teardown. `environments_delete` still works and runs teardown immediately.
- **App-level rollups ignore Temporary Environments:** the attention rollup (including its
  200-Environment budget), expired and stale Flag detection, and Flag inventory health. The
  last-Environment delete guard counts permanent Environments only, and a Temporary Environment
  never satisfies or trips it.
- **Sentry.** Flag Configuration changes in a Temporary Environment are recorded in the Flag change
  log as usual but are never sent to the Sentry integration. The change-log row records the
  Environment kind at write time, so the dispatcher can skip it after teardown removes the
  Environment row.
- **Usage.** Evaluations under Temporary Environment keys count toward the Organization quota like
  any other (ADR-0033).
- **Keys.** The Environment key follows the existing key rules and stays unique within the App
  until teardown. Agents use a key that names their work, such as `pr-123`. Creating over a key an
  expired but not yet torn down Environment still holds returns the existing `SLUG_CONFLICT`.

## Create

`POST /apps/{app_id}/envs` (`environments_create`) gains an optional body member:

```
{
  key: string,
  name?: string,
  temporary?: {
    fromEnvironmentId: string,   // canonical id or Environment key in this App
    expiresAt?: string           // ISO 8601 with offset
  }
}
```

With `temporary`, the Worker creates the Environment with the all-`allow` Policy, runs Sync from
`fromEnvironmentId`, and provisions the Client Key with the Environment's expiry. The response is
the existing `{ ...Environment, clientKey }` with `temporary` populated. Any failure rolls the
Environment back, as create does today; there is no success response without a synced
configuration and a Client Key. An unknown source is `ENVIRONMENT_NOT_FOUND`.

## Sync

`POST /apps/{app_id}/envs/{environment_id}/sync` (`environments_sync`), body
`{ fromEnvironmentId: string }`.

| Flag Configuration part                                                               | Sync                    |
| ------------------------------------------------------------------------------------- | ----------------------- |
| enabled state                                                                         | copied                  |
| available Variants                                                                    | copied                  |
| baseline rollout percentage                                                           | copied                  |
| salt                                                                                  | copied (unlike Promote) |
| ordered Targeting Rules with conditions, Segment references, and per-rule percentages | copied                  |
| live Run, Activation bindings                                                         | never copied            |

Promotion keeps the target's salt because adopting the source's salt reshuffles Entities already
bucketed in the target. A Temporary Environment has no Entities worth keeping and exists to
reproduce the source, so Sync copies it: a Targeting Key lands in the same rollout bucket as in the
source. A Flag the source serves through a live Run serves its own configuration in the copy;
agents target a specific Variant to test a treatment.

- Every Flag in the App is written, so the target ends identical to the source. A Flag with no
  source configuration gets the initial configuration Environment create already provisions.
- Writes go through the same config-store path as Promotion, in the same bounded batches as
  Environment create. Each changed Flag Configuration gets a change-log row attributed to the
  caller.
- Sync is idempotent: repeating it converges. A partial failure returns
  `ENVIRONMENT_SYNC_INCOMPLETE`, and retrying the same request is the recovery.
- The target must be a Temporary Environment, otherwise `ENVIRONMENT_KIND_UNSUPPORTED`. The source
  may be any Environment in the App, permanent or temporary, except the target itself
  (`VALIDATION_ERROR`).

Returns `{ ...Environment, syncedFlags: number }` with `temporary.syncedFromEnvironmentId` and
`temporary.syncedAt` updated.

## Credentials

- The Client Key is provisioned at create, as for any Environment. API Keys come from the existing
  `api_keys_create`; there is no second minting path. Every credential minted in a Temporary
  Environment, including after rotation, expires with it.
- `CredentialCacheKV` gains payload version 3, identical to version 2 plus
  `expiresAt: string | null`. The Control Plane writes version 3 only for credentials of a
  Temporary Environment and keeps writing version 2 for everything else, so rolling a data-plane
  reader back affects only Temporary Environment keys.
- Evaluation and Event Ingest readers accept versions 1, 2, and 3. After checking the terminal
  revocation marker and before rate limiting, they reject a credential whose `expiresAt` has passed
  with `410 ENVIRONMENT_EXPIRED`. The rejection is not billed. A v3 entry with an unparseable
  `expiresAt` fails closed as `ENVIRONMENT_EXPIRED`.
- The SDK maps a `410` body with `ENVIRONMENT_EXPIRED` to `reason: ERROR`,
  `errorCode: ENVIRONMENT_EXPIRED`, logged once per client, never retried. SDK versions before this
  change fold `410` into `SERVICE_UNAVAILABLE`: still a loud error, not a silent default.

## Permission

`temporary_environments` joins the closed PAT permission set:

| permission               | allows                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `temporary_environments` | The lifecycle of Temporary Environments: create, rename, Sync, Flag Configuration, Promotion into them, SDK keys, delete |

It never authorizes a write to a permanent Environment or an App-level resource (Flags, Variants,
Segments, Event Definitions, Metrics). Existing permissions keep their meaning on Temporary
Environments: `write` can create and configure them, `credentials` can mint their keys, `delete`
can delete them.

**Route opt-in.** A route contract may declare `temporaryEnvironment: true`. These routes opt in:

| operation                                                         | path Environment                        |
| ----------------------------------------------------------------- | --------------------------------------- |
| `environments_create`                                             | body `temporary`                        |
| `environments_update`, `environments_delete`, `environments_sync` | `environmentId`                         |
| `flag_config_update`, `flag_targeting_rules_replace`              | `environmentId`                         |
| `flags_promote`                                                   | `targetEnvironmentId`, the write target |
| `client_key_get`, `client_key_update`, `client_key_rotate`        | `environmentId`                         |
| `api_keys_create`, `api_keys_revoke`                              | `environmentId`                         |

Registry validation fails at module load when an opted-in route other than `environments_create`
has no Environment path parameter.

**Enforcement.**

1. `narrowPersonalAccessTokenForRoute` keeps the existing path when the token carries the route's
   declared permission on the target. Otherwise, for an opted-in route, a token carrying
   `temporary_environments` on the target is narrowed to that permission's scopes and marked
   temporary-only.
2. The shared path-selector resolution step loads the path Environment row for a temporary-only
   principal, canonical ids included, and refuses a permanent Environment with `FORBIDDEN`:
   "personal access token needs `<permission>` permission for `app:<id>`;
   `temporary_environments` covers only Temporary Environments". Enforcement lives in this one
   seam, never in individual handlers.
3. `environments_create` is the one body-dependent case: a temporary-only principal must send
   `temporary`, checked in the create handler and covered by a contract test.

Role gates are unchanged. Creating needs App `admin`, deleting needs App `owner`, as today. A typical
agent token is `--grant app:<app_id>:owner:temporary_environments`: full read, and writes only
inside Temporary Environments. `principal_capabilities_get` reports the new permission. Issuing or
widening a token with it follows the existing step-up rules: adding any permission is widening.

## Teardown

Teardown is one idempotent cascade, used by the scheduled job and by `environments_delete` on a
Temporary Environment:

1. Revoke every credential (terminal markers and tombstones, as revoke does today) and every
   integration installation scoped to the Environment.
2. Delete Flag Configurations, Targeting Rules, and their KV projections.
3. Delete the `environments` row.
4. Run the existing Exposure-status cleanup.

The permanent-Environment `RESOURCE_NOT_EMPTY` blockers do not apply. A failed step leaves the row
in place, and the next run resumes; every step tolerates work already done.

The minute cron tears down up to 5 expired Temporary Environments per tick, oldest expiry first. It
logs `temporary-environment-teardown` with the Environment id and counts, and reports a failure as
`temporary_environment_teardown_failed` through the Worker fault reporter. Teardown never runs
before `expiresAt`, and an expired Environment's keys are already rejected, so a slow teardown
costs only storage.

Data retention: D1 rows and KV entries go at teardown. Credential terminal markers stay, as for any
revoked credential. Exposures, Metric Events, and Web Events written under the Environment age out
under their datasource TTLs, as for any deleted Environment. Change-log rows follow the change-log
retention.

## Surfaces

CLI, one command per operation:

```
splitch envs create --key pr-123 --temporary --from prod [--expires-at 3d]  # [ctx] prints the Client Key
splitch envs sync --env pr-123 --from dev                                   # [ctx]
splitch envs delete --env pr-123                                            # [ctx]
splitch api-keys create --env pr-123                                        # [ctx] secret printed once
```

`--expires-at` takes a day count such as `3d` or an ISO 8601 instant, like `splitch tokens`. MCP
tools derive from the same contracts: `environments_create` with `temporary`, `environments_sync`,
`environments_delete`.

Control Panel: the environment switcher lists Temporary Environments in their own group with their
expiry, and pages scoped to one show its expiry and Sync source. The Policy editor and Experiment
creation are unavailable there, with the reason stated. Both reuse existing components and
treatments. Creating and Sync stay CLI and MCP operations in this release.

## Errors

| code                                   | status | outcome                | details                                                                                             |
| -------------------------------------- | ------ | ---------------------- | --------------------------------------------------------------------------------------------------- |
| `ENVIRONMENT_EXPIRED`                  | 410    | `user_action_required` | `{ environmentId, expiredAt, recommendedAction: "CREATE_TEMPORARY_ENVIRONMENT" }`                   |
| `ENVIRONMENT_KIND_UNSUPPORTED`         | 409    | `non_retryable`        | `{ environmentId, temporary: boolean, attemptedOp }`                                                |
| `TEMPORARY_ENVIRONMENT_LIMIT_EXCEEDED` | 409    | `user_action_required` | `{ appId, limit, active, nextExpiresAt, recommendedAction: "DELETE_TEMPORARY_ENVIRONMENT" }`        |
| `ENVIRONMENT_SYNC_INCOMPLETE`          | 503    | `retryable`            | `{ environmentId, fromEnvironmentId, applied, failed, failedFlagIds /* first 50 */, retryAfterMs }` |

## Storage

`environments` gains three nullable columns, in one additive D1 migration:

| Column                       | Type        | Constraints                                      |
| ---------------------------- | ----------- | ------------------------------------------------ |
| `expires_at`                 | timestamptz | null = permanent; indexed for teardown           |
| `synced_from_environment_id` | text        | no FK; non-null exactly when `expires_at` is set |
| `synced_at`                  | timestamptz | non-null exactly when `expires_at` is set        |

The Flag change log gains the Environment kind at write time (see Sentry above).
`CredentialCacheKV` gains version 3 (see Credentials).

## Rollout

1. The D1 migration is additive; existing rows read as permanent.
2. Evaluation and Event Ingest accept credential cache v3 and enforce its expiry before any
   Control Plane writes v3.
3. The Control Plane then serves the new create body, Sync, teardown, and the permission.

Each production deploy and the production migration need explicit approval.

## Slices

Each slice ships something a user can observe and test end to end.

1. **Data plane honors credential expiry.** Credential cache v3 in contracts, Evaluation and Event
   Ingest expiry rejection, `ENVIRONMENT_EXPIRED` in the error contract, SDK mapping. Updates
   `credentials-and-keys.md`, `storage-schemas-kv.md`, `error-responses.md`.
2. **Temporary Environment create and copy** (blocked by 1). D1 migration, create body with
   copy-from-source, response shape, expiry validation, live limit, Policy and Experiment refusals,
   expired-is-read-only, v3 credential writes, CLI flags, glossary. Updates `endpoints-org-app.md`,
   `storage-schemas-d1.md`, `mcp-and-cli-surfaces.md`, `CONTEXT.md`, both glossaries.
3. **Teardown** (blocked by 2). The cascade, `environments_delete` on a Temporary Environment, the
   cron job, the last-Environment guard. Updates `endpoints-org-app.md`, `privacy-data-lifecycle.md`.
4. **Sync** (blocked by 2). `environments_sync`, CLI and MCP, change-log Environment kind, Sentry
   skip, rollup exclusions. Updates `endpoints-org-app.md`, `endpoints-flag-segment.md`,
   `sentry-integration.md`, `control-plane-endpoint-inventory.md`.
5. **`temporary_environments` permission** (blocked by 2 and 4). Permission enum, route opt-in
   marker and registry validation, narrowing, the path-selector enforcement, the create-body check,
   capabilities, `--grant`. Updates `personal-access-token-permissions.md`,
   `personal-access-tokens.md`, `access-control-matrix.md`.
6. **Control Panel display** (blocked by 2). Switcher group, expiry and Sync source, unavailable
   Policy and Experiment affordances. Updates `screen-inventory.md`.

## Done

- From a clean checkout with only `SPLITCH_TOKEN` set to a token granted
  `app:<id>:owner:temporary_environments`, an agent runs `envs create --temporary --from prod`,
  `api-keys create`, and a local server against the new keys, and every Flag resolves as it does in
  `prod` for the same Evaluation Context, rollout buckets included.
- The same agent flips a Flag in its Temporary Environment and sees the new value through both
  keys, while `dev` and `prod` are unchanged.
- `envs sync --from dev` makes `flags get` in the Temporary Environment match `dev` for every Flag.
- The same token is refused with `FORBIDDEN` naming `write` when it edits a Flag Configuration in
  `dev` or `prod`, through both the CLI and MCP, by key and by canonical id.
- A token with `write` and `credentials` but not `temporary_environments` manages Temporary
  Environments exactly as before; a login session is unaffected.
- From `expiresAt`, both keys get `410 ENVIRONMENT_EXPIRED` from the SDK and from raw
  HTTP, and the Environment is gone from `envs list` after the next teardown tick.
- Experiment creation and Policy edits in a Temporary Environment fail with
  `ENVIRONMENT_KIND_UNSUPPORTED`. The 51st live Temporary Environment fails with
  `TEMPORARY_ENVIRONMENT_LIMIT_EXCEEDED`.
- Flag changes in a Temporary Environment appear in its change log and never reach a Sentry
  installation.
- The attention rollup, stale and expired Flag lists, and inventory health are unchanged by
  creating 50 Temporary Environments.
