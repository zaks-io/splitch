# Deployment pipeline: PR CI, shared preview, production release, rollback

Status: CI and local gates wired; shared preview, production deploy, rollback, and real resource
provisioning are still designed, not wired.
Vocabulary follows [CONTEXT.md](../../../CONTEXT.md). This document uses **platform target** for
CI/deployment targets such as local, PR CI, shared preview, and production. A platform target is not a
splitch product **Environment** under an App.

## Decision

Use GitHub Actions on Blacksmith runners as the orchestrator, Turborepo as the monorepo task graph
and task-output cache, Wrangler as the Cloudflare source of truth, and Tinybird CLI deployments for
analytics resources. Every non-doc PR gets local validation against disposable CI services. Hosted
preview is a single shared target updated on demand. Production releases are queued, approval-gated
GitHub deployments that run migrations as part of the release, not as a side manual step.

The scaffold has the `ci` workflow (with a range-scoped Gitleaks secret-scan step), Turborepo task graph, package scripts,
Lefthook hooks, and placeholder Wrangler configs. It does not provision or deploy Cloudflare or
Tinybird resources.

Do not use Cloudflare dashboard edits as the source of truth. Wrangler config, generated preview
configs, Tinybird project files, and GitHub environment settings are the release contract.

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
- CI sets `TURBO_TOKEN` and `TURBO_TEAM` for remote cache. Secrets used only by deploy/provision tasks
  are not part of cacheable task outputs.
- Debugging starts with `turbo run <task> --dry-run=json` to inspect the task graph, inputs, outputs,
  and cache hits before changing workflow YAML.

## Required GitHub workflows

| Workflow                | Trigger                                              | Concurrency                      | Required result                                                                                                               |
| ----------------------- | ---------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `ci`                    | PR and push to main                                  | cancel in-progress per branch/PR | wired: `verify:ci`, format, lint, typecheck, test, build, dependency-cruiser, jscpd, Knip, Gitleaks, local D1/Tinybird checks |
| `gitleaks`              | PR and push                                          | none                             | wired: full git secret scan                                                                                                   |
| `deploy-shared-preview` | manual dispatch, or trusted maintainer label/comment | `shared-preview-deploy`, queued  | not wired: deploy selected ref to the one hosted preview target                                                               |
| `reset-shared-preview`  | manual dispatch                                      | `shared-preview-deploy`, queued  | not wired: restore shared preview to the default branch or clear preview data                                                 |
| `deploy-production`     | push to main, or manual dispatch from main           | `production-deploy`, queued      | not wired: migration-backed production release with smoke checks                                                              |
| `rollback-production`   | manual dispatch                                      | `production-deploy`, queued      | not wired: Worker rollback or roll-forward runbook execution                                                                  |

External fork PRs run CI only. Deploying any branch to shared preview requires a maintainer-triggered
workflow that runs trusted workflow code with repository secrets.

## Cloudflare resource contract

Wrangler config is the source of truth. Use `wrangler.jsonc` for each deployable Worker and generate
shared-preview configs from those checked-in configs. Do not deploy the root Worker accidentally; every
deploy must specify a platform target.

Public hostnames and per-Worker routes are fixed by
[ADR-0038](../../adr/0038-public-hostnames-are-a-fixed-human-owned-subdomain-map.md) on the
`splitch.dev` zone (subdomain per surface; Analysis is internal, no public host). Generate
`wrangler.jsonc` routes from that table — do not invent hostnames.

Per-Worker configs must declare only the bindings owned by that Worker:

| Worker                   | Binding rule                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| Control Plane API Worker | D1 system-of-record binding, KV config/credential cache bindings, live-update Durable Object binding |
| MCP Worker               | No D1, KV, Tinybird, or Durable Object data bindings; calls through `@splitch/control-plane-sdk`     |
| Evaluation Worker        | Provider/config KV, Assignment Store KV/DO, Event Ingest service binding                             |
| Event Ingest Worker      | Queue, sharded ingest/dedup Durable Objects, Tinybird write secret                                   |
| Analysis Worker          | Tinybird read secret; no SDK evaluate or ingest bindings                                             |
| Auth API Worker          | Auth/session/token bindings only; no post-create App management bindings                             |
| Control Panel Worker     | UI/session/client bindings only; no direct D1/KV/Tinybird access                                     |
| Marketing Worker         | Static/public bindings only; no authenticated App data                                               |
| Scheduled jobs           | Cron triggers stay on owning Workers: Control Plane API demo cleanup and Analysis snapshot refresh   |

### Shared Cloudflare preview

Shared preview is provisioned once and updated on demand:

1. Maintain one shared-preview D1 database, KV namespace set, Durable Object namespace set, Worker fleet,
   and Tinybird Branch.
2. Generate a Wrangler config per Worker with shared-preview binding IDs, preview vars, service bindings
   pointing at shared-preview Worker names, and no production routes.
3. Apply D1 migrations to the shared-preview D1 database before Worker deployment.
4. Deploy Workers with `wrangler deploy` using the generated config.
5. Run smoke checks against the shared-preview URL.
6. Post the shared-preview URL, deployed ref, Tinybird branch name, migration list, and smoke results to
   the PR or workflow summary.

Shared-preview smoke is the first proof that hosted bindings are correct. Each smoke result must
include the URL, expected `platformTarget = "shared-preview"`, deployed commit SHA, migration list,
Tinybird Branch, and which routes were exercised.

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
- D1 captures a backup before `wrangler d1 migrations apply`; failed migrations roll back the failed
  migration and leave prior successful migrations applied.
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
- Secret rotation is its own release. Do not hide secret changes inside an unrelated code deploy.

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

1. PR CI runs `tb --local build`, loads fixture data, runs `tb --local test run`, and runs
   `tb --cloud deploy --check` when cloud credentials are available to trusted PR workflows.
2. Shared preview creates or updates `shared_preview --last-partition`, then runs `tb --branch=shared_preview build`
   and endpoint smoke tests against that branch.
3. Production release runs `tb --cloud deploy --check`, then `tb --cloud deploy`.
4. Destructive Tinybird deploys require explicit human approval and `--allow-destructive-operations`.
   They are not allowed in the default production deploy workflow.

The splitch physical dedup Copy Pipe snapshot is separate from Tinybird Branch snapshots. Production
runs the scheduled Tinybird snapshot refresh on the Analysis Worker. Shared preview runs Copy Pipes on
demand for smoke tests only; it does not schedule its own hourly snapshot job by default.

## Production deploy order

Production deployments run from the default branch only.

1. Install dependencies and run `verify:ci`.
2. Run Tinybird deployment check.
3. Wait for GitHub `production` environment approval. Required reviewers and prevent-self-review should
   be enabled.
4. Deploy Tinybird to Cloud main.
5. Apply D1 migrations to production.
6. Deploy stateful/internal Workers first: Event Ingest, Analysis, Control Plane API, Auth API.
7. Deploy Evaluation Worker after Event Ingest is healthy.
8. Deploy MCP Worker, Control Panel Worker, and Marketing Worker; verify cron trigger registration on
   Control Plane API and Analysis Workers.
9. Run smoke checks for public routes, service bindings, event ingest, analysis reads, and cron trigger
   registration.
10. Record Worker version IDs, D1 migration names, Tinybird deployment URL, commit SHA, and smoke results
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
- [ ] Add scripts for `shared-preview:deploy`, `shared-preview:smoke`, `shared-preview:reset`,
      `deploy:production`, and `rollback:production`.
- [ ] Add Tinybird project files and `tinybird.config.json` with branch-mode development.
- [x] Add Blacksmith-backed GitHub workflows for CI and Gitleaks.
- [ ] Add Blacksmith-backed GitHub workflows for shared preview deploy/reset, production deploy, and rollback.
- [ ] Configure GitHub `preview` and `production` environments and required production reviewers.
- [ ] Configure `TURBO_TOKEN` and `TURBO_TEAM` for CI remote caching.
- [ ] Seed deterministic Tinybird Local fixtures for CI and document how to refresh the shared-preview branch.

## Sources

- Cloudflare Wrangler configuration and environment docs:
  <https://developers.cloudflare.com/workers/wrangler/configuration/>,
  <https://developers.cloudflare.com/workers/wrangler/environments/>
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
