# All-Cloudflare stack: Workers edge for serving + control plane, Tinybird for analytics

**Status:** accepted

splitch adopts the agent-paste scaffolding — pnpm + Turborepo monorepo, TypeScript strict,
React 19 + TanStack Router/Query + Tailwind 4 on the front, Hono on Cloudflare Workers for the
edge API, Biome for lint/format, Vitest (+ Stryker on critical domains), Wrangler + GitHub Actions
for deploy, Sentry + Axiom for observability — and keeps the platform **all-Cloudflare for serving
and control**, with **Tinybird as the analytics system of record**. Two planes, both edge-native
on the serving side:

- **Cloudflare Workers — the serving hot path and the reactive control plane, one platform.**
  Assignment evaluation, Exposure firing, and the SDK-facing edge run on Workers: KV serves the
  hot-path read (ADR-0009), per-key Durable Objects serialize the first-touch write (ADR-0009),
  Workers append Exposure events downstream. The **config-authoring dashboard reuses the same
  primitive**: config lives in KV/D1, and a **Durable Object fans out live updates (SSE/WebSocket)**
  to subscribed dashboards — the agent-paste `ArtifactLiveUpdates` / `stream` pattern, applied to
  config. Editing surface and serving surface are the **same store**, so there is **no cross-system
  config-copy step**: an edit writes config to KV/D1, and the hot path reads it directly.
- **Tinybird (managed ClickHouse) — the analytics system of record.** The raw append-only
  Exposure/event log (ADR-0010) and its materialized metric rollups live in Tinybird. Columnar,
  unsampled, real windowed-query SQL — a genuine fit for ELT-with-query-time-dedup, the exact
  substrate ADR-0010 needs.

This is one platform end to end on the serving/control side, edge-native, with Tinybird as the
single specialized analytical sink. The data-volume gradient runs **KV/D1 + DO (config + hot path,
edge) → Tinybird (huge, append-only, analytical)** — each store sized for its load.

## Considered options

- **Convex as a reactive control plane** — rejected. Convex's one real advantage is reactive
  queries for free, but a config-authoring dashboard is low-volume, low-concurrency, single-digit
  editors — the easy case for a hand-rolled DO + SSE fan-out, which agent-paste already ships a
  reference for. Against that one advantage: Convex is a **third datastore**, **not edge-resident**
  (a cross-region hop the all-edge product can't take on the hot path), carries a **cost ceiling**
  that scales badly with volume, and — decisively — **forces a Convex → KV config-copy seam**
  (Convex can't bind to KV; it would need a binding-holding Worker it pushes to). So Convex doesn't
  remove Cloudflare from the control plane, it adds itself *on top* of it and bolts a sync seam back
  on. Staying all-Cloudflare deletes that seam instead of building it. (Reconsider only if the
  control plane becomes genuinely collaborative — live multi-editor, presence, optimistic
  concurrency — where rolling our own reactivity becomes real work. "Configure experiments, watch
  runs" is not that.)
- **Postgres/Drizzle (agent-paste's layer) as-is** — rejected for splitch's shape: the analytical
  workload (raw Exposure log + materialized rollups over high-volume append-only data) is a
  columnar/warehouse job, not a row-store OLTP one.
- **Cloudflare Analytics Engine as the authoritative Exposure log** — rejected as system of record:
  it is **sampled (lossy by design)**, short-retention, low-dimensionality, with a query surface
  that can't run ADR-0010's windowed first-touch dedup or SRM-denominator math on complete data. You
  cannot losslessly dedup data that silently dropped rows. agent-paste used it because it is the
  in-platform default, not because it fits trustworthy experiment data. It survives in splitch
  **only for non-critical system/ops telemetry** (request rates, error counts — where approximate is
  fine), never as experiment or Exposure data.
- **Tinybird also driving the live config UI** — rejected: Tinybird is analytical, not a reactive
  document store; the authoring surface wants the DO live-update fan-out, and config is low-volume
  and edge-local in KV/D1 already.

## Consequences

- **Two datastores to operate** (Cloudflare KV/D1 + Tinybird), not three. The control plane adds no
  new platform — it is a Durable Object SSE/WebSocket fan-out over the same KV/D1 the hot path
  reads, copied from agent-paste's streaming pattern. The DO fan-out is the only net-new piece to
  build.
- **No config-copy seam.** Because editing and serving share KV/D1, there is no cross-system copy
  to keep atomic — the class of bug a Convex → KV copy would have introduced does not exist.
  Validation and any versioned/atomic-swap discipline live in the Worker that writes config, in one
  place. ADR-0009 (KV read / DO write) is untouched; this is the same substrate, now also backing
  config.
- **Tinybird is ADR-0010's physical substrate.** The "raw append-only log, deduped at query time"
  decision lands on Tinybird's columnar SQL + materialized views; the physical dedup engine
  (lambda — snapshot + real-time UNION) is pinned in ADR-0024.
- **Metric rollup MVs feed the deduped snapshot, never the raw log.** A materialized view fires per
  inserted block and never sees merged or cross-block state, so an AggregatingMergeTree rollup built
  straight off the raw Exposure log cannot dedup the redundant-by-design edge events (ADR-0004) — they
  leak in and silently inflate the SRM denominator and every metric count, the exact correctness
  ADR-0010 exists to protect. Rollups therefore build on the deduped snapshot datasource (ADR-0024),
  not the raw log. This is a constraint, not an option.
- The shared shell (monorepo layout, contracts-first OpenAPI/Zod, Biome/Vitest/Stryker quality
  gates, Wrangler deploy, Sentry/Axiom observability) is copied from agent-paste wholesale; only the
  analytics layer (Tinybird in place of Postgres/Analytics Engine) diverges. Scaffolding detail is
  implementation, not a re-litigable decision.
