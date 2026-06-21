# Platform spec

Storage, infrastructure, toolchain, and cross-cutting contracts for splitch.

Spine idea: **`app_id` is the isolation boundary; KV/D1 serve the hot path; Tinybird owns
append-only analytics; every seam is clean, non-superpositioned, and self-healing on failure.**

## Files

| File | One-line purpose |
|---|---|
| [storage-map.md](./storage-map.md) | Canonical table: what data lives in KV, D1, DO, Tinybird, Analytics Engine, and why |
| [privacy-data-lifecycle.md](./privacy-data-lifecycle.md) | Privacy roles, export/delete lifecycle, Entity tombstones, retention, redaction |
| [config-store.md](./config-store.md) | Draft/live config, `liveRunId`, no separate-copy property, config write failure contract |
| [assignment-store-substrate.md](./assignment-store-substrate.md) | KV-read / DO-write split for holdover sticky experience; consistency window and failure semantics |
| [exposure-pipeline.md](./exposure-pipeline.md) | Raw append-only log as system of record; dedup at query time; Exposure row schema; SRM denominator |
| [physical-dedup-engine.md](./physical-dedup-engine.md) | Lambda architecture: Copy Pipe snapshot + real-time tail UNION; rollup MV correctness constraint |
| [live-updates-do.md](./live-updates-do.md) | Per-App fan-out DO: hibernating WebSocket, write-through, delta-nudge, persisted-before-announced |
| [multi-tenant-isolation.md](./multi-tenant-isolation.md) | App-enforced `app_id` isolation in D1 (Drizzle seam) and Tinybird (two-seam enforcement) |
| [contracts-and-validation.md](./contracts-and-validation.md) | Zod-first authoring; package split; KV schema-version envelope; one canonical ErrorResponse |
| [monorepo-and-toolchain.md](./monorepo-and-toolchain.md) | pnpm + Turborepo layout; capability Workers; shared `ui` seam; TanStack Query; cron Workers; StrykerJS policy |
| [local-quality-gates.md](./local-quality-gates.md) | Git hooks, CI-parity pre-push, Biome, TypeScript, Knip, Gitleaks, dependency-cruiser, local validation policy |
| [deployment-pipeline.md](./deployment-pipeline.md) | GitHub Actions on Blacksmith with Turborepo cache; PR CI with Tinybird Local; shared preview; production rollback rules |

Architecture map: [system-architecture.md](../../architecture/system-architecture.md) lays out the
Worker fleet, trust boundaries, runtime flows, and dependency-cruiser enforcement.

## Key invariants

1. **No separate config-copy seam.** Editing and serving share KV/D1 directly. No cross-system copy.
2. **KV is a cache, D1 is truth.** KV miss always has a D1 fallback path; never bypass D1 as truth.
3. **ELT, not ETL.** Raw Exposure log is the system of record; dedup is at query time, re-runnable.
4. **Rollup MVs build on the deduped snapshot, never the raw log.** Correctness constraint.
5. **Tinybird is never queried directly.** All reads proxy through a control-plane endpoint that
   injects `app_id` from auth context.
6. **One authored source: Zod.** Types, client, OpenAPI, MCP schemas are all derived. Nothing
   generated is committed.
7. **DO writes are persisted-before-announced** (both the per-App fan-out DO and the Assignment
   Store DO). Broadcasts only describe durable state.
8. **Privacy tombstones win immediately.** Delete requests stop future use before every physical
   purge finishes.
9. **PR CI is local; shared preview is explicit.** PRs validate against disposable local services by
   default; the hosted shared preview target is updated only on maintainer intent.
10. **Bad commits should fail before they leave the machine.** Commit hooks block format/lint/type
    drift and secret leaks; pre-push mirrors CI except hosted smoke/deploy steps.

## Cross-links

- Evaluation path uses the Assignment Store read: [../evaluation/](../evaluation/)
- Exposure event contract (field-level schema): [exposure-pipeline.md](./exposure-pipeline.md)
- Auth issuer surface: [../control-plane/](../control-plane/)
- Stats engine input contract (per-Entity Metric rows): [../stats/](../stats/)
- Privacy lifecycle and deletion/export: [privacy-data-lifecycle.md](./privacy-data-lifecycle.md)
