/**
 * @splitch/db — the authoritative Drizzle table definitions for the D1 corpus.
 *
 * Consumers (control-plane-api, analysis-api, auth-api) import the named tables
 * and build their data-access seam on top of them. No raw Drizzle client is used
 * outside that seam (ADR-0018).
 */

// biome-ignore lint/performance/noBarrelFile: package public-API entry (exports "." → index.js); the D1 schema surface is intentionally aggregated here
export {
  apiKeys,
  appMemberships,
  apps,
  clientKeys,
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
} from "./schema/index.js";
