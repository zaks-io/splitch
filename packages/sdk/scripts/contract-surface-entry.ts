/**
 * Build-only entry: bundles the minimal @splitch/contracts surface the public SDK
 * needs. tsup reads this file and emits src/generated/contract-surface.{js,d.ts}.
 * Do not import this module from runtime code outside the build.
 */
export {
  DataPlaneEvaluateResponseSchema,
  PeekEvaluateResponseSchema,
} from "../../contracts/src/wire-envelopes-core";
export { ResolutionDetailsSchema } from "../../contracts/src/leaf-schemas-runtime";
export type {
  ResolutionDetails,
  ResolutionReason,
  VariantValue,
} from "../../contracts/src/leaf-schemas-runtime";
export { ErrorCodeSchema } from "../../contracts/src/errors";
export type { ErrorCode } from "../../contracts/src/errors";
