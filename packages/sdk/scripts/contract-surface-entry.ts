/**
 * Build-only entry: bundles the minimal contracts surface the public SDK needs.
 * tsup reads this file and emits src/generated/contract-surface.{js,d.ts}.
 * Do not import this module from runtime code outside the build.
 */

export { type ErrorCode, ErrorCodeSchema } from "../../contracts/src/error-code";
export {
  DataPlaneEvaluateResponseSchema,
  type EvaluateAllEntry,
  type EvaluateAllReason,
  EvaluateAllResponseSchema,
  PeekEvaluateResponseSchema,
  type ResolutionDetails,
  ResolutionDetailsSchema,
  type ResolutionReason,
  type VariantValue,
} from "../../contracts/src/sdk-data-plane-surface";
