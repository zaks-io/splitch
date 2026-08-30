# Deployment pipeline: PR CI, shared preview, production release, rollback

Status: CI, local gates, shared-preview deploy, reset, and smoke, production deploy wiring, Worker
secret sync, and Cloudflare D1/KV resource provisioning are in place. Production smoke and rollback
are still designed, not wired.
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
  shards. The affected `ci` Verify job uses `blacksmith-8vcpu-ubuntu-2404`. The 4-vCPU trial was
  rejected after forced uncached runs exceeded the four-minute target and repeatedly tripped
  existing five-second test budgets under load. Revisit the smaller runner only after the graph can
  meet the same p95 and normalized-compute criteria.
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
- `globalEnv` is limited to values that can change every task. Runtime Worker bindings and secrets do
  not invalidate TypeScript-only builds. Target-specific variables live only on the Vite build tasks
  that consume them; missing declarations can produce preview/prod cache cross-contamination.
- Runtime `SENTRY_DSN` is passed only to non-cacheable deploy tasks. The Control Panel client build
  uses the committed Wrangler DSN unless `VITE_SENTRY_DSN` explicitly overrides it, so an
  environment-scoped runtime secret cannot split otherwise identical build hashes.
- `CLOUDFLARE_WEB_ANALYTICS_TOKEN` is declared on the Control Panel and Marketing build tasks and
  supplied by the production deploy workflow from the repository variable of the same name. The
  token is public and only inlined into production builds; a production build without it fails.
- CI sets `TURBO_TOKEN`, `TURBO_TEAM`, and `TURBO_REMOTE_CACHE_SIGNATURE_KEY` for signed remote cache.
  Secrets used only by deploy/provision tasks are not part of cacheable task outputs.
- After main verification succeeds, the production planner remains the sole authority for selecting
  deploy phases and Worker packages. The deploy job builds only the selected Worker graph with the
  exact production inputs; CI does not prebuild Control Panel or Marketing unconditionally.
- Debugging starts with `turbo run <task> --dry-run=json` to inspect the task graph, inputs, outputs,
  and cache hits before changing workflow YAML.

## Required GitHub workflows

| Workflow                | Trigger                                                       | Concurrency                      | Required result                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci`                    | PR and push to main                                           | cancel in-progress per branch/PR | wired: affected `verify:ci`, format, lint, typecheck, test, build, dependency-cruiser, jscpd, Knip, Gitleaks, conditional local D1/Tinybird checks, and an exact-SHA reusable production call                                   |
| `e2e`                   | weekly schedule, manual dispatch                              | `e2e-main`, queued               | wired: full-stack Control Panel Playwright harness against `main`; signal-only while SPL-181 remains open, never blocks deploys                                                                                                 |
| `deploy-shared-preview` | manual dispatch                                               | `shared-preview-deploy`, queued  | wired: deploy selected ref to the one hosted preview target through Tinybird Branch build, D1 migrations, Turborepo Worker deploy tasks, and hosted smoke                                                                       |
| `reset-shared-preview`  | manual dispatch                                               | `shared-preview-deploy`, queued  | wired: rebuild the Tinybird Branch, migrate and clear preview-only D1/KV state, reseed fixtures, run Copy Pipe on demand, and verify hosted smoke                                                                               |
| `deploy-production`     | reusable call from successful `ci` on `main`, manual dispatch | `production-deploy`, queued      | wired: current-main and exact-SHA validation, successful CI verification, affected-phase and Worker planning from the latest successful production deployment, conditional Tinybird/D1/Worker mutation, and Linear release sync |
| `rollback-production`   | manual dispatch                                               | `production-deploy`, queued      | not wired: Worker rollback or roll-forward runbook execution                                                                                                                                                                    |
| `sdk-release`           | manual dispatch                                               | `sdk-release`, queued            | wired: validate `@splitch/sdk`, prepare release artifacts, create or update draft GitHub Release for `sdk-v<version>`; does not publish to npm                                                                                  |
| `sdk-publish`           | published GitHub Release                                      | `sdk-publish`, queued            | wired: validate fresh public repository/release/remote-tag SHA evidence immediately before GitHub-hosted npm trusted publishing with provenance, or skip an existing version, then sync the dedicated SDK Linear release        |
| `cli-release`           | manual dispatch                                               | `cli-release`, queued            | wired: validate `@splitch/cli`, prepare release artifacts, create or update draft GitHub Release for `cli-v<version>`; does not publish to npm                                                                                  |
| `cli-publish`           | published GitHub Release                                      | `cli-publish`, queued            | wired: validate fresh public repository/release/remote-tag SHA evidence immediately before GitHub-hosted npm trusted publishing with provenance, or skip an existing version, then sync the dedicated CLI Linear release        |

External fork PRs run CI only. Deploying any branch to shared preview requires a maintainer-triggered
workflow that runs trusted workflow code with repository secrets.

### Package publish bootstrap prerequisite

Each npm package must exist before its trusted publisher can be configured. Bootstrap and provider
setup are human-owned and package-specific. The normal publish workflows carry no npm token and
must remain OIDC-only. A missing or mismatched trusted publisher fails closed at `npm publish`; it
is not a reason to add a long-lived token.

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

| Worker                   | Binding rule                                                                                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control Plane API Worker | D1 system-of-record binding, KV config/credential cache bindings, live-update and D1-backed Durable Object bindings                                                                                                                                                               |
| MCP Worker               | No D1, KV, Tinybird, or Durable Object data bindings; calls public APIs by origin and Analysis by service binding through `@splitch/control-plane-sdk`                                                                                                                            |
| Evaluation Worker        | Provider/config KV, Assignment Store KV/DO, Event Ingest service binding                                                                                                                                                                                                          |
| Event Ingest Worker      | Four datasource-specific Queue producer/consumer bindings, four matching DLQ producer bindings, one SQLite Admission Gate Durable Object class binding, sharded ingest/outbox/recovery Durable Objects, scoped Tinybird write, reconciliation-read, and state-repair copy secrets |
| Analysis Worker          | Tinybird read secret; no SDK evaluate or ingest bindings                                                                                                                                                                                                                          |
| Auth API Worker          | D1 identity/session binding plus auth/session/token bindings; no post-create App management bindings                                                                                                                                                                              |
| Control Panel Worker     | D1 binding for server-side auth, session, and claim flows plus UI/session/client bindings; no direct KV/Tinybird access                                                                                                                                                           |
| Marketing Worker         | Static/public bindings only; no authenticated App data                                                                                                                                                                                                                            |
| Scheduled jobs           | Cron triggers stay on owning Workers: Control Plane API demo cleanup and Analysis snapshot refresh                                                                                                                                                                                |

Each Event Ingest queue consumer is checked into every Wrangler target with
`max_concurrency = 1`, `max_batch_size = 100`, and `max_batch_timeout = 1` second. Preview and
production may use different queue resource IDs, but may not weaken the drain governor. A capacity
change is a reviewed config mutation, not an autoscaling response to backlog.

Each consumer also configures its matching datasource dead-letter queue and `max_retries = 7`, which
means at most eight total attempts including the initial delivery. Permanent failures are explicitly
copied to the DLQ and acknowledged without consuming the retry budget. A deployment is incomplete
if any primary queue lacks its matching DLQ binding or if shared preview and production reuse a queue
resource.

A retried delivery carries an explicit `delaySeconds` that doubles per attempt, offset per message so
one failed batch does not re-arrive as a single herd. An immediate retry would spend the whole
eight-attempt budget against the same unhealthy Tinybird in under a second, which converts a
transient rate limit into permanent event loss.

Hosted smoke must also prove each Tinybird request has durable write-ahead attempt state and that an
unresolved `attempting`/`indeterminate` record prevents redelivery from calling Tinybird. Retryable
`429`, `500`, and `503` outcomes remain bounded by the same eight-attempt ceiling.

Queue publication contract tests and hosted smoke enforce the 120,000-byte per-message ceiling and
the 100-message/240,000-byte `sendBatch` ceilings from
[edge-ingest-contract.md](../pipeline/edge-ingest-contract.md). Boundary-size tests must prove an
accepted canonical row remains publishable and an oversized row fails before acceptance.

Event Ingest also declares one SQLite-backed `IngestAdmissionGateDurableObject` class binding and
its monotonic `new_sqlite_classes` migration in every platform target. Runtime instances are routed
with `idFromName(JSON.stringify([app_id, environment_id, ingest_stream]))`, producing one object per
scope rather than one global object. Shared preview and production use separate Durable Object
namespaces. Deployment smoke must prove same-scope calls share row and byte capacity, different
scopes do not share capacity, and a missing or failed binding rejects intake before claims, outbox
writes, or queue publication.

Shared preview and production check in the complete launch profile from
[edge-ingest-contract.md](../pipeline/edge-ingest-contract.md): one row refill, row burst, byte
refill, and byte burst value for each of the four ingest streams. Both targets start with the same
profile so shared preview exercises production admission behavior. Deployment fails closed when a
stream or value is absent; deploy tooling must not supply hidden defaults, customer overrides, or
runtime auto-tuning.

Deployment smoke verifies the checked-in values and the 10-second burst capacities. A profile
change requires a reviewed config mutation and load evidence showing stable queue age, no sustained
Tinybird `429` responses, and recovery after a 2x burst. The per-scope profile is a fairness and
spike-isolation control; the fixed per-datasource queue consumer remains the hard aggregate
Tinybird protection boundary.

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
5. Run smoke checks against the shared-preview URL. Deploy smoke verifies the revision being deployed;
   reset smoke first resolves the currently deployed revision from hosted health, then verifies that
   exact revision across the Worker fleet after state reset.
6. Post the shared-preview URL, deployed ref, Tinybird branch name, migration list, and smoke results to
   the PR or workflow summary.

Shared-preview smoke is the first proof that hosted bindings are correct. Each smoke result must
include the URL, expected `platformTarget = "shared-preview"`, deployed commit SHA, migration list,
Tinybird Branch, and which routes were exercised.

### Control Panel golden path

The API smoke proves the machine surfaces; it cannot prove a human can use the product. The panel
golden path closes that gap by signing in through real WorkOS AuthKit as a seeded smoke account and
walking Organization shell, App create, Flag create and edit, Experiment draft, Run Start, and
Results. It runs as the `panel` Playwright project against the deployed preview, so it is the only
smoke phase that needs a browser, and its Chromium install stays gated behind the earlier phases.

The login account is provisioned per run by `shared-preview:seed-panel-user` using the
`WORKOS_API_KEY` the deploy already holds. The password is minted fresh each run, masked in the log
stream, and passed to the smoke step through `$GITHUB_ENV`; no standing panel password exists as a
repository or environment secret. Because the Control Panel session principal is the WorkOS user id
itself, the same step grants that id owner access to the seeded smoke Organization and App.

Every App the golden path creates uses a key prefix listed in `TRANSIENT_APP_KEY_PREFIXES`, and
cleanup deletes the whole app-scoped graph (Runs, Experiments, Metrics, Event Definitions, Segments,
Approvals, Flags, and Variants) for those Apps. An App created under any other prefix survives
cleanup and orphans the shared preview.

The panel golden path additionally requires the Control Panel callback URL for the target host to be
registered in the WorkOS Dashboard under Applications -> Redirects. Redirect URIs are dashboard-managed
and no API credential can add them, so this is a human prerequisite for every new hosted panel host.

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
- Production jobs run on ephemeral Blacksmith VMs. Do not add the per-job `step-security/harden-runner`
  action to these jobs: its agent installation is unsupported on this runner path and only adds a
  timeout. If runtime egress enforcement is required, install the StepSecurity agent in the runner
  image instead.
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
- Event Ingest declares `SPLITCH_EVENT_INGEST_TOKEN` and the least-privilege
  `TINYBIRD_INGEST_TOKEN` as required Worker secrets. Tinybird manages the latter as the
  deployment-defined `raw_events_ingest` token. It has APPEND access to the three implemented
  datasources, `raw_events`, `raw_evaluations`, and `metric_events`, each of which declares
  `TOKEN raw_events_ingest APPEND` in its datafile. Every datasource Event Ingest appends to must
  declare that same token: the Worker carries one ingest secret, and Tinybird rejects out-of-band
  scope grants, so a datasource naming a different token is unreachable at runtime. `web_events`
  joins the list when Web Event intake ships.
  `TINYBIRD_API_URL` is non-secret Worker config and points at the Tinybird region API.
- Control Plane declares two separate Approval Request archive secrets. The
  `TINYBIRD_APPROVAL_ARCHIVE_WRITE_TOKEN` value is Tinybird's deployment-defined
  `audit_log_ingest` token and needs APPEND on the shared `audit_log` datasource. That scope is
  broader than Approval Request archival because Tinybird's token granularity stops at the
  datasource. The `TINYBIRD_APPROVAL_ARCHIVE_READ_TOKEN` value is the deployment-defined Tinybird
  token named `approval_request_archives_read`, declared with `TOKEN ... READ` in
  `pipes/approval_request_archives.pipe`; it has READ only on the `approval_request_archives`
  endpoint. It cannot be a hand-created static token: the production workspace rejects out-of-band
  resource-scoped tokens ("can only be done via deployments"). Neither value is a workspace admin
  token.
- Control Plane declares `CONVEX_WEBHOOK_KEK` as a required 32-byte base64 secret. It encrypts Convex
  webhook HMAC secrets at rest and must differ between preview and production. Rotation rewraps
  stored webhook secrets before the prior value is removed.
- Control Plane declares `INTEGRATION_SECRET_KEK` as a separate required 32-byte base64 secret. It
  encrypts customer Cloudflare push secrets at rest and must differ between preview and production.
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
   push to `main`, or manually from `main`. Automatic runs call the reusable deployment workflow with
   the CI run's exact SHA and remain visible as part of that CI run. Manual runs use the dispatch
   event's `github.sha`. Both paths check out and verify that immutable release SHA. Manual runs query
   GitHub Actions and require a successful `ci` push run on `main` for that exact SHA. Both paths reject
   a release that is no longer current `main`, unless a human explicitly enables `allow_stale_release`
   for incident recovery. That override authorizes an older code release only; it does not roll back
   D1, KV, Durable Objects, Queues, or Tinybird. The workflow compares the release to the latest
   successful GitHub `production` deployment. Non-runtime
   documentation, spec, workflow, CLI, repository-lint, and public-SDK-only changes stop before the
   environment gate. Root `CONTEXT.md` remains a runtime input because the MCP Worker serves its
   generated copy. `docs/spec/**` changes, including `docs/spec/quickstart.md`, never trigger a
   production deploy by themselves; the generated quickstart refreshes on the next MCP Worker runtime
   deployment. Tinybird, D1, and Worker phases run only when their owned inputs changed, and
   the Worker phase follows workspace dependencies to select its deployable packages. Missing, divergent,
   or unclassified baseline evidence fails closed to the full deployment. When a Control Plane or Control
   Panel input changed, the deployment job retains the complete bounded compatibility cutover and
   credential backfill. When Evaluation changed, it retains the Event Ingest ordering without requiring
   a Control Plane checkpoint. The backfill gate is bearer-protected by the hosted
   `SPLITCH_DEPLOY_GATE_TOKEN`, reports only migration checkpoints, and fails the release instead of
   allowing a partial rollout. The remaining Worker phase excludes Analysis and Control Plane and
   runs only after that verification.
4. Destructive Tinybird deploys require explicit human approval and `--allow-destructive-operations`.
   They are not allowed in the default production deploy workflow.

The first deployment of `deduped_activations_state`, `deduped_metric_events_state`, or
`deduped_web_events_state` follows
[physical-dedup-pipes.md](../pipeline/physical-dedup-pipes.md): `tb deploy --check` must prove
`BACKFILL skip`, affected reads/intake remain blocked, population runs one App/Environment/source
month at a time, and exact raw-versus-serving reconciliation completes before traffic opens. A
Forward plan that automatically populates retained history or a smoke query that reads a physical raw
log fails the release.

Current cloud setup: Tinybird workspaces `splitch_dev` and `splitch_prod` exist. Both have the
committed datasource shape deployed and a `raw_events_ingest` APPEND token generated by the Tinybird
datafile. The `shared_preview` Tinybird Branch exists. GitHub environment secret names are present
for preview and production deploys. Worker secret values remain outside the repository and docs.

The splitch physical dedup Copy Pipe snapshot is separate from Tinybird Branch snapshots. Production
runs the scheduled Tinybird snapshot refresh on the Analysis Worker. Shared preview runs Copy Pipes on
demand for smoke tests only; it does not schedule its own hourly snapshot job by default.

## Production deploy order

Production deployments run from the default branch only. The final successful `ci` job calls
`deploy-production` as a reusable workflow on `main`, so CI remains in progress until the production
path finishes. Main CI runs use per-run concurrency groups so a newer push cannot cancel or replace an
in-flight production call. Failed or canceled verification creates no production jobs. The workflow
can also be manually dispatched from `main`. It validates the release is current `main` and verifies the
exact CI head SHA, then diffs it against the latest successful GitHub `production` deployment before
the environment gate. Releases limited to documentation, specs, workflows, CLI, repository-lint,
or the public SDK finish without creating a production deployment. The generated MCP copy of root
`CONTEXT.md` remains a Worker input. `docs/spec/quickstart.md` is generated into the MCP Worker when
that Worker next deploys, but a spec-only change does not trigger production mutation. The
planner owns the Tinybird, D1, Worker phase, and affected Worker package decisions. Unknown paths, a
missing baseline, or a baseline outside the release ancestry fail closed to all phases and the full
Worker fleet. Selected phases retain the order below and use the gated job's environment-scoped
Cloudflare and Tinybird credentials. Manual dispatch exposes `force_full_deploy` for an intentional
same-SHA redeploy or drift repair. It separately exposes `allow_stale_release` for explicit incident
recovery. That override does not provide data rollback.

1. Verify successful `ci` evidence for the exact release SHA. Automatic runs trust the completed
   `Verify` dependency in the same CI run and require the reusable call's run ID and SHA to match.
   Manual runs query the `ci` workflow's successful `main` push runs. The production deploy planner
   selects the exact Worker graph, and the deploy job builds it with production-target inputs after
   the environment gate. The Playwright harness runs weekly in `e2e` as a signal-only check while
   SPL-181 is open, so a red run never blocks a release.
2. Resolve the latest successful `production` deployment SHA, compute the exact changed path set, and
   stop when no production deploy input changed.
3. Wait for GitHub `production` environment approval. Required reviewers and prevent-self-review should
   be enabled. After the gate opens, re-check current `main` immediately before mutation so approval
   delay cannot deploy an obsolete release unless `allow_stale_release` was explicit.
4. When Tinybird inputs changed, run its deployment check with the environment-scoped production
   Tinybird token, then deploy Tinybird to Cloud main.
5. When D1 migration or Cloudflare toolchain inputs changed, apply D1 migrations to production.
6. When Worker inputs changed, follow workspace dependencies to the affected deployable Workers, then
   build or restore only those Worker artifacts through Turborepo. A `services` binding resolves when
   the caller deploys, so every affected callee deploys first: Event Ingest, Analysis, then Evaluation.
   Analysis and Evaluation export the named entrypoint the Control Plane delegates to
   (ADR-0046), so deploying the Control Plane ahead of either binds it to an entrypoint the live
   Worker does not export yet. If either Control Plane or Control Panel is affected, preserve the full
   bounded cutover: deploy the Control Plane with the predecessor session-handle binding entrypoint
   enabled with a 30-minute expiry, complete its versioned credential-cache backfill after marker-aware
   Evaluation is live, deploy the V2 Panel bound to the signed entrypoint, then
   immediately redeploy the Control Plane from its checked-in config with predecessor session
   redemption disabled. Turborepo deploys the remaining independent affected Workers together.
   `scripts/deploy-worker-order.test.mjs` derives these edges from the Workers' own wrangler configs
   and fails when an added binding has no ordering entry.
7. Verify cron trigger registration on Control Plane API and Analysis Workers when Workers changed.
8. Run route and binding smoke checks before marking the GitHub deployment complete when Workers
   changed.
9. Record the selected phases, baseline and release SHAs, Worker version IDs, D1 migration names,
   Tinybird deployment URL, and smoke results
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
  A Cloudflare Workflow runs once every 24 hours, initiates and continuously polls the D1 export API,
  then writes the returned export directly to R2. This sets the R2 recovery-point objective at 24
  hours; the signed export URL is transient transport material and is never persisted, displayed, or
  forwarded outside that Workflow.
- D1 export can make the database unavailable to other requests. The daily export therefore runs in a
  declared production maintenance window with a ten-minute planned-unavailability budget. Before the
  export starts, the Workflow enables one shared D1 maintenance gate that is independent of D1. Every
  Worker entrypoint capable of D1 access in the Auth API Worker, Control Panel Worker, and Control Plane
  API Worker must consult that gate before constructing a repository or otherwise touching D1. This
  includes HTTP routes and scheduled handlers, specifically the Control Plane API scheduled demo-reaper.
  Every Durable Object entrypoint capable of D1 access, including the Control Plane API credential-cache
  writer, credential-cache backfill, and config-store Durable Objects, must use the same guard before
  touching D1. A fenced gate, an unreadable gate, or a timed-out gate fails closed: HTTP entrypoints
  return the standard `503` `SERVICE_UNAVAILABLE` response with `Retry-After`, while scheduled entrypoints
  stop before D1 and record an explicit maintenance-skipped operational outcome rather than success. No
  entrypoint may fall through to D1 or make maintenance look like successful product behavior. Static
  or public paths proven not to touch D1 may remain available.
- The Workflow may initiate the export only after the shared gate reports fenced and maintenance probes
  for all three D1-bound Workers, their D1-using scheduled handlers, and the D1-using Durable Object
  entrypoints confirm the guarded path.
  The fence remains set until the export has stopped and a direct D1 readiness check proves requests are
  served again; only then may the Workflow clear it. An export still running at ten minutes breaches the
  budget: stop polling so the provider cancels the unpolled export, keep the fence until readiness
  returns, alert the incident owner, and disable later scheduled exports until the cause is resolved.
  Provisioning must prove the budget with production-size synthetic data before enabling the schedule.
  Any non-blocking replacement requires verified provider support and a policy update.
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

Use separate least-privilege identities, but do not claim controls the provider does not offer.
Cloudflare's public D1 token model exposes account-level D1 permissions rather than an export-only,
single-database permission, and an R2 Worker binding grants a Worker bucket capability rather than
prefix-scoped write-only IAM. The scheduled Workflow is therefore the mandatory mediator:

- It has no public route or caller-controlled entrypoint. Only its configured schedule can start an
  export, and code plus configuration allowlist the exact production account ID, database UUID,
  dedicated recovery bucket binding, and completed/failure object-key prefixes.
- Its API token uses the least account-level D1 permission the export endpoint accepts. Provisioning
  must verify the permission against the export endpoint; if Cloudflare requires `D1 Edit`, record that
  broader provider grant as accepted residual risk. The mediator implements only initiate/poll export
  calls and contains no general query, import, delete, or Time Travel restore client path.
- Its R2 access is a Worker binding to the dedicated recovery bucket, not an account-wide R2 token. The
  binding technically exposes bucket reads, writes, lists, and deletes; the mediator exposes only
  writes to its two allowlisted prefixes and the exact-object read needed for recoverability evidence.
  Bucket isolation, no public route, reviewed allowlists, and bucket lock compensate for the missing
  write-only and prefix-level provider grants.
- It receives no bucket-policy or public-access administration authority. Provisioning and lifecycle or
  lock administration use a separate production-approved identity that is absent from the runtime.

A restore operator receives time-bounded, incident-only authority for the named database and recovery
object; it is not the scheduled export identity. Long-lived account-wide tokens, shared credentials,
and Global API keys are prohibited.

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
must add the schedule-only mediator, shared fail-closed maintenance gate, guarded D1 access and
readiness behavior, production-size synthetic duration test, restricted evidence storage, alerting,
permission verification, allowlist tests, and automated non-production drill coverage. Route-level
tests must prove that D1-dependent Auth API, Control Panel, and Control Plane API routes each return the
standard maintenance contract while fenced and resume only after direct D1 readiness succeeds and the
gate is cleared. Tests for every D1-using Durable Object entrypoint must prove the same fail-closed and
resume ordering. A scheduled-handler test must prove that the Control Plane API demo-reaper exits before
constructing a repository or querying or mutating D1 while fenced, records the maintenance-skipped
outcome, and resumes only after direct D1 readiness succeeds and the gate is cleared. It must not add R2
creation, exports, restores, recovery credentials, or a restore action to normal production deploy
workflows. The implementation must keep all production data and recovery material out of Git, GitHub,
logs, and build artifacts.

## Rollback

Worker code-only rollback:

- Use `wrangler rollback <version_id>` or deploy a previous version to 100 percent traffic.
- Cloudflare only supports rollback to recent versions, and rollback immediately changes active traffic.
- A Control Panel protocol rollback must run
  `rollback:cloudflare:panel-binding:<platform-target>` with the prior Panel Worker version ID. It first
  enables bounded predecessor session redemption on the current Control Plane, then activates the prior
  Panel version while leaving that self-expiring compatibility Control Plane active. The prior Control Plane
  must not be restored because it has no bounded predecessor-session deadline. If recovery stalls, the
  compatibility entrypoint closes automatically at its transition deadline.

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
- [x] Add the Control Panel golden path as the `shared-preview:smoke:panel` project.
- [x] Add script for `shared-preview:reset`.
- [ ] Add script for `rollback:production`.
- [x] Add `deploy:production` and hook Tinybird deployment into it.
- [x] Add Tinybird project files and `tinybird.config.json` with local-mode development.
- [x] Add Blacksmith-backed GitHub workflows for CI and Gitleaks.
- [x] Add a Blacksmith-backed GitHub workflow for shared preview reset.
- [ ] Add a Blacksmith-backed GitHub workflow for production rollback.
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
  <https://developers.cloudflare.com/d1/best-practices/import-export-data/>,
  <https://developers.cloudflare.com/workflows/examples/backup-d1/>,
  <https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/>
- Cloudflare R2 recovery-object controls:
  <https://developers.cloudflare.com/r2/reference/data-security/>,
  <https://developers.cloudflare.com/r2/api/tokens/>,
  <https://developers.cloudflare.com/r2/api/workers/workers-api-reference/>,
  <https://developers.cloudflare.com/r2/buckets/bucket-locks/>,
  <https://developers.cloudflare.com/r2/buckets/public-buckets/>
- Cloudflare account API token permissions:
  <https://developers.cloudflare.com/fundamentals/api/reference/permissions/>
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
