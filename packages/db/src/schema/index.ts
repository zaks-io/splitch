/**
 * The authoritative Drizzle D1 schema for the whole splitch corpus, split by
 * domain so no single file passes the 300-line guard. drizzle-kit reads this
 * barrel (see drizzle.config.ts) to generate the migration set; consumers import
 * the named tables from here.
 */

// biome-ignore lint/performance/noBarrelFile: package schema entry — drizzle-kit reads it and consumers import named tables from one place
export { approvalRequests, approvalReviews } from "./approvals";
export { apiKeys, clientKeys } from "./credentials";
export { eventDefinitions, eventDefinitionVersions } from "./event-definitions";
export { experiments, metrics, runs } from "./experiments";
export { flagConfigs, flags, segments, targetingRules, variants } from "./flags";
export {
  appMemberships,
  apps,
  claimConsentAttempts,
  claimIdempotency,
  claimVerifications,
  deviceRefreshSessions,
  environments,
  organizations,
  orgMemberships,
  trustedIdps,
} from "./identity";
export { entityDeletions, privacyRequests } from "./privacy";
