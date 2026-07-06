# Deployment pipeline: PR CI, shared preview, production release, rollback

Status: CI, local gates, shared-preview deploy and smoke, production deploy wiring, Worker secret
sync, and Cloudflare D1/KV resource provisioning are in place. Shared-preview reset, production
smoke, and rollback are still designed, not wired.
Vocabulary follows [CONTEXT.md](../../../CONTEXT.md). This document uses **platform target** for
CI/deployment targets such as local, PR CI, shared preview, and production. A platform target is not a
splitch product **Environment** under an App.

## Decision

Use GitHub Actions on Blacksmith runners as the orchestrator, Turborepo as the monorepo task graph
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

- All GitHub Actions jobs use Blacksmith runner tags, starting with `blacksmith-2vcpu-ubuntu-2404`.
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

| Workflow                | Trigger                                             | Concurrency                      | Required result                                                                                                                                           |
| ----------------------- | --------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci`                    | PR and push to main                                 | cancel in-progress per branch/PR | wired: `verify:ci`, format, lint, typecheck, test, build, dependency-cruiser, jscpd, Knip, Gitleaks, local D1/Tinybird checks                             |
| `deploy-shared-preview` | manual dispatch                                     | `shared-preview-deploy`, queued  | wired: deploy selected ref to the one hosted preview target through Tinybird Branch build, D1 migrations, Turborepo Worker deploy tasks, and hosted smoke |
| `reset-shared-preview`  | manual dispatch                                     | `shared-preview-deploy`, queued  | not wired: restore shared preview to the default branch or clear preview data                                                                             |
| `deploy-production`     | successful `ci` workflow on `main`, manual dispatch | `production-deploy`, queued      | wired: exact-SHA validation, optional manual `verify:ci`, Tinybird production deploy, D1 migrations, and Turborepo Worker deploy tasks                    |
| `rollback-production`   | manual dispatch                                     | `production-deploy`, queued      | not wired: Worker rollback or roll-forward runbook execution                                                                                              |
| `sdk-release`           | manual dispatch                                     | `sdk-release`, queued            | wired: validate `@splitch/sdk`, prepare release artifacts, create or update draft GitHub Release for `sdk-v<version>`; does not publish to npm            |

External fork PRs run CI only. Deploying any branch to shared preview requires a maintainer-triggered
workflow that runs trusted workflow code with repository secrets.

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
- Production D1 migration recovery policy is tracked separately in SPL-82. Do not add backup,
  export, restore, or time-travel automation until the security and retention boundaries are decided.
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
- Event Ingest declares `SPLITCH_EVENT_INGEST_TOKEN` and `TINYBIRD_INGEST_TOKEN` as required
  Worker secrets. `TINYBIRD_API_URL` is non-secret Worker config and points at the Tinybird region API.
- Secret rotation is its own release. Do not hide secret changes inside an unrelated code deploy.

### Sentry source maps

- Every deployable Worker Wrangler config enables `upload_source_maps` so Cloudflare can remap Worker
  stack traces from uploaded source maps.
- Worker package deploy scripts call `scripts/deploy-worker-with-sentry.mjs`, which runs
  `wrangler deploy` with `.wrangler/sentry` as the bundle outdir, injects a per-Worker
  `SENTRY_RELEASE`, creates the matching Sentry release when it does not already exist, and uploads
  that bundle directory to Sentry with `sentry-cli sourcemaps upload`.
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
   push to `main`, or manually from `main`. The workflow checks out `refs/heads/main` and refuses to
   deploy if it does not match the CI `head_sha`. Manual runs execute `verify:ci` before the
   production gate. The deployment job then waits for the GitHub `production` environment, runs
   `tb deploy --check` and `tb deploy --wait` through environment-scoped `TB_TOKEN` and `TB_HOST`,
   applies D1 migrations, and deploys Workers through Turborepo package tasks.
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
