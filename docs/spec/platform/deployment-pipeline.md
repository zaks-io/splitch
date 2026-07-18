# Deployment pipeline: PR CI, shared preview, production release, rollback

Status: CI, local gates, shared-preview deploy and smoke, production deploy wiring, Worker secret
sync, and Cloudflare D1/KV resource provisioning are in place. Shared-preview reset, production
smoke, and rollback are still designed, not wired.
Vocabulary follows [CONTEXT.md](../../../CONTEXT.md). This document uses **platform target** for
CI/deployment targets such as local, PR CI, shared preview, and production. A platform target is not a
splitch product **Environment** under an App.

## Decision

Use GitHub Actions on Blacksmith runners as the orchestrator, except `sdk-publish`, which must run on
GitHub-hosted infrastructure for npm trusted publishing. Use Turborepo as the monorepo task graph
and task-output cache, Wrangler as the Cloudflare source of truth, and Tinybird CLI deployments for
analytics resources. Every non-doc PR gets local validation against disposable CI services. Hosted
preview is a single shared target updated on demand. Production releases are queued, approval-gated
GitHub deployments that run migrations as part of the release, not as a side manual step.

The scaffold has the `ci` workflow (with a range-scoped Gitleaks secret-scan step), the
`deploy-shared-preview` workflow, the `deploy-production` workflow, Turborepo task graph, package
scripts, Lefthook hooks, and Wrangler configs. The deploy workflows do not synthesize Cloudflare
resources at deploy time; D1 databases and shared KV namespaces are provisioned and committed as
Wrangler source-of-truth config. Worker secret values stay in GitHub environments and Cloudflare
Worker secrets, then sync from environment variables immediately before each Worker deploy.

Do not use Cloudflare dashboard edits as the source of truth. Wrangler config, Tinybird project
files, and GitHub environment settings are the release contract.

## Platform targets

| Target           | Purpose                                       | Resource shape                                                                            | Approval                                 |
| ---------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------- |
| `local`          | Developer loop and CI unit/integration checks | Local Wrangler storage simulation, Tinybird Local, fixture data                           | none                                     |
| `pr-ci`          | Required PR validation                        | Local Wrangler storage simulation, Tinybird Local, fixture data                           | none                                     |
| `shared-preview` | One hosted preview to share on demand         | Persistent non-production Cloudflare resources plus one Tinybird Branch                   | maintainer-triggered                     |
| `production`     | Customer-serving platform                     | Persistent Cloudflare resources, Tinybird Cloud main workspace, production routes/domains | GitHub `production` environment approval |

PRs do not get hosted previews by default. The shared preview target is intentionally mutable and
single-tenant: when a maintainer deploys a branch or PR there, it replaces the previous preview.

Local and `pr-ci` both run the local API Worker smoke from
[agent-verification.md](./agent-verification.md). That proves Workers boot and route contracts pass
against local bindings. It does not prove hosted bindings, Cloudflare service bindings, Tinybird Cloud,
routes, DNS, or GitHub environment configuration.

## Runner policy

- All GitHub Actions jobs use Blacksmith runner tags, starting with `blacksmith-2vcpu-ubuntu-2404`,
  except `sdk-publish`. npm trusted publishing supports GitHub-hosted runners, not Blacksmith, so that
  release-published workflow uses `ubuntu-24.04` and must not receive an npm token.
- Use larger Blacksmith Linux runners only for measured bottlenecks, for example large build or test
  shards.
- Keep upstream cache actions such as `actions/cache` and `actions/setup-node`; Blacksmith redirects
  standard caches without workflow-specific cache forks.
- Every repository that uses `runs-on: blacksmith-*` must have the Blacksmith GitHub App installed.
  Otherwise jobs can be adopted by runners provisioned for another repo in the org.

## Turborepo cache policy

Root scripts call `turbo`, not `pnpm -r`, once the package scaffold lands. CI uses two cache layers:
pnpm package-store caching through standard GitHub cache actions on Blacksmith, and Turborepo remote
caching for task outputs.

Required Turbo shape:

- PR CI runs `turbo run lint typecheck test build --affected` with enough git history for affected
  detection.
- Deploy jobs build the exact deployable graph with `turbo run build --filter=<workspace>...` before
  Wrangler deploys that Worker or app.
- `build` tasks depend on `^build` and declare outputs such as `dist/**`, `.output/**`, build cache
  directories, and generated Worker bundles. Outputs are per package, not one root catch-all.
- `lint`, `typecheck`, and unit-test tasks are cacheable when their inputs and environment variables
  are declared. Coverage output is cacheable only for deterministic test jobs.
- `dev` is `cache: false` and `persistent: true`.
- Provisioning, deploy, migration, preview cleanup, `wrangler`, and `tb deploy` tasks are `cache:
false`. Anything that mutates Cloudflare, Tinybird, GitHub deployments, or secrets is never served
  from cache.
- `globalEnv` and task-level `env` list every environment variable that changes build output, including
  public app URLs and platform target names. Missing env declarations can produce preview/prod cache
  cross-contamination.
- CI sets `TURBO_TOKEN`, `TURBO_TEAM`, and `TURBO_REMOTE_CACHE_SIGNATURE_KEY` for signed remote cache.
  Secrets used only by deploy/provision tasks are not part of cacheable task outputs.
- Debugging starts with `turbo run <task> --dry-run=json` to inspect the task graph, inputs, outputs,
  and cache hits before changing workflow YAML.

## Required GitHub workflows

| Workflow                | Trigger                                             | Concurrency                      | Required result                                                                                                                                                              |
| ----------------------- | --------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci`                    | PR and push to main                                 | cancel in-progress per branch/PR | wired: `verify:ci`, format, lint, typecheck, test, build, dependency-cruiser, jscpd, Knip, Gitleaks, local D1/Tinybird checks                                                |
| `deploy-shared-preview` | manual dispatch                                     | `shared-preview-deploy`, queued  | wired: deploy selected ref to the one hosted preview target through Tinybird Branch build, D1 migrations, Turborepo Worker deploy tasks, and hosted smoke                    |
| `reset-shared-preview`  | manual dispatch                                     | `shared-preview-deploy`, queued  | not wired: restore shared preview to the default branch or clear preview data                                                                                                |
| `deploy-production`     | successful `ci` workflow on `main`, manual dispatch | `production-deploy`, queued      | wired: exact-SHA validation, optional manual `verify:ci`, Tinybird production deploy, D1 migrations, Turborepo Worker deploy tasks, and Linear release sync                  |
| `rollback-production`   | manual dispatch                                     | `production-deploy`, queued      | not wired: Worker rollback or roll-forward runbook execution                                                                                                                 |
| `sdk-release`           | manual dispatch                                     | `sdk-release`, queued            | wired: validate `@splitch/sdk`, prepare release artifacts, create or update draft GitHub Release for `sdk-v<version>`; does not publish to npm                               |
| `sdk-publish`           | published GitHub Release                            | `sdk-publish`, queued            | wired: validate fresh public repository/release/remote-tag SHA evidence immediately before GitHub-hosted npm trusted publishing with provenance, or skip an existing version |

External fork PRs run CI only. Deploying any branch to shared preview requires a maintainer-triggered
workflow that runs trusted workflow code with repository secrets.

### SDK publish bootstrap prerequisite

`@splitch/sdk` cannot use npm trusted publishing until the package already exists on npm. Before the
first stable `sdk-v0.1.0` release, a human with npm organization write access and 2FA must explicitly
approve and perform this one-time bootstrap outside `sdk-publish`:

1. Manually release only the disposable prerelease `@splitch/sdk@0.1.0-bootstrap.0` with dist-tag
   `bootstrap`; do not consume `0.1.0`, `latest`, or the stable release tag. This bootstrap package
   does not carry the stable release's provenance claim.
2. Configure the package's sole trusted publisher for `zaks-io/splitch`, workflow
   `sdk-publish.yml`, and the `npm publish` action. Verify the configured provider before proceeding.
3. Revoke every temporary bootstrap token and publishing grant, then set the npm package's Publishing
   Access to disallow token-based publishing. Retain provider evidence for the revocation and package
   setting. The normal `sdk-publish` path has no npm token and must remain OIDC-only.

Provider setup is intentionally not verified by repository code or this workflow. A missing or
mismatched trusted publisher makes the stable release fail closed at `npm publish`; it is a human
approval/setup blocker, not a reason to add a long-lived token.

The operational procedure, including the required tag ruleset and immutable-release setup, is in
[sdk-release.md](./sdk-release.md).

## Cloudflare resource contract

Wrangler config is the source of truth. Use `wrangler.jsonc` for each deployable Worker and checked-in
named environment blocks for `shared-preview` and `production`. Do not deploy the root Worker
accidentally; every deploy must specify a platform target.

Public hostnames and per-Worker routes are fixed by
[ADR-0038](../../adr/0038-public-hostnames-are-a-fixed-human-owned-subdomain-map.md) on the
`splitch.dev` zone (subdomain per surface; Analysis is internal, no public host). Generate
`wrangler.jsonc` routes from that table — do not invent hostnames.

Workers that own the full hostname use Wrangler Custom Domains:
`{ "pattern": "<hostname>", "custom_domain": true }`. Cloudflare creates the DNS record and edge
certificate for those Custom Domains after deploy. Do not hand-create DNS records for these Worker
hostnames. Plain Workers Routes are a different mechanism and require a pre-existing proxied DNS
record; they are not the default for splitch's public Workers.

Per-Worker configs must declare only the bindings owned by that Worker:

| Worker                   | Binding rule                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Control Plane API Worker | D1 system-of-record binding, KV config/credential cache bindings, live-update Durable Object binding                                                   |
| MCP Worker               | No D1, KV, Tinybird, or Durable Object data bindings; calls public APIs by origin and Analysis by service binding through `@splitch/control-plane-sdk` |
| Evaluation Worker        | Provider/config KV, Assignment Store KV/DO, Event Ingest service binding                                                                               |
| Event Ingest Worker      | Queue, sharded ingest/dedup Durable Objects, Tinybird write secret                                                                                     |
| Analysis Worker          | Tinybird read secret; no SDK evaluate or ingest bindings                                                                                               |
| Auth API Worker          | Auth/session/token bindings only; no post-create App management bindings                                                                               |
| Control Panel Worker     | UI/session/client bindings only; no direct D1/KV/Tinybird access                                                                                       |
| Marketing Worker         | Static/public bindings only; no authenticated App data                                                                                                 |
| Scheduled jobs           | Cron triggers stay on owning Workers: Control Plane API demo cleanup and Analysis snapshot refresh                                                     |

### Shared Cloudflare preview

Shared preview is provisioned once and updated on demand:

1. Maintain one shared-preview D1 database, KV namespace set, Durable Object namespace set, Worker fleet,
   and Tinybird Branch.
2. Use the checked-in Wrangler `shared-preview` environment blocks with binding IDs, preview vars,
   service bindings pointing at shared-preview Worker names, and no production routes.
3. Apply D1 migrations to the shared-preview D1 database before Worker deployment.
4. Deploy Workers through Turborepo package deploy tasks that call
   `wrangler deploy --env shared-preview --secrets-file <temp-file>` when the Worker declares required
   secrets.
5. Run smoke checks against the shared-preview URL.
6. Post the shared-preview URL, deployed ref, Tinybird branch name, migration list, and smoke results to
   the PR or workflow summary.

Shared-preview smoke is the first proof that hosted bindings are correct. Each smoke result must
include the URL, expected `platformTarget = "shared-preview"`, deployed commit SHA, migration list,
Tinybird Branch, and which routes were exercised.

The smoke summary must also include Cloudflare-to-Axiom verification when Worker observability wiring
changes. Use a unique smoke `User-Agent` value, wait for the destination ingestion delay, and query the
shared Axiom `cloudflare` dataset for the same time window:

```apl
['cloudflare']
| where ['resource.cloudflare.script_name'] startswith "splitch-"
| where ['resource.cloudflare.script_name'] endswith "-shared-preview"
| where ['attributes.user_agent.original'] == "<unique-smoke-user-agent>"
| summarize count() by ['resource.cloudflare.script_name'], ['attributes.server.address']
| order by ['resource.cloudflare.script_name'] asc
```

The verification passes only when the grouped result includes the shared-preview Worker scripts hit by
the smoke. For the full SPL-88 surface check, include `splitch-marketing-shared-preview`,
`splitch-control-panel-shared-preview`, `splitch-control-plane-api-shared-preview`,
`splitch-auth-api-shared-preview`, `splitch-evaluation-api-shared-preview`,
`splitch-event-ingest-api-shared-preview`, `splitch-mcp-server-shared-preview`, and
`splitch-analysis-api-shared-preview`.

`wrangler versions upload` is useful for code-only preview URLs, but it is not the default for shared
preview because Worker versions do not cover D1/KV/DO state, and Durable Object migrations are not
supported by version upload. Use `wrangler deploy` for shared preview when it includes stateful resources
or any Durable Object migration.

### KV namespaces

- One namespace per binding role per platform target. Shared preview gets its own namespaces.
- KV namespace IDs may be committed in generated CI artifacts or config. KV contents and secrets are
  not committed.
- Local dev uses local KV simulation by default. Remote KV bindings are opt-in because writes affect
  real preview or production resources.
- Reset clears or reseeds shared-preview keys. It does not delete production or local namespaces.

### D1 migrations

- D1 migrations are committed SQL generated from the schema toolchain, expected to be Drizzle when the
  package scaffold lands.
- CI runs migrations locally before tests.
- Shared preview applies migrations remotely to the shared-preview D1 database before Worker deployment.
- Production applies migrations remotely as part of `deploy-production`, after approval and before code
  that requires the new schema is serving traffic.
- Production D1 recovery follows the [recovery policy and runbook](#production-d1-recovery-policy-and-runbook).
  Its private R2 export provisioning is a separate, approval-gated slice; normal deploy workflows do
  not create recovery resources or initiate backup, export, restore, or Time Travel actions.
- Failed migrations roll back the failed migration and leave prior successful migrations applied.
- Schema changes follow expand/contract. Additive migrations and backward-compatible reads ship first;
  destructive cleanup ships in a later release with an explicit runbook.

### Durable Object migrations

- New Durable Object classes use SQLite-backed Durable Objects and `new_sqlite_classes`.
- Durable Object migration tags are monotonic and live in the Worker Wrangler config for the platform
  target being deployed.
- Environment-level Wrangler migrations override top-level migrations, so generated platform configs must
  carry the correct migration list.
- Worker code changes inside an existing Durable Object class do not require a Durable Object migration,
  but stored-data format changes must stay backward-compatible with existing objects.
- Worker rollback is not a data rollback. A release with Durable Object migrations is roll-forward first.

### Secrets

- GitHub stores separate preview and production secrets. Production secrets are only available to jobs
  using the GitHub `production` environment after its protection rules pass.
- Cloudflare deploy tokens are scoped as tightly as Cloudflare supports. Prefer separate preview and
  production API tokens.
- Runtime secret names are declared in Wrangler config with `secrets.required`.
- Worker deploy scripts read each Worker's `secrets.required` list and pass available secret values
  through a temporary JSON file to `wrangler deploy --secrets-file`. The deploy uploads code and
  secrets into the same Worker version, so there is no separate pre-deploy secret edit that can fail
  when the latest Worker version is not currently deployed. CI sets
  `SPLITCH_REQUIRE_WORKER_SECRET_ENV=1` so missing environment values fail loudly. Local deploys may
  reuse already-attached Worker secrets when the environment value is not present.
- `scripts/sync-worker-secrets.mjs` is for manual version-only secret uploads. It uses
  `wrangler versions secret bulk --env <target>` and does not serve the created version to traffic.
- The Auth API declares `WORKOS_CLIENT_ID` and `WORKOS_API_KEY` as required hosted Worker bindings so
  hosted device flow cannot silently fall back to the local fixture adapter. `WORKOS_CLIENT_ID` is a
  GitHub environment variable, not a repository-committed Wrangler value.
- Event Ingest declares `SPLITCH_EVENT_INGEST_TOKEN`, `TINYBIRD_INGEST_TOKEN`, and the least-privilege
  `TINYBIRD_RAW_EVALUATIONS_INGEST_TOKEN` as required Worker secrets. The first Tinybird token appends
  Exposure/Activation rows; the second appends only `raw_evaluations`. `TINYBIRD_API_URL` is non-secret
  Worker config and points at the Tinybird region API.
- Secret rotation is its own release. Do not hide secret changes inside an unrelated code deploy.

### Sentry source maps

- Every deployable Worker Wrangler config enables `upload_source_maps` so Cloudflare can remap Worker
  stack traces from uploaded source maps.
- Worker package deploy scripts call `scripts/deploy-worker-with-sentry.mjs`, which runs
  `wrangler deploy` with `.wrangler/sentry` as the bundle outdir, injects `SENTRY_RELEASE`, creates
  the matching Sentry release when it does not already exist, and uploads
  that bundle directory to Sentry with `sentry-cli sourcemaps upload`.
- Production pins `SENTRY_RELEASE` to the exact deployed commit SHA and passes the same value to
  Linear Release as its version. A validation step requires the Linear access key before any
  production mutation. The Linear sync runs in a separate post-deploy job with no production
  credentials, so one immutable release ID joins the deployed code, Sentry events, source maps, and
  Linear issues discovered from the deployed commit range without exposing deploy secrets to the
  release action.
- `SENTRY_RELEASE` is non-secret deploy metadata. It is injected at deploy time, not committed in
  Wrangler `vars`.
- Sentry upload credentials are CI-only and must not become Worker runtime secrets. Shared-preview
  and production deploy jobs require `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT` before
  deploy. `SENTRY_ORG` and `SENTRY_PROJECT` may be GitHub variables or secrets; prefer variables
  because they are slugs, not credentials.

## Tinybird policy

PR CI uses Tinybird Local, not Tinybird Cloud Branches. Run Tinybird Local as a GitHub Actions service
container, build the project locally, load fixture data, and run endpoint/data-quality tests. This is
the right PR default because it is fast, disposable, parallelizable, and does not consume Tinybird Branch
quota.

Tinybird Local is not a live snapshot. It should not be used as evidence that production data,
connectors, branch tokens, or shared preview URLs work. When a change needs production-like data,
connector validation, or a URL that humans can inspect together, deploy the selected ref to the shared
preview target.

Shared preview uses one Tinybird Branch named `shared_preview`, created with `--last-partition` when
production-like data is useful. That attaches the latest production partition without copying the
underlying data and keeps writes, deletes, and schema changes isolated to the branch.

Tinybird's default branch limit is 4 branches including `main`. With one shared preview branch, PR
throughput is no longer constrained by this limit. The default shared-infra branch budget remains enough
for `main` plus `shared_preview`, with two spare branches for temporary manual investigations.

Tinybird flow:

1. PR CI runs `pnpm tinybird:local`, which starts disposable Tinybird Local with generated local-only
   tokens, runs `tb build` through `tinybird.config.json` (`dev_mode=local`), runs tests when present,
   and removes the Local container. Trusted PR workflows may also run `tb deploy --check` when
   cloud credentials are available.
2. Shared preview creates or updates `shared_preview --last-partition`, then runs `tb --branch=shared_preview build`
   and endpoint smoke tests against that branch.
3. Production release starts automatically after the `ci` workflow succeeds for a same-repository
   push to `main`, or manually from `main`. Automatic runs use the CI `head_sha`; manual runs use the
   dispatch event's `github.sha`. Both paths check out and verify that immutable release SHA. Manual
   runs execute `verify:ci` before the production gate. The deployment job then waits for the GitHub
   `production` environment, runs
   `tb deploy --check` and `tb deploy --wait` through environment-scoped `TB_TOKEN` and `TB_HOST`,
   applies D1 migrations, deploys the backward-compatible Control Plane Worker, then uses its
   CI-only backfill gate to run and verify every credential-cache v2 rewrite before deploying the
   Evaluation Worker or any v2-only billing behavior. The gate is bearer-protected by the hosted
   `SPLITCH_DEPLOY_GATE_TOKEN`, reports only migration checkpoints, and fails the release instead
   of allowing a partial rollout. Remaining Workers deploy only after that verification.
4. Destructive Tinybird deploys require explicit human approval and `--allow-destructive-operations`.
   They are not allowed in the default production deploy workflow.

Current cloud setup: Tinybird workspaces `splitch_dev` and `splitch_prod` exist. Both have the
committed datasource shape deployed and a `raw_events_ingest` APPEND token generated by the Tinybird
datafile. The `shared_preview` Tinybird Branch exists. GitHub environment secret names are present
for preview and production deploys. Worker secret values remain outside the repository and docs.

The splitch physical dedup Copy Pipe snapshot is separate from Tinybird Branch snapshots. Production
runs the scheduled Tinybird snapshot refresh on the Analysis Worker. Shared preview runs Copy Pipes on
demand for smoke tests only; it does not schedule its own hourly snapshot job by default.

## Production deploy order

Production deployments run from the default branch only. The `deploy-production` workflow starts after
the `ci` workflow succeeds on `main` and can also be manually dispatched from `main`. It validates the
exact CI head SHA before the GitHub `production` environment gate, then uses the gated job's
environment-scoped Cloudflare and Tinybird credentials. Tinybird deploys first so datafiles cannot
drift from the release path.

1. Install dependencies and run `verify:ci`.
2. Wait for GitHub `production` environment approval. Required reviewers and prevent-self-review should
   be enabled.
3. Run Tinybird deployment check with the environment-scoped production Tinybird token.
4. Deploy Tinybird to Cloud main.
5. Apply D1 migrations to production.
6. Sync Worker secrets, then deploy Workers through Turborepo package deploy tasks. The Turbo graph
   enforces service-binding order where it matters: Evaluation deploy waits for Event Ingest deploy.
7. Verify cron trigger registration on Control Plane API and Analysis Workers.
8. Run route and binding smoke checks before marking the GitHub deployment complete.
9. Record Worker version IDs, D1 migration names, Tinybird deployment URL, commit SHA, and smoke results
   in the GitHub deployment summary.
10. Sync the completed release to Linear in a separate job using the same commit SHA as Sentry.

Production smoke must assert `platformTarget = "production"` on every public Worker health or route
probe that exposes it. A production deployment is not complete if the summary lacks route-level smoke
evidence for changed Workers.

For pure code changes without Durable Object migrations, a Worker may use Worker versions and gradual
deployment. For any Durable Object migration, use `wrangler deploy`.

## Promotion rules

- Product **Promotion** of Flag Configuration between splitch product Environments remains runtime
  product behavior in the Control Plane API. It is not the same thing as a platform deploy.
- Platform code promotes PR -> main -> production. There is no direct production deploy from a PR.
- Production deploys require a green required-check set, GitHub production approval, and a deployment
  summary containing the Cloudflare/Tinybird/D1 evidence.
- Destructive data changes, secret rotations, and binding deletions require an explicit runbook and are
  separate from normal feature deploys.

## Production D1 recovery policy and runbook

Production D1 recovery has two deliberately separate windows. **D1 Time Travel** is the short-window
point-in-time recovery mechanism. It is always on for D1 databases on the supported storage subsystem;
the production plan must provide its 30-day window, and the provisioner must fail the recovery setup if
the database is not eligible. **Private R2 exports** are the longer-retention recovery mechanism.
They are recovery material, not build output, release artifacts, or a substitute for reversible
migrations.

### Recovery policy

- Roll forward is the default for a failed migration. A restore is an incident operation only when a
  compatible forward migration cannot safely correct the data or schema.
- Time Travel is the first recovery option while the required point is still within the provider's
  available window. The operator records the proposed timestamp or bookmark in the restricted
  incident record before acting. A Time Travel restore is destructive even though Cloudflare returns a
  previous bookmark that can be used to undo it.
- Longer-lived recovery points are full D1 SQL exports written only to a dedicated, private R2 bucket.
  A Cloudflare Workflow runs once every 24 hours, initiates and polls the D1 export API, then writes
  the returned export directly to R2. This sets the R2 recovery-point objective at 24 hours; the signed
  export URL is transient transport material and is never persisted, displayed, or forwarded outside
  that Workflow.
- The recovery bucket has no public `r2.dev` access, public custom domain, or public-read policy. No
  recovery object, signed URL, token, SQL content, or restore command enters GitHub, the repository,
  CI logs, deployment summaries, test artifacts, chat, or normal application logs.
- R2's provider encryption at rest and TLS in transit are the minimum transport and storage controls.
  The export path must not create a plaintext local staging file. Any future customer-managed-key or
  cross-account copy requirement needs its own security decision.
- The recovery bucket lifecycle retains each completed export for 90 days. A 90-day bucket-lock rule
  covers the recovery-object prefix, so lifecycle expiry cannot shorten the promised retention. Failed,
  partial, or unverified exports are not recovery points: they use a separate private failure prefix
  and expire after seven days. Changing the export cadence, retention, or lock rules is a production
  security change, not routine workflow maintenance.

### Access and evidence

Use separate least-privilege identities. The export Workflow may initiate/poll an export for the named
production D1 database and write to the dedicated recovery prefix. It does not receive general D1
query, restore, R2 read, list, delete, bucket-policy, or public-access authority. A restore operator
receives time-bounded, incident-only authority for the named database and recovery object; it is not
the scheduled export identity. Long-lived account-wide tokens, shared credentials, and Global API keys
are prohibited.

An export succeeds only after the Workflow records restricted, non-content evidence: database identity,
source bookmark, export run time, object key, size, checksum or ETag when available, retention/lock
configuration version, and a successful object-readability or import-readiness check. Evidence lives in
the access-controlled recovery/incident system, not in GitHub or application telemetry. The scheduled
workflow must alert on a missed, failed, or unverified recovery point; it must not silently continue.

### Restore authority and drills

Only a human incident owner may request a production restore, and a separate human with production
approval authority must approve it before the restore operation begins. Normal deploy workflows,
scheduled exports, and agents cannot restore production. The incident record must identify the target
time or recovery object, affected database, approvers, rollback/undo point, and the expected privacy
and service impact before the destructive action.

Every restore follows this runbook boundary:

1. Stop or fence the affected write path, capture restricted incident evidence, and evaluate a
   forward migration first.
2. Verify the selected Time Travel point or R2 object against its restricted evidence. Do not treat
   the existence of an export alone as recoverability proof.
3. Obtain the separate production approval, perform the restore with the incident-only identity, and
   retain the provider's undo point in the restricted incident record.
4. Before traffic or analytics resume, replay privacy deletion tombstones and validate migration state,
   tenant isolation, and the affected Worker smoke paths. This extends the privacy restore contract in
   [privacy-data-lifecycle.md](./privacy-data-lifecycle.md).
5. Record the outcome and any data-loss window in the restricted incident record, then roll forward to
   the compatible desired schema and application version.

Run restore drills at least quarterly using synthetic or non-production data. A drill must exercise
object selection, integrity/readiness verification, tombstone replay, and post-restore validation. A
drill that restores production is itself a destructive production operation and needs the same separate
human approval and incident record as a real restore. A successful export without this recoverability
evidence is not a successful recovery program.

### Follow-up implementation boundary

A separate, approval-gated provisioning slice must create the dedicated private R2 bucket, recovery
prefix, lifecycle and bucket-lock rules, scoped identities, and Cloudflare Workflow/API integration. It
must add restricted evidence storage, alerting, and automated non-production drill coverage. It must
not add R2 creation, exports, restores, recovery credentials, or a restore action to normal production
deploy workflows. The implementation must keep all production data and recovery material out of Git,
GitHub, logs, and build artifacts.

## Rollback

Worker code-only rollback:

- Use `wrangler rollback <version_id>` or deploy a previous version to 100 percent traffic.
- Cloudflare only supports rollback to recent versions, and rollback immediately changes active traffic.

Rollback limits:

- Cloudflare Worker rollback does not roll back D1, KV, Durable Object storage, queues, or Tinybird.
- Rollback can fail if bindings were deleted or modified, or if a Durable Object migration occurred
  between the current deployment and the target version.
- D1 point-in-time restore and Tinybird destructive reversal are incident procedures, not routine deploy
  rollback.

Default incident policy is roll forward unless the release is code-only and the previous Worker version
is compatible with current data.

## Implementation checklist

- [x] Add Wrangler configs for every Worker with explicit `shared-preview` and `production` platform target values.
- [x] Add `turbo.json`, package scripts, cacheable outputs, explicit env hashing, and uncached deploy/migrate
      tasks.
- [x] Add local hook wiring from [local-quality-gates.md](./local-quality-gates.md), including
      `verify:commit`, `verify:push`, Knip, and Gitleaks.
- [x] Add `deploy:shared-preview` and `deploy:production` scripts through Turborepo package tasks.
- [x] Add script for `shared-preview:smoke`.
- [ ] Add scripts for `shared-preview:reset` and `rollback:production`.
- [x] Add `deploy:production` and hook Tinybird deployment into it.
- [x] Add Tinybird project files and `tinybird.config.json` with local-mode development.
- [x] Add Blacksmith-backed GitHub workflows for CI and Gitleaks.
- [ ] Add Blacksmith-backed GitHub workflows for shared preview reset and rollback.
- [x] Add a Blacksmith-backed `sdk-release` workflow for manual SDK draft release prep.
- [x] Add a GitHub-hosted `sdk-publish` workflow for release-published npm trusted publishing with provenance.
- [x] Add a Blacksmith-backed `deploy-shared-preview` workflow.
- [x] Add a Blacksmith-backed `deploy-production` workflow for Tinybird, D1, and Worker deploy legs.
- [x] Add Cloudflare and Sentry source-map upload wiring for Worker deploys.
- [ ] Configure GitHub `preview` and `production` environments and required production reviewers.
- [x] Wire `TURBO_TOKEN`, `TURBO_TEAM`, and `TURBO_REMOTE_CACHE_SIGNATURE_KEY` into CI/deploy workflows
      for signed Turborepo remote caching.
- [ ] Seed deterministic Tinybird Local fixtures for CI and document how to refresh the shared-preview branch.

## Sources

- Cloudflare Wrangler configuration and environment docs:
  <https://developers.cloudflare.com/workers/wrangler/configuration/>,
  <https://developers.cloudflare.com/workers/wrangler/environments/>
- Cloudflare Worker source maps:
  <https://developers.cloudflare.com/workers/observability/source-maps/>
- Sentry Cloudflare Wrangler source-map upload docs:
  <https://docs.sentry.io/platforms/javascript/guides/cloudflare/sourcemaps/uploading/wrangler/>
- Cloudflare Workers custom domains and route docs:
  <https://developers.cloudflare.com/workers/configuration/routing/custom-domains/>,
  <https://developers.cloudflare.com/workers/configuration/routing/routes/>
- Cloudflare Workers versions, deployments, previews, and rollback docs:
  <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/>,
  <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/>,
  <https://developers.cloudflare.com/workers/configuration/previews/>
- Cloudflare D1 migrations and Durable Object migration docs:
  <https://developers.cloudflare.com/d1/wrangler-commands/>,
  <https://developers.cloudflare.com/d1/reference/migrations/>,
  <https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/>
- Cloudflare D1 Time Travel, export, and Workflows guidance:
  <https://developers.cloudflare.com/d1/reference/time-travel/>,
  <https://developers.cloudflare.com/workflows/examples/backup-d1/>,
  <https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/>
- Cloudflare R2 recovery-object controls:
  <https://developers.cloudflare.com/r2/reference/data-security/>,
  <https://developers.cloudflare.com/r2/buckets/bucket-locks/>,
  <https://developers.cloudflare.com/r2/buckets/public-buckets/>
- Tinybird branches, CI/CD, deployment, and limits docs:
  <https://www.tinybird.co/docs/forward/core-concepts/branches>,
  <https://www.tinybird.co/docs/forward/development-workflow/cicd>,
  <https://www.tinybird.co/docs/forward/dev-reference/commands/tb-deployment>,
  <https://www.tinybird.co/docs/forward/pricing/limits>
- GitHub Actions environments and concurrency docs:
  <https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments>,
  <https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments>,
  <https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax>
- Blacksmith runner docs:
  <https://docs.blacksmith.sh/introduction/quickstart>,
  <https://docs.blacksmith.sh/blacksmith-runners/overview>,
  <https://docs.blacksmith.sh/blacksmith-caching/dependencies-actions>
- Turborepo CI, remote cache, configuration, and environment variable docs:
  <https://turborepo.dev/docs/crafting-your-repository/constructing-ci>,
  <https://turborepo.dev/docs/guides/ci-vendors/github-actions>,
  <https://turborepo.dev/docs/reference/configuration>,
  <https://turborepo.dev/docs/crafting-your-repository/using-environment-variables>
