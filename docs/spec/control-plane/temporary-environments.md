# Temporary Environments, Sync, and the `temporary_environments` permission

**Status:** lifecycle implemented by SPL-770. The Control Panel and app-view changes in SPL-771 and
PAT permission changes in SPL-772 remain pending. The decision is
[ADR-0060](../../adr/0060-temporary-environments-are-expiring-scratch-environments-with-their-own-permission.md).
Canonical lifecycle behavior is documented in [Environment endpoints](endpoints-org-app.md),
[credentials](credentials-and-keys.md), [CLI and MCP](mcp-and-cli-surfaces.md),
[D1](../contracts/storage-schemas-d1.md), [KV](../contracts/storage-schemas-kv.md), and
[errors](../contracts/error-responses.md). This file retains the full design and pending slices.

Goal: an agent working on one branch creates its own copy of `dev` or `prod`, points its local
server and client at that copy, changes Flags freely, and never touches an Environment anyone else
uses. With the pending SPL-772 permission, the token it holds cannot change a permanent Environment.
The copy and its keys stop working
on their own within 7 days.

## Glossary additions

These definitions are in `CONTEXT.md` and `apps/control-plane-api/CONTEXT.md` with SPL-770. The MCP
Worker serves root `CONTEXT.md` to agents.

**Temporary Environment**: an Environment created as a scratch copy of another Environment in the
same App. It expires at most 7 days after creation and is then torn down with its configuration
and credentials. Its Policy is always all-`allow` and it cannot host Experiments. Every other
Environment is permanent; the kind is fixed at creation.

**Sync**: replacing every Flag Configuration in a Temporary Environment with the configuration of a
source Environment in the same App, including the per-Environment Default Variant and salt, and
never the live Run or Activation bindings. Sync only ever writes
into a Temporary Environment.

Reserved language: use **Sync** only for that whole-Environment copy into a Temporary Environment.
**Promote** stays the deployment verb. Use **temporary**, not ephemeral, sandbox, scratch, preview,
or branch, as the domain term.

## Environment shape

The Environment response gains one member:

```
temporary: {
  expiresAt:               string  // ISO 8601
  syncedFromEnvironmentId: string  // last Sync source; may name an Environment deleted since
  syncedAt:                string  // ISO 8601
} | null                           // null for a permanent Environment
```

`environments_list` and `environments_get` return both kinds. The list stays bounded by the
existing `LIST_READ_LIMIT`.

## Rules

- **Kind is immutable.** No route converts a permanent Environment to temporary or back.
- **Expiry.** `expiresAt` defaults to creation plus 7 days. A caller may choose an earlier instant
  more than 1 minute out. Later than 7 days is `VALIDATION_ERROR`. No route extends it; to keep
  working, create a new Temporary Environment from the same source.
- **Policy.** Always the all-`allow` Policy, so a Temporary Environment never has an Approval
  Request. `policy` on create with `temporary`, or on `environments_update` of a Temporary
  Environment, is refused with `ENVIRONMENT_KIND_UNSUPPORTED`. Renaming is allowed.
- **Nothing outside references it.** These are refused with `ENVIRONMENT_KIND_UNSUPPORTED`:
  - `experiments_create` in a Temporary Environment, so it has no Runs, Run Snapshots, Run freeze,
    or SRM alarms;
  - Conclude or `conclusion_promotion_requests_create` naming a Temporary Environment as the
    winner Promotion target, because a Conclusion is durable decision evidence and would pin the
    Environment forever;
  - Convex and Cloudflare integration installation with a Temporary Environment credential,
    because both runtimes evaluate stored snapshots locally with no expiry.

  Teardown therefore never meets an Experiment, Conclusion, installation, or delivery row. Sentry
  installations are Organization-level and unaffected.

- **Live limit.** An App holds at most 50 unexpired Temporary Environments. Create beyond that is
  refused with `TEMPORARY_ENVIRONMENT_LIMIT_EXCEEDED`. An expired one stops counting at its expiry,
  before teardown.
- **Expired is read-only.** After `expiresAt`, every mutation addressed to the Environment
  (configuration, Sync, keys, rename) is refused with `ENVIRONMENT_EXPIRED`. Reads work until
  teardown. The registry's `route.effects.mutates` classifies mutations, independent of HTTP
  method. `client_key_get` provisions and is fenced; read-only POST operations stay readable.
  `environments_delete` still works and starts teardown immediately.
- **The fence is serialized.** Every Flag Configuration write, Sync write, and teardown step that
  touches configuration runs in the Environment's existing Config Store writer
  (`configWriterName(appId, environmentId)`), which re-checks the Environment's expiry inside its
  serialization. The fence refuses anything that creates or changes configuration in an expired
  Temporary Environment; removals still apply. The credential cache writer Durable Object refuses
  an active entry for an expired Temporary Environment. A write that passed the handler's check just
  before expiry therefore cannot recreate state after teardown starts.
- **App-wide provisioning and republication skip expired Temporary Environments.** Flag creation
  provisioning, Segment republication, and Variant catalog republication skip an expired Temporary
  Environment, and treat a fence refusal from one that expired after enumeration as a skip, not a
  failure, so an Environment waiting for teardown never fails or partially applies those changes.
  Flag deletion still removes its configuration there, because removal is not refused. Reference
  blockers are unchanged: a Variant that a Targeting Rule in any Environment still references,
  including an expired Temporary Environment awaiting teardown, cannot be deleted. The blocker names
  that Environment, and deleting it is the remedy.
- **App-level rollups ignore Temporary Environments:** the attention rollup (its planning, its
  200-Environment budget, and its items), expired and stale Flag detection, and Flag inventory
  health. The stale, expired, and inventory health exclusions are implemented by SPL-771, including
  configuration and change-log history. The attention
  rollup exclusion ships with creation: without it, an App with more than 150
  permanent Environments could exceed the budget by creating Temporary Environments. The
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
  expired but not yet torn down Environment still holds returns `SLUG_CONFLICT`, with
  `resourceType: "environment"` and `recommendedAction: "CHOOSE_DIFFERENT_SLUG"`.

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
Environment back through teardown; there is no success response without a synced configuration and
a Client Key. An unknown source is `ENVIRONMENT_NOT_FOUND`.

## Sync

`POST /apps/{app_id}/envs/{environment_id}/sync` (`environments_sync`), body
`{ fromEnvironmentId: string }`.

| Flag Configuration part                                  | Sync                    |
| -------------------------------------------------------- | ----------------------- |
| enabled state                                            | copied                  |
| per-Environment Default Variant                          | copied                  |
| available Variants                                       | copied                  |
| baseline rollout percentage                              | copied                  |
| salt                                                     | copied (unlike Promote) |
| ordered Targeting Rules with conditions and Segment refs | copied                  |
| per-rule percentage rollouts                             | copied                  |
| live Run, Activation bindings                            | never copied            |

Promotion keeps the target's salt because adopting the source's salt reshuffles Entities already
bucketed in the target. A Temporary Environment has no Entities worth keeping and exists to
reproduce the source, so Sync copies it: a Targeting Key lands in the same rollout bucket as in the
source. A Flag the source serves through a live Run serves its own configuration in the copy;
agents target a specific Variant to test a treatment.

- **Every Flag is written**, so the target matches the source. A Flag with no source configuration
  gets the initial configuration Environment create already provisions. Consistency is per Flag:
  Sync is not an atomic snapshot of the source, so a source edit made during a Sync may or may not
  be included, and the next Sync converges.
- **Bounded.** Before any write, Sync (and create with `temporary`) refuses an App with more than
  500 Flags with `SYNC_LIMIT_EXCEEDED`. The limit rises only with a load test at the new size that
  shows Sync and its retry completing inside one invocation.
- **Same write path.** Writes go through the same config-store path as Promotion, in the same
  bounded batches as Environment create. Each changed Flag Configuration gets a change-log row
  attributed to the caller.
- **Idempotent.** Repeating Sync converges. A partial failure returns `ENVIRONMENT_SYNC_INCOMPLETE`,
  and retrying the same request is the recovery; the size limit keeps a retry inside the budget the
  first attempt had.
- **Target and source.** The target must be a Temporary Environment, otherwise
  `ENVIRONMENT_KIND_UNSUPPORTED`. The source may be any Environment in the App, permanent or
  temporary, except the target itself (`VALIDATION_ERROR`).

Returns `{ ...Environment, syncedFlags: number }` with `temporary.syncedFromEnvironmentId` and
`temporary.syncedAt` updated.

## Credentials

- The Client Key is provisioned at create, as for any Environment. API Keys come from the existing
  `api_keys_create`; there is no second minting path. Every credential minted in a Temporary
  Environment, including after rotation, expires with it.
- `CredentialCacheKV` gains payload version 3, identical to version 2 plus
  `expiresAt: ISO datetime | null`, required and validated with an explicit UTC or numeric offset.
  The credential cache writer Durable Object derives the version and
  expiry from the D1 Environment row, never from its caller: a Temporary Environment's credential is
  always written as version 3 with the Environment's expiry, and everything else keeps version 2. It
  refuses an active entry for an expired Temporary Environment.
- Evaluation and Event Ingest readers accept versions 1, 2, and 3. After checking the terminal
  revocation marker and before rate limiting, they reject a credential whose `expiresAt` has passed
  with `410 ENVIRONMENT_EXPIRED`, whose `details.expiredAt` is an ISO datetime. The rejection is not
  billed. A v3 entry with an invalid `expiresAt` fails schema parsing through the existing invalid
  blob 5xx response and Worker fault path. Once teardown revokes the credential, the
  terminal marker wins and the response becomes `CREDENTIAL_REVOKED`.
- Every route that authenticates a Client Key or API Key applies the check: evaluate, evaluate-all,
  OFREP, verify, peek, exposures, Metric Events, activations, and registered integration key routes.
  The shared credential-authentication step also covers future routes. There is no Web Events route.
- The primary SDK maps a `410` body with `ENVIRONMENT_EXPIRED` to `reason: ERROR`,
  `errorCode: ENVIRONMENT_EXPIRED`. OpenFeature uses `GENERAL` and includes `ENVIRONMENT_EXPIRED`
  in the message. Both log once per client and never retry. SDK versions before this
  change fold `410` into `SERVICE_UNAVAILABLE`: still a loud error, not a silent default.

## Permission

Pending SPL-772. SPL-770 uses the existing permissions and role gates; it adds no PAT permission,
route opt-in marker, or temporary-only narrowing.

`temporary_environments` joins the closed PAT permission set:

| permission               | allows                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `temporary_environments` | The lifecycle of Temporary Environments: create, rename, Sync, Flag Configuration, Promotion into them, SDK keys, delete |

It never authorizes a write to a permanent Environment, an App-level resource (Flags, Variants,
Segments, Event Definitions, Metrics), or a stored Approval Request. Existing permissions keep
their meaning on Temporary Environments: `write` can create and configure them, `credentials` can
mint their keys, `delete` can delete them.

**Route opt-in.** A route contract may declare `temporaryEnvironment: true`. These routes opt in:

| operation                                                         | Environment checked                          |
| ----------------------------------------------------------------- | -------------------------------------------- |
| `environments_create`                                             | body `temporary`                             |
| `environments_update`, `environments_delete`, `environments_sync` | path `environmentId`                         |
| `flag_config_update`, `flag_targeting_rules_replace`              | path `environmentId`                         |
| `flags_promote`                                                   | path `targetEnvironmentId`, the write target |
| `client_key_get`, `client_key_update`, `client_key_rotate`        | path `environmentId`                         |
| `api_keys_create`, `api_keys_revoke`                              | path `environmentId`                         |

Registry validation fails at module load when an opted-in route other than `environments_create`
has no Environment path parameter. `flags_promote` reads its source from the body; reading a
source is already permitted to any token that can read the App.

**Enforcement.**

1. `narrowPersonalAccessTokenForRoute` keeps the existing path when the token carries the route's
   declared permission on the target. Otherwise, for an opted-in route, a token carrying
   `temporary_environments` on the target is narrowed to that permission's scopes and marked
   temporary-only.
2. The shared path-selector resolution step loads the checked Environment row for a temporary-only
   principal, whether the selector is a key or a canonical id and with or without `?by=id`, and
   refuses a permanent or foreign-App Environment with `FORBIDDEN`: "personal access token needs
   `<permission>` permission for `app:<id>`; `temporary_environments` covers only Temporary
   Environments". Enforcement lives in this one seam, never in individual handlers.
3. `environments_create` is the one body-dependent case: a temporary-only principal must send
   `temporary`, checked in the create handler and covered by a contract test.
4. `narrowPersonalAccessTokenForOperation`, which re-authorizes a stored Approval Request at Review,
   never takes the temporary-only path. Temporary Environments never have Approval Requests, so a
   temporary-only token can neither apply nor decline one, including a permanent-Environment
   proposal a login session created.

Role gates are unchanged. Creating needs App `admin` and deleting needs App `owner`, as today. A
typical agent token is `--grant app:<app_id>:owner:temporary_environments`: full read, and writes
only inside Temporary Environments. `principal_capabilities_get` reports the new permission.
Issuing or widening a token with it follows the existing step-up rules: adding any permission is
widening.

## Teardown

Teardown is one idempotent cascade, used by the scheduled job and by `environments_delete` on a
Temporary Environment. The `environments` row is its durable manifest: while the row exists,
teardown is pending. The Config Store writer durably records each projection key before publishing
it, so teardown can rediscover external state even after another operation deletes the Flag's D1 rows.

1. **Fence.** `environments_delete` sets `expires_at` to now inside the Environment's Config Store
   writer, so the read-only rule, the App-wide skip, and the credential-writer refusal apply before
   anything is removed. The scheduled job starts only after `expires_at`, when the fence already
   holds.
2. **Credentials.** Revoke every credential (terminal markers and tombstones) and delete the
   credential rows, as Environment delete does today.
3. **KV and Durable Object state.** Enumerate projection keys from the Environment's Config Store
   writer's durable journal and delete every key, including per-Flag configuration projections,
   evaluation snapshots, and the activation configuration entry. Only Temporary Environments have
   this journal. The writer derives the kind from the stored Environment row inside its mutation
   queue before any publication, including the create-time Sync copy; a failed lookup never permits
   an unjournaled write. Every Temporary Environment publication records its key before the KV write.
   Permanent Environments write no journal entries or per-publication journal storage operations.
   Ordinary deletion in a Temporary Environment retains journal entries; a stale entry only causes an
   idempotent delete. Clear the journal and Config Store snapshot revision state together only after
   every KV deletion succeeds. This dedicated operation is allowed only for an expired Temporary
   Environment and does not depend on surviving Flag or Flag Configuration rows. The ordinary Flag
   deletion path keeps its guard against deleting a snapshot whose D1 configuration exists.
4. **Exposure status.** Run the existing Exposure-status cleanup.
5. **D1 configuration.** Delete Targeting Rules, then Flag Configurations.
6. **Row.** Delete the `environments` row last.

The permanent-Environment `RESOURCE_NOT_EMPTY` blockers do not apply. A failed step leaves the row,
and the next run repeats from step 2; every step tolerates work already done.

Credential cache entries keep the expiry they were written with; shortening `expires_at` does not
rewrite them. A teardown the cron starts on its own runs only after that original expiry, so its
keys are already rejected. A manual delete is the one case where keys can still be live when
teardown runs, including when the cron finishes a manual delete that failed, so
`environments_delete` returns `{ deleted: true }` only after the whole cascade completes. If it fails
after step 1, it returns `SERVICE_UNAVAILABLE` with `retryAfterMs`, the Environment stays read-only,
and its keys keep authenticating until a retry completes step 2: the caller's retry, or the cron,
which picks it up because `expires_at` has passed but serves expired Environments oldest first, so a
backlog or repeated failures delay it.

The minute cron tears down up to 5 expired Temporary Environments per tick, oldest expiry first, so
with no older expired backlog, 50 that expire together are gone within 10 minutes; each 5 ahead of
them in the queue adds a minute. It logs `temporary-environment-teardown` with
the Environment id and counts, and reports a failure as `temporary_environment_teardown_failed`
through the Worker fault reporter. Past the original expiry, a slow teardown costs only storage.

Data retention: D1 rows, KV entries, and Durable Object state go at teardown. Credential terminal
markers stay, as for any revoked credential. Exposures, Metric Events, and Web Events written under
the Environment age out under their datasource TTLs, as for any deleted Environment. Change-log
rows follow the change-log retention.

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

Control Panel, implemented by SPL-771: the environment switchers list Temporary Environments in
their own group with their expiry, and every page scoped to one shows its expiry and named Sync
source. A deleted source is shown as unavailable without exposing its ID. The Policy editor and
Experiment creation are unavailable there, with the reason stated. Both reuse existing components
and treatments. Creating and Sync stay CLI and MCP operations in this release.

## Errors

| code                                   | status | outcome                | details                                                                                             |
| -------------------------------------- | ------ | ---------------------- | --------------------------------------------------------------------------------------------------- |
| `ENVIRONMENT_EXPIRED`                  | 410    | `user_action_required` | `{ environmentId, expiredAt, recommendedAction: "CREATE_TEMPORARY_ENVIRONMENT" }`                   |
| `ENVIRONMENT_KIND_UNSUPPORTED`         | 409    | `non_retryable`        | `{ environmentId, temporary: boolean, attemptedOp }`                                                |
| `TEMPORARY_ENVIRONMENT_LIMIT_EXCEEDED` | 409    | `user_action_required` | `{ appId, limit, active, nextExpiresAt, recommendedAction: "DELETE_TEMPORARY_ENVIRONMENT" }`        |
| `SYNC_LIMIT_EXCEEDED`                  | 409    | `non_retryable`        | `{ appId, limit, flags }`                                                                           |
| `ENVIRONMENT_SYNC_INCOMPLETE`          | 503    | `retryable`            | `{ environmentId, fromEnvironmentId, applied, failed, failedFlagIds /* first 50 */, retryAfterMs }` |

## Storage

One additive D1 migration:

| Table                | Column                       | Type        | Constraints                                      |
| -------------------- | ---------------------------- | ----------- | ------------------------------------------------ |
| `environments`       | `expires_at`                 | timestamptz | null = permanent; indexed for teardown           |
| `environments`       | `synced_from_environment_id` | text        | no FK; non-null exactly when `expires_at` is set |
| `environments`       | `synced_at`                  | timestamptz | non-null exactly when `expires_at` is set        |
| `flag_change_events` | `temporary_environment`      | integer     | not null, default 0; 1 when written for one      |

`CredentialCacheKV` gains version 3 (see Credentials).

## Rollout

1. The D1 migration is additive; existing rows read as permanent.
2. Creation, expiry, teardown, the fence, and the Sentry skip ship in one release, so the first
   Temporary Environment is born with every safeguard in place. Permanent credentials stay v2, so
   the only reader/writer window is inside that deploy: the production deploy runs the Control
   Plane before Evaluation, and a Temporary Environment created in between has keys an older
   Evaluation reader cannot parse. It fails closed with a server error, never falls back to a
   non-expiring read, and the keys work once Evaluation finishes deploying. Event Ingest deploys
   first, so it never sees the window. No existing key changes shape.
3. Once creation ships, rolling the Control Plane back past that release is forbidden while any
   Temporary Environment exists: an older writer would mint non-expiring v2 credentials and an
   older cron would not tear down. Delete every Temporary Environment first if a rollback is
   unavoidable.

Each production deploy and the production migration need explicit approval.

## Slices

Three slices. The first ships the whole lifecycle because creation is unsafe without expiry,
teardown, the fence, and the Sentry skip, and Sync reuses the create copy path. The other two are
blocked by it and can run in parallel; their footprints are disjoint.

1. **[SPL-770](https://linear.app/zaks-io/issue/SPL-770), lifecycle implemented. Agents create, Sync, and use expiring
   Temporary Environments with temporary keys.** The D1 migration, create and Sync, credential cache
   v3 with the data-plane expiry check and SDK mapping, every `ENVIRONMENT_KIND_UNSUPPORTED` refusal,
   the live and Sync limits, expired-is-read-only, the Config Store fence and the App-wide skip, the
   change-log kind with the Sentry skip, the attention rollup exclusion, teardown on delete and on
   the cron, CLI and MCP.
2. **[SPL-771](https://linear.app/zaks-io/issue/SPL-771), pending. App-level views and the Control Panel
   treat Temporary Environments as scratch** (blocked by SPL-770; split for size). Stale and
   expired Flag and inventory health exclusions; the switcher group, expiry and Sync source,
   and unavailable Policy and Experiment affordances.
3. **[SPL-772](https://linear.app/zaks-io/issue/SPL-772), pending. A PAT with `temporary_environments` can
   manage Temporary Environments and nothing permanent** (blocked by SPL-770; split for risk and
   authority). Permission enum, route opt-in marker and registry validation, narrowing, the
   path-selector enforcement, the create-body check, the approval exclusion, capabilities,
   `--grant`.

| Section                                   | Slices                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| [Glossary additions](#glossary-additions) | SPL-770                                                                          |
| [Environment shape](#environment-shape)   | SPL-770                                                                          |
| [Rules](#rules)                           | SPL-770; SPL-771 (stale, expired, and inventory health exclusions)               |
| [Create](#create)                         | SPL-770                                                                          |
| [Sync](#sync)                             | SPL-770                                                                          |
| [Credentials](#credentials)               | SPL-770                                                                          |
| [Permission](#permission)                 | SPL-772                                                                          |
| [Teardown](#teardown)                     | SPL-770                                                                          |
| [Surfaces](#surfaces)                     | SPL-770 (CLI, MCP); SPL-771 (Control Panel)                                      |
| [Errors](#errors)                         | SPL-770                                                                          |
| [Storage](#storage)                       | SPL-770                                                                          |
| [Rollout](#rollout)                       | SPL-770                                                                          |
| [Done](#done)                             | SPL-770; SPL-771 (stale, expired, and inventory bullet); SPL-772 (token bullets) |

## Done

These are full-design acceptance criteria. The temporary-only token criteria require SPL-772;
the stale, expired, inventory, and Control Panel criteria require SPL-771. SPL-770 uses tokens with
the existing lifecycle permissions.

- From a clean checkout with only `SPLITCH_TOKEN` set to a token granted
  `app:<id>:owner:temporary_environments`, an agent runs `envs create --temporary --from prod`,
  `api-keys create`, and a local server against the new keys. Every Flag not controlled by a live
  Run in `prod` resolves as it does in `prod` for the same Evaluation Context, rollout buckets
  included.
- The same agent flips a Flag in its Temporary Environment and sees the new value through both
  keys, while `dev` and `prod` are unchanged.
- `envs sync --from dev` makes `flags get` in the Temporary Environment match `dev` for every Flag.
- The same token is refused with `FORBIDDEN` naming the missing permission when it edits a Flag
  Configuration, replaces Targeting Rules, rotates a key, or promotes into `dev` or `prod`, through
  both the CLI and MCP, by key, by canonical id, and with `?by=id`. It is refused on another App's
  Temporary Environment. It can promote from `prod` into its own Temporary Environment.
- The same token can neither apply nor decline a pending `prod` Approval Request created by a login
  session, for Flag Configuration, Targeting Rule, and Promotion proposals.
- A token with `write` and `credentials` but not `temporary_environments` manages Temporary
  Environments exactly as before, a grant mixing `temporary_environments` on one App with `write`
  on another resolves per App, and a login session is unaffected.
- From `expiresAt` until teardown, both keys get `410 ENVIRONMENT_EXPIRED` on evaluate,
  evaluate-all, OFREP, verify, peek, exposures, Metric Events, activations, and registered integration
  key routes, from
  the SDK and raw HTTP; a key rotated before expiry behaves the same. After teardown they get
  `CREDENTIAL_REVOKED`.
- With no older expired backlog, 50 Temporary Environments that expire together are gone from
  `envs list` within 10 minutes. A
  teardown made to fail after each step completes on a later tick with nothing left in D1, KV, or
  Config Store state. A manual delete made to fail between the fence and credential revocation
  returns `SERVICE_UNAVAILABLE`, and its keys stop authenticating once a retry completes
  credential revocation, including when the cron reaches it behind a backlog of older expired
  Environments.
- Creating a Flag, editing a Segment a Temporary Environment uses, and editing a Variant's value
  all succeed while an expired Temporary Environment waits for teardown, including one that expires
  mid-operation. Deleting a Flag removes its configuration there too. Deleting a Variant that only
  that Environment's Targeting Rules reference is refused naming it, and succeeds after
  `envs delete`.
- Experiment creation, Policy edits, a winner Promotion targeting a Temporary Environment, and a
  Convex or Cloudflare installation with its credential fail with `ENVIRONMENT_KIND_UNSUPPORTED`.
  The 51st live Temporary Environment fails with `TEMPORARY_ENVIRONMENT_LIMIT_EXCEEDED`, and an App
  with 501 Flags fails create and Sync with `SYNC_LIMIT_EXCEEDED` before any write.
- Flag changes in a Temporary Environment appear in its change log and never reach a Sentry
  installation, including changes made just before teardown.
- An App with 200 permanent Environments and 50 Temporary Environments gets the same attention
  rollup as without them, never `ATTENTION_FANOUT_LIMIT_EXCEEDED`.
- Implemented by SPL-771: stale and expired Flag lists and inventory health are byte-identical
  after creating 50 Temporary Environments, including divergent configuration and Sync history.
