/**
 * Build-only entry: bundles the minimal contracts surface the public SDK needs.
 * tsup reads this file and emits src/generated/contract-surface.{js,d.ts}.
 * Do not import this module from runtime code outside the build.
 */
export {
  DataPlaneEvaluateResponseSchema,
  PeekEvaluateResponseSchema,
  ResolutionDetailsSchema,
  type ResolutionDetails,
  type ResolutionReason,
  type VariantValue,
} from "../../contracts/src/sdk-data-plane-surface";
export { ErrorCodeSchema, type ErrorCode } from "../../contracts/src/errors";
