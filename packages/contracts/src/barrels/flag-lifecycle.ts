// biome-ignore-all lint/performance/noBarrelFile: internal sub-barrel of ../index.ts, which stays the only supported import path for these symbols

// The Flag lifecycle vocabulary (D9): the writable classes, the stored state
// that adds `unclassified` for pre-existing Flags, and the one rule saying which
// classes need an owner and an expiry. Worker, panel, and CLI read the same rule.
export { type FlagLifecycleInput, missingFlagLifecycleInputs } from "../flag-lifecycle";
export {
  type FlagLifecycleClass,
  FlagLifecycleClassSchema,
  flagLifecycleClasses,
  type StoredFlagLifecycleClass,
  StoredFlagLifecycleClassSchema,
} from "../leaf-schemas-flag";
export {
  DeleteFlagRequestSchema,
  FLAG_REMOVAL_BRIEF_CAVEATS,
  type DeleteFlagRequest,
  type FlagCodeRemovalClaim,
  type FlagCodeRemovalRecord,
  FlagCodeRemovalClaimSchema,
  FlagCodeRemovalRecordSchema,
  type FlagRemovalBriefResponse,
  type FlagRemovalEnvironmentServing,
  type FlagRemovalServingBlocker,
  FlagRemovalBriefResponseSchema,
  FlagRemovalEnvironmentServingSchema,
  FlagRemovalServingBlockerSchema,
} from "../flag-removal";
export { flagRemovalSdkCallShapes } from "../flag-removal-sdk-shapes";
