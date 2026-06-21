# Monorepo and toolchain: pnpm + Turborepo, capability Workers, one ui package

Defines the physical package structure, the capability-specific Worker deploy units, the shared
ui package contract, and the toolchain/quality-gate stack.

## Toolchain

| Concern | Tool |
|---|---|
| Package manager | pnpm (workspaces) |
| Build orchestration | Turborepo |
| Language | TypeScript strict |
| Lint / format | Biome (single tool, no ESLint/Prettier split) |
| Git hooks | Lefthook |
| Unused files / exports / dependencies | Knip |
| Secret scanning | Gitleaks |
| Unit tests | Vitest |
| Mutation testing | StrykerJS (advisory first; scoped to critical domains) |
| Deploy | Wrangler + GitHub Actions |
| Observability | Sentry (errors, distributed traces) + Axiom (structured logs, dashboards) |

## Turborepo task graph

The root package scripts should delegate to Turborepo. Avoid `pnpm -r` as the primary CI gate because
it ignores task outputs, affected-package selection, and remote cache reuse.

Required root tasks once the package scaffold lands:

| Task | Cache | Contract |
|---|---|---|
| `build` | yes | `dependsOn: ["^build"]`; outputs are package-local bundles such as `dist/**`, `.output/**`, and Worker build artifacts |
| `lint` | yes | inputs include source, Biome config, package manifest, and generated contract inputs |
| `format:check` | yes | Biome formatting gate |
| `typecheck` | yes | depends on upstream build where generated types are consumed |
| `test` | yes | deterministic unit/integration tests; coverage output declared only where stable |
| `depcruise` | yes | architecture import graph gate |
| `knip` | yes | unused files, exports, and dependencies gate after generated files exist |
| `secrets:*` | no | Gitleaks scans working tree or git history; never cache security scans |
| `dev` | no | persistent local dev task |
| `preview:*`, `deploy:*`, `migrate:*`, `rollback:*` | no | remote-state mutation; never served from cache |

CI uses Turborepo remote caching with `TURBO_TOKEN` and `TURBO_TEAM`, plus `--affected` for PR gates.
Deployment jobs use `--filter=<workspace>...` to build only the Worker/app graph being deployed.
Every build-affecting environment variable must be listed in `globalEnv` or task `env` so preview and
production builds cannot reuse the wrong cache entry.

Local hook policy lives in [local-quality-gates.md](./local-quality-gates.md). Commit hooks block
format, lint, type, Knip, and Gitleaks failures before code is committed. The pre-push hook runs the
same validation set as CI except hosted smoke tests and remote-state mutations.

## Package layout

```
packages/
  ui/           @splitch/ui          Design system (Tailwind 4 tokens + primitives)
  contracts/    @splitch/contracts   Zod schemas, z.infer types, @hono/zod-openapi routes
  client/       @splitch/client      Hono hc HTTP client

apps/
  panel/        Control panel Worker (TanStack Start, SSR, authenticated, live updates)
  marketing/    Marketing site Worker (TanStack Start, prerendered, unauthenticated)

workers/
  control-plane-api/  Control Plane API Worker (Hono, @hono/zod-openapi, admin CRUD)
  mcp/                MCP Worker (remote MCP protocol adapter, calls @splitch/client)
  evaluation/         Evaluation Worker (SDK evaluate/peek, dry-run test-eval)
  event-ingest/       Event Ingest Worker (append-only event validation, queues, delivery)
  analysis/           Analysis Worker (Tinybird proxy reads, stats/result contracts)
  auth-issuer/        Auth Issuer Worker (minimal auth surface; see auth spec)
```

## Worker topology contract

These Workers are separate deploy units because they are separate capability and trust seams. Do
not collapse them into generic `api` or `edge` Workers during slicing.

| Worker | Boundary | Owns | Does not own |
|---|---|---|---|
| Control Plane API Worker | Authenticated management API | Org, App, Environment, Flag, Flag Configuration, Promotion, Experiment, Run, Metric, Segment, and SDK credential mutations | MCP transport, SDK evaluate, event ingest, Tinybird result reads |
| MCP Worker | Agent protocol adapter | Remote MCP auth handshake, tool registry, calls through `@splitch/client` | D1/KV/Tinybird bindings, domain invariants |
| Evaluation Worker | SDK/data-plane resolution | Client Key/API Key evaluation, peek, control-plane dry-run test-eval, Provider + Assignment Store reads | Config writes, analysis queries, direct Metric computation |
| Event Ingest Worker | Append-only event intake | Assignment/Exposure/Metric event validation, queueing, sharded DO dedup, Tinybird delivery | Variant resolution, result calculation, control-plane CRUD |
| Analysis Worker | Result read model | Tinybird proxy endpoints, SRM/Metric/statistical result reads, `app_id`/`environment_id` injection from auth/path context | SDK evaluate, event ingest, config mutation |
| Auth Issuer Worker | Identity/token surface | AuthKit/auth.md/OAuth endpoints, token/revocation flows, provisional create handoff | Post-create Org/App management, SDK credentials, analytics |

Shared code belongs in `packages/` only when the deletion test passes. Worker bindings and
capability-specific orchestration stay local to the owning Worker. The public seam should stay
shallow; the module behind it can be deep.

## Two frontend Workers (separate deploy units)

**Panel Worker** (`apps/panel`):
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

| Side | Responsibility |
|---|---|
| `ui` package | Tailwind 4 `@theme` tokens; framework primitives: Button, Card, Input, Dialog, skeletons, error/empty states |
| Panel app | Domain-aware components (RunStatusBadge, SRM panel, Experiment table) composed from `ui` primitives |
| Marketing app | Marketing-specific feature/page components composed from `ui` primitives |

`ui` knows nothing about the domain — it never imports a Run, Experiment, or Exposure type. Two
real consumers (panel, marketing) = the deletion test passes = real seam, not speculative.

**Versioning:** `ui` ships as a monorepo-internal package. A version bump triggers both Workers to
rebuild at the same `ui` version. Breaking API changes in `ui` require a deprecation phase
(old API coexists with new during a transition window) before removal.

## TanStack Query as sole state store

Both frontend Workers use TanStack Query. No Redux, Zustand, or second synced server-state store
exists. `useState` / local component state holds ephemeral UI state only (form input, open/closed).

**Query key factory** (panel app, not in `ui`):
- All keys are entity-rooted and hierarchical under `['app', appId, ...]`
- Example: `['app', appId, 'experiment', expId, 'runs']`
- Invalidate by prefix: a nudge for `experiment/{expId}` invalidates
  `['app', appId, 'experiment', expId]` prefix, catching list + detail + sub-resources
- The factory is the single source of key shapes; WebSocket nudge handler invalidates through it,
  never by hand-assembling arrays

**Version-gated against self-edits:** nudge carries `version`; if cached version ≥ nudge version,
skip refetch (the writer already has the new state from its 200 response).

## Auth and session boundary (panel)

- Session is an HTTP cookie, validated server-side in the TanStack Start server handler
- Validated result `{ userId, orgs }` (memberships across all the user's Orgs) enters loader context
- Active Org/App/Environment are URL segments (`/{orgSlug}/{appSlug}/{env}/...`); loader resolves
  slugs to IDs and validates membership (403 on no access; 404 when the app is not under that org)
- Session issuer: WorkOS AuthKit (WorkOS session issuer rule) behind the `cookie → server validation → loader
  context` seam (seam is issuer-agnostic)

## Error boundaries (panel)

Three tiers at fixed route-tree levels:

| Tier | Location | Catches |
|---|---|---|
| Root | App shell | Catastrophic/unexpected; renders full "something broke" page |
| Segment | `/{orgSlug}/{appSlug}/{env}` layout + major sections | Expected domain failures: 403 (no access), 404 (not found); designed states, not stack traces |
| Background refetch | Nudge refetch path | Non-fatal stale-with-toast; never unmounts good data |

Expected domain failures (403/404) are **not** Sentry errors — they are normal control flow.
Failed background refetch is a low-severity breadcrumb, not a page break.

## Observability

- Distributed trace context propagates: SSR loader → read API and client fetch → read API
- `userId`, `appId`, `role` set once at session-validation seam; all downstream Sentry events tagged
- Targeting Key and Evaluation Context attributes are scrubbed from Sentry (may carry customer PII)

## Cron Workers (v1 scope)

Two scheduled Workers:

| Worker | Cadence | What it does |
|---|---|---|
| Demo reaper | Configurable (default: daily) | Deletes provisional/demo Organizations past their TTL; routes through D1 data-access seam (ADR-0022) |
| Tinybird snapshot | Configurable (default: hourly) | Triggers Copy Pipe run to refresh first-touch snapshot (ADR-0024) |

Both Workers are separate Cloudflare Cron Triggers, not inline with the API Worker.

## Sources

- [../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md](../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md)
- [../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md](../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md)
- [../../adr/0020-tanstack-start-for-both-control-panel-and-marketing-shared-component-layer.md](../../adr/0020-tanstack-start-for-both-control-panel-and-marketing-shared-component-layer.md)
- [../../adr/0031-mutation-testing-is-advisory-before-it-is-a-gate.md](../../adr/0031-mutation-testing-is-advisory-before-it-is-a-gate.md)
- [../../architecture/frontend-architecture.md](../../architecture/frontend-architecture.md)
- WorkOS session issuer rule (WorkOS as session issuer)
