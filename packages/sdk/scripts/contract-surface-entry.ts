/**
 * Build-only entry: bundles the minimal contracts surface the public SDK needs.
 * tsup reads this file and emits src/generated/contract-surface.{js,d.ts}.
 * Do not import this module from runtime code outside the build.
 */
export {
  DataPlaneEvaluateResponseSchema,
  EvaluateAllEntrySchema,
  EvaluateAllReasonSchema,
  EvaluateAllRequestSchema,
  EvaluateAllResponseSchema,
  PeekEvaluateResponseSchema,
  ResolutionDetailsSchema,
  type EvaluateAllEntry,
  type EvaluateAllReason,
  type EvaluateAllRequest,
  type EvaluateAllResponse,
  type ResolutionDetails,
  type ResolutionReason,
  type VariantValue,
} from "../../contracts/src/sdk-data-plane-surface";
export { ErrorCodeSchema, type ErrorCode } from "../../contracts/src/error-code";
