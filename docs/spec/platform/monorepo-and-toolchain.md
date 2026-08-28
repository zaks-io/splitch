# Monorepo and toolchain: pnpm + Turborepo, capability Workers, shared packages

Defines the physical workspace structure, the capability-specific Worker deploy units, the shared
package contracts, and the toolchain/quality-gate stack.

## Toolchain

| Concern                               | Tool                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Package manager                       | pnpm (workspaces)                                                                                       |
| Build orchestration                   | Turborepo                                                                                               |
| Language                              | TypeScript strict                                                                                       |
| Lint / format                         | Biome for code/config; Prettier for Markdown only; `@splitch/repo-lint` for workspace publishing policy |
| Git hooks                             | Lefthook                                                                                                |
| Unused files / exports / dependencies | Knip                                                                                                    |
| Secret scanning                       | Gitleaks                                                                                                |
| Unit tests                            | Vitest                                                                                                  |
| Mutation testing                      | StrykerJS (advisory first; scoped to critical domains)                                                  |
| Deploy                                | Wrangler + GitHub Actions                                                                               |
| Observability                         | Sentry (errors, distributed traces) + Axiom (structured logs, dashboards)                               |

pnpm is also the supply-chain policy gate. Workspace installs require package versions to be at least
3 days old, enforce that rule strictly for direct and transitive dependencies, fail when registry
publish time is missing, and block transitive exotic dependency sources. **Parked in the build-fast
phase** (the four keys are commented out in `pnpm-workspace.yaml` so installs don't fail on dependency
churn); re-enabled at the lockdown milestone. Current gate reality:
[local-quality-gates.md](./local-quality-gates.md).

## Turborepo task graph

The root package scripts should delegate to Turborepo. Avoid `pnpm -r` as the primary CI gate because
it ignores task outputs, affected-package selection, and remote cache reuse.

Cached package tasks:

| Task        | Cache | Contract                                                                                                               |
| ----------- | ----- | ---------------------------------------------------------------------------------------------------------------------- |
| `build`     | yes   | `dependsOn: ["^build"]`; outputs are package-local bundles such as `dist/**`, `.output/**`, and Worker build artifacts |
| `lint`      | yes   | package-local Biome lint over `src`                                                                                    |
| `typecheck` | yes   | depends on upstream build where generated types are consumed                                                           |
| `test`      | yes   | deterministic unit/integration tests; coverage output declared only where stable                                       |

Cached root guards (explicit input globs, so unrelated changes replay from cache):

| Task                   | Cache | Contract                                                                                                                                              |
| ---------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec:lint`            | yes   | inputs: `docs/spec/**` and the linter script                                                                                                          |
| `check:cli-mcp-parity` | yes   | inputs: CLI/MCP/contracts source trees and the parity scripts; `dependsOn` `@splitch/sdk#build` (help → command-positionals → errors imports the SDK) |
| `test:scripts`         | yes   | inputs: `scripts/**`, `.github/workflows/**`, and the files those tests assert                                                                        |
| `test:connect-snippet` | yes   | inputs: snippet source + compile guard; chains the `@splitch/sdk#build` hash                                                                          |
| `format:check`         | yes   | inputs: every tracked file (`$TURBO_DEFAULT$`); pure function of file content                                                                         |
| `knip`                 | yes   | inputs: tracked files minus Markdown/`.github/**`; chains SDK/CLI build hashes                                                                        |

Root-task input rule: use `$TURBO_DEFAULT$` (all tracked, gitignore-respecting files) plus
exclusions — never bare filesystem globs like `**`, which hash `node_modules/` and build outputs and
self-invalidate.

Uncached or root-wide tasks:

| Task                                  | Cache | Contract                                                               |
| ------------------------------------- | ----- | ---------------------------------------------------------------------- |
| `depcruise`                           | no    | root architecture import graph gate                                    |
| `duplicates`                          | no    | root duplicate-code detection over source-bearing paths                |
| `secrets:*`                           | no    | Gitleaks scans working tree or git history; never cache security scans |
| `d1:migrate:local` / `tinybird:local` | no    | local backing-resource validators                                      |
| `dev`                                 | no    | persistent local dev task                                              |
| `deploy:*`, `migrate:*`, `rollback:*` | no    | remote-state mutation; never served from cache                         |

CI uses Turborepo remote caching with `TURBO_TOKEN`, `TURBO_TEAM`, and
`TURBO_REMOTE_CACHE_SIGNATURE_KEY`. Remote cache artifact signing is enabled in `turbo.json`. The
required gate runs `pnpm verify:ci --affected` against exact PR or push comparison SHAs. Missing or
unresolvable ranges fail closed to the full graph, still cache-first: only the nightly forced run
ever sets `TURBO_FORCE`. Deployment jobs use
`--filter=<workspace>...` to build only the Worker/app graph being deployed.
Every build-affecting environment variable must be listed in `globalEnv` or task `env` so preview and
production builds cannot reuse the wrong cache entry.

Cache-trust contract: per-PR/per-push runs replay cached results freely because the `nightly-verify`
workflow re-executes the full `verify:ci` graph with `TURBO_FORCE=true` every day, rewriting fresh
signed cache entries — a stale or wrong entry survives at most one day. Workflows that run Turbo
tasks must (a) route builds through `turbo run` (never `pnpm --filter <pkg> build`, which bypasses
the cache) and (b) set `SPLITCH_PLATFORM_TARGET: pr-ci` to match the `ci` Verify hash-space, unless
they intentionally build for another platform target. The npm publish workflows (`sdk-publish`,
`cli-publish`, and `convex-publish`) are the deliberate exception: they rebuild hermetically from
the tagged source on GitHub-hosted runners because npm provenance should attest a from-source build,
not a cache restore.

Local hook policy lives in [local-quality-gates.md](./local-quality-gates.md). Commit hooks block
format, lint, type, Knip, and Gitleaks failures before code is committed. The pre-push hook runs the
same validation set as CI except hosted smoke tests and remote-state mutations, including duplicate-code
detection.

## Package layout

```
packages/
  bounded-body/        @splitch/bounded-body        Shared raw-body byte/content-type gate
  contracts/           @splitch/contracts           Zod schemas, z.infer types, @hono/zod-openapi routes
  worker-runtime/      @splitch/worker-runtime      Contract-mounted Hono request guard and shared error/status helpers
  control-plane-sdk/   @splitch/control-plane-sdk   Hono hc transport SDK for control-plane consumers
  sdk/                 @splitch/sdk                 Public JS/TS data-plane SDK package
  convex/              @splitch/convex              First-party Convex Component for synced local evaluation
  repo-lint/           @splitch/repo-lint           Private repo policy gates (package publishing)
  ui/                  @splitch/ui                  Design system tokens and primitives

apps/
  cli/                    CLI app, bin: splitch
  control-panel/           Control Panel Worker (TanStack Start, SSR, authenticated, live updates)
  marketing/          Marketing Worker (TanStack Start, prerendered, unauthenticated)
  control-plane-api/       Control Plane API Worker (Hono, @hono/zod-openapi, admin CRUD)
  mcp-server/              MCP Worker (remote MCP protocol adapter, calls @splitch/control-plane-sdk)
  evaluation-api/          Evaluation Worker (SDK evaluate/peek, dry-run test-eval)
  event-ingest-api/        Event Ingest Worker (append-only event validation, queues, delivery)
  analysis-api/            Analysis Worker (Tinybird proxy reads, stats/result contracts)
  auth-api/             Auth API Worker (minimal auth surface; see auth spec)

infra/
  tinybird/                Tinybird datafiles for the analytics resource project
```

The scaffold is intentionally thin: package entrypoints and Worker handlers are present so
agents can work in parallel with stable imports, scripts, and Turbo cache keys. Domain implementations
replace those thin handlers slice by slice.

Use the Turborepo convention directly:

- `apps/*` are deployable or executable graph endpoints: Workers, frontend apps, and the CLI.
- `packages/*` are libraries or tooling packages. They can be internal-only or publishable.
- `infra/*` holds provider resource projects that are source-controlled but not JS workspaces.
- App-owned code stays inside the owning `apps/*` workspace unless it is a real library boundary.
- Publishability is not a directory rule. `@splitch/sdk` and `@splitch/convex` live in `packages/`
  because they are JS/TS libraries installed by customer applications.

## Worker topology contract

These Workers are separate deploy units because they are separate capability and trust seams. Do
not collapse them into generic `api` or `edge` Workers during slicing.

The ownership table describes the accepted target. ADR-0043 is pending: the current Event Ingest
Worker has no Queue binding and directly posts each implemented `raw_events` and `raw_evaluations`
row to Tinybird. It also has no Ingest Admission Gate Durable Object binding. Metric Event and Web
Event intake must be built on the target admission and queue transport rather than copying that
direct path.

| Worker                   | Boundary                     | Owns                                                                                                                                                                                                                                                            | Does not own                                                     |
| ------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Control Plane API Worker | Authenticated management API | Org, App, Environment, Flag, Flag Configuration, Promotion, Experiment, Run, Event Definition, Metric, Segment, and SDK credential mutations                                                                                                                    | MCP transport, SDK evaluate, event ingest, Tinybird result reads |
| MCP Worker               | Agent protocol adapter       | Remote MCP auth handshake, tool registry, calls through `@splitch/control-plane-sdk`                                                                                                                                                                            | D1/KV/Tinybird bindings, domain invariants                       |
| Evaluation Worker        | SDK/data-plane resolution    | Client Key/API Key evaluate, API-Key-only peek (ADR-0034), control-plane dry-run test-eval, Provider + Assignment Store reads                                                                                                                                   | Config writes, analysis queries, direct Metric computation       |
| Event Ingest Worker      | Append-only event intake     | Evaluation usage and Exposure/Activation/Metric/Web Event validation, version stamping, per-scope SQLite Admission Gate DOs, four datasource-specific durable queues, sharded DO claim/outbox/write-ahead recovery, bounded Tinybird NDJSON microbatch delivery | Variant resolution, result calculation, control-plane CRUD       |
| Analysis Worker          | Result read model            | Tinybird proxy endpoints, SRM/Metric/statistical result reads, `app_id`/`environment_id` injection from auth/path context                                                                                                                                       | SDK evaluate, event ingest, config mutation                      |
| Auth API Worker          | Identity/token surface       | AuthKit/auth.md/OAuth endpoints, token/revocation flows, provisional create handoff                                                                                                                                                                             | Post-create Org/App management, SDK credentials, analytics       |

Worker bindings and capability-specific orchestration stay local to the owning Worker. Shared library
code belongs in `packages/` when it is imported through a stable package API or published as a customer
SDK. The public seam should stay shallow; the module behind it can be deep.

## Shared Worker runtime guard

`@splitch/worker-runtime` is the shared request guard for Hono-based capability Workers. It consumes
route contracts from `@splitch/contracts` and mounts handlers through one fixed guard chain for
request IDs, Zod parsing, principal resolution, scope checks, rate-limit classes, idempotency header
handling, and canonical `ErrorResponse` rendering.

It does not own domain invariants, storage bindings, Provider reads, Assignment Store orchestration,
Tinybird queries, MCP protocol handling, or UI data loading. Those stay in the owning capability
Worker. See [worker-runtime.md](./worker-runtime.md).

## Two frontend deploy units

**Control Panel Worker** (`apps/control-panel`):

- TanStack Start, SSR with loader-seeded TanStack Query caches
- Authenticated; all routes resolve `orgSlug`/`appSlug` to IDs and check session membership
- Hibernating WebSocket attaches post-hydration per `/{orgSlug}/{appSlug}/{env}` layout route, keyed
  by `(appId, environmentId)` (ADR-0027)
- Blast radius: authenticated control-plane sessions only

**Marketing Worker** (`apps/marketing`):

- TanStack Start, routes prerendered to static HTML at build time
- Unauthenticated; served from Cloudflare static assets for SEO/perf
- TanStack Query for live-data touchpoints (pricing, status) only
- Blast radius: public marketing surface; no auth, no App data

The two frontend Workers are cleanly isolated at the deploy boundary. Component sharing happens at
build time through `@splitch/ui`, so isolation costs nothing.

## `@splitch/ui` seam contract

| Side              | Responsibility                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `ui` package      | Tailwind 4 `@theme` tokens; framework primitives: Button, Card, Input, Dialog, skeletons, error/empty states |
| Control Panel app | Domain-aware components (RunStatusBadge, SRM panel, Experiment table) composed from `ui` primitives          |
| Marketing app     | Marketing-specific feature/page components composed from `ui` primitives                                     |

`ui` knows nothing about the domain — it never imports a Run, Experiment, or Exposure type. Two
real consumers (Control Panel, Marketing) = the deletion test passes = real seam, not
speculative.

**Versioning:** `ui` ships as a monorepo-internal package. A version bump triggers both Workers to
rebuild at the same `ui` version. Breaking API changes in `ui` require a deprecation phase
(old API coexists with new during a transition window) before removal.

## TanStack Query as sole state store

Both frontend Workers use TanStack Query. No Redux, Zustand, or second synced server-state store
exists. `useState` / local component state holds ephemeral UI state only (form input, open/closed).

**Query key factory** (Control Panel app, not in `ui`):

- All keys are entity-rooted and hierarchical under `['app', appId, ...]`
- Example: `['app', appId, 'experiment', expId, 'runs']`
- Invalidate by prefix: a nudge for `experiment/{expId}` invalidates
  `['app', appId, 'experiment', expId]` prefix, catching list + detail + sub-resources
- The factory is the single source of key shapes; WebSocket nudge handler invalidates through it,
  never by hand-assembling arrays

**Version-gated against self-edits:** nudge carries `version`; if cached version ≥ nudge version,
skip refetch (the writer already has the new state from its 200 response).

## Auth and session boundary (Control Panel)

- Session is an HTTP cookie, validated server-side in the TanStack Start server handler
- Validated result `{ userId, orgs }` (memberships across all the user's Orgs) enters loader context
- Active Org/App/Environment are URL segments (`/{orgSlug}/{appSlug}/{env}/...`); loader resolves
  slugs to IDs and validates membership (403 on no access; 404 when the app is not under that org)
- Session issuer: WorkOS AuthKit (WorkOS session issuer rule) behind the `cookie → server validation → loader
context` seam (seam is issuer-agnostic)

## Error boundaries (Control Panel)

Three tiers at fixed route-tree levels:

| Tier               | Location                                             | Catches                                                                                       |
| ------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Root               | App shell                                            | Catastrophic/unexpected; renders full "something broke" page                                  |
| Segment            | `/{orgSlug}/{appSlug}/{env}` layout + major sections | Expected domain failures: 403 (no access), 404 (not found); designed states, not stack traces |
| Background refetch | Nudge refetch path                                   | Non-fatal stale-with-toast; never unmounts good data                                          |

Expected domain failures (403/404) are **not** Sentry errors — they are normal control flow.
Failed background refetch is a low-severity breadcrumb, not a page break.

## Observability

- Distributed trace context propagates: SSR loader → read API and client fetch → read API
- `userId`, `appId`, `role` set once at session-validation seam; all downstream Sentry events tagged
- Targeting Key and Evaluation Context attributes are scrubbed from Sentry (may carry customer PII)

## Scheduled jobs

Scheduled jobs run on the Worker that owns the capability. Do not create cron-only app workspaces just
because the trigger is a timer.

| Owner Worker             | Cadence                        | What it does                                                                                         |
| ------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Control Plane API Worker | Configurable (default: daily)  | Deletes provisional/demo Organizations past their TTL; routes through D1 data-access seam (ADR-0022) |
| Analysis Worker          | Configurable (default: hourly) | Triggers Copy Pipe run to refresh first-touch snapshot (ADR-0024)                                    |

Both are Cloudflare Cron Triggers declared in the owning Worker's Wrangler config, not separate
cron-only deploy units.

## Sources

- [../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md](../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md)
- [../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md](../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md)
- [../../adr/0020-tanstack-start-for-both-control-panel-and-marketing-shared-component-layer.md](../../adr/0020-tanstack-start-for-both-control-panel-and-marketing-shared-component-layer.md)
- [../../adr/0031-mutation-testing-is-advisory-before-it-is-a-gate.md](../../adr/0031-mutation-testing-is-advisory-before-it-is-a-gate.md)
- [../../architecture/frontend-architecture.md](../../architecture/frontend-architecture.md)
- WorkOS session issuer rule (WorkOS as session issuer)
