# Monorepo and toolchain: pnpm + Turborepo, two Workers, one ui package

Defines the physical package structure, the two Worker deploy units, the shared ui package
contract, and the toolchain/quality-gate stack.

## Toolchain

| Concern | Tool |
|---|---|
| Package manager | pnpm (workspaces) |
| Build orchestration | Turborepo |
| Language | TypeScript strict |
| Lint / format | Biome (single tool, no ESLint/Prettier split) |
| Unit tests | Vitest |
| Mutation testing | Stryker (on critical domains: evaluation, stats, dedup) |
| Deploy | Wrangler + GitHub Actions |
| Observability | Sentry (errors, distributed traces) + Axiom (structured logs, dashboards) |

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
  api/          Control-plane API Worker (Hono, @hono/zod-openapi)
  edge/         Data-plane / serving Worker (evaluation, Exposure firing)
  auth/         Auth-issuer Worker (minimal surface — see auth spec)
```

## Two frontend Workers (separate deploy units)

**Panel Worker** (`apps/panel`):
- TanStack Start, SSR with loader-seeded TanStack Query caches
- Authenticated; all routes check session membership against `:appId`
- Hibernating WebSocket attaches post-hydration per `/app/:appId` layout route
- Blast radius: authenticated control-plane sessions only

**Marketing Worker** (`apps/marketing`):
- TanStack Start, routes prerendered to static HTML at build time
- Unauthenticated; served from Cloudflare static assets for SEO/perf
- TanStack Query for live-data touchpoints (pricing, status) only
- Blast radius: public marketing surface; no auth, no App data

The two Workers are cleanly isolated at the deploy boundary. Component sharing happens at build
time through `@splitch/ui`, so isolation costs nothing.

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

Both Workers use TanStack Query. No Redux, Zustand, or second synced server-state store exists.
`useState` / local component state holds ephemeral UI state only (form input, open/closed).

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
- Validated result `{ userId, appMemberships, role }` enters loader context
- Active App is the URL (`/app/:appId/...`); loader validates session has membership for `:appId`
  or returns 403
- Session issuer: WorkOS AuthKit (WorkOS session issuer rule) behind the `cookie → server validation → loader
  context` seam (seam is issuer-agnostic)

## Error boundaries (panel)

Three tiers at fixed route-tree levels:

| Tier | Location | Catches |
|---|---|---|
| Root | App shell | Catastrophic/unexpected; renders full "something broke" page |
| Segment | `/app/:appId` layout + major sections | Expected domain failures: 403 (no access), 404 (not found); designed states, not stack traces |
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
- [../../architecture/frontend-architecture.md](../../architecture/frontend-architecture.md)
- WorkOS session issuer rule (WorkOS as session issuer)
