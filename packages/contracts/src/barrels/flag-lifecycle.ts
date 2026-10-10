// biome-ignore-all lint/performance/noBarrelFile: internal sub-barrel of ../index.ts, which stays the only supported import path for these symbols

export { type FlagLifecycleInput, missingFlagLifecycleInputs } from "../flag-lifecycle";
export {
  type DeleteFlagRequest,
  DeleteFlagRequestSchema,
  FLAG_REMOVAL_BRIEF_CAVEATS,
  type FlagCodeRemovalClaim,
  FlagCodeRemovalClaimSchema,
  type FlagCodeRemovalRecord,
  FlagCodeRemovalRecordSchema,
  type FlagRemovalBriefResponse,
  FlagRemovalBriefResponseSchema,
  type FlagRemovalEnvironmentServing,
  FlagRemovalEnvironmentServingSchema,
  type FlagRemovalServingBlocker,
  FlagRemovalServingBlockerSchema,
} from "../flag-removal";
export { flagRemovalSdkCallShapes } from "../flag-removal-sdk-shapes";
export {
  FLAG_AGE_BUCKET_BOUNDS,
  FLAG_AGE_BUCKETS,
  FLAG_STALE_THRESHOLDS,
  FLAG_UNIFORM_SERVING_HISTORY_WINDOW_DAYS,
  type FlagAgeBucket,
  type FlagStaleThresholds,
  flagAgeBucket,
} from "../flag-stale-thresholds";
export {
  type FlagLifecycleClass,
  FlagLifecycleClassSchema,
  flagLifecycleClasses,
  type StoredFlagLifecycleClass,
  StoredFlagLifecycleClassSchema,
} from "../leaf-schemas-flag";
// The Flag lifecycle vocabulary (D9): the writable classes, the stored state
// that adds `unclassified` for pre-existing Flags, and the one rule saying which
// classes need an owner and an expiry. Worker, panel, and CLI read the same rule.
// Stale response vocabulary (3.6) and inventory age buckets (3.8) live here too.
export {
  SERVING_EVIDENCE_UNVERIFIED,
  type ServingEvidence,
  type StaleReason,
  type UniformEnvironmentEvidence,
  type UniformServingMode,
  type UniformServingSignal,
} from "../resource-envelopes-flag-health";
