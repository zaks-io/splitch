/**
 * @splitch/db — the authoritative D1 schema AND the single tenant-isolation
 * data-access seam (ADR-0018).
 *
 * Consumers (control-plane-api, analysis-api, auth-api) get D1 access ONLY
 * through `createRepository`, whose every tenant-scoped method binds
 * `app_id` (+ `environment_id` on per-Environment tables) as a mandatory WHERE.
 * The raw Drizzle client is constructed inside `repo/` and is NEVER exported, so
 * no raw client escapes this layer and a cross-App / app_id-less query is
 * unconstructible by type. The depcruise + Semgrep rules backstop this by
 * forbidding any module outside `repo/` from importing `drizzle-orm/d1`.
 *
 * The table objects are still exported because drizzle-kit (migration codegen)
 * and the schema migration test read them; they are inert column definitions,
 * not a query handle.
 */

export type {
  ApprovalCommit,
  ApprovalDisposition,
  ApprovalFailure,
  Repository,
} from "./repo/index";
// The tenant-isolation seam: the only public way to reach D1. The scope
// constructors come straight from the internal scope module (this root barrel
// is INSIDE packages/db, so reaching repo/* is allowed; outside code cannot).
// biome-ignore lint/performance/noBarrelFile: package public-API entry (exports "." → index.js); the seam + schema surface is intentionally aggregated here
export { createRepository } from "./repo/index";
export type { EnvScope, TenantScope } from "./repo/scope";
export { appScope, envScope } from "./repo/scope";
export type { ScopedTable } from "./repo/scoped-table";

export {
  apiKeys,
  appMemberships,
  approvalRequests,
  approvalReviews,
  apps,
  clientKeys,
  deviceRefreshSessions,
  entityDeletions,
  environments,
  experiments,
  flagConfigs,
  flags,
  metrics,
  organizations,
  orgMemberships,
  privacyRequests,
  runs,
  segments,
  targetingRules,
  trustedIdps,
  variants,
} from "./schema/index";
