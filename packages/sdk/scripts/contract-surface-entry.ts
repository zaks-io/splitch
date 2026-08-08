/**
 * Build-only entry: zod-free validators for the public SDK contract surface.
 * tsup reads this file and emits src/generated/contract-surface.{js,d.ts}.
 *
 * Authoring source of truth remains Zod in the contracts package. This entry
 * re-exports the compiled validators so the published package ships zero
 * runtime zod. Do not import this module from runtime code outside the build.
 */

export type {
  ExposureBatchItem,
  ExposureBatchRequest,
  ExposureBatchResponse,
  ExposureBatchResult,
  ExposureBatchResultStatus,
} from "./contract-surface-exposures";
export {
  EXPOSURE_BATCH_MAX_BODY_BYTES,
  EXPOSURE_BATCH_MAX_ITEMS,
  ExposureBatchRequestSchema,
  ExposureBatchResponseSchema,
} from "./contract-surface-exposures";
export type {
  DataPlaneEvaluateResponse,
  ErrorCode,
  EvaluateAllEntry,
  EvaluateAllReason,
  EvaluateAllResponse,
  PeekEvaluateResponse,
  ResolutionDetails,
  ResolutionReason,
  VariantValue,
} from "./contract-surface-validators";
export {
  DataPlaneEvaluateResponseSchema,
  ErrorCodeSchema,
  EvaluateAllResponseSchema,
  PeekEvaluateResponseSchema,
  ResolutionDetailsSchema,
} from "./contract-surface-validators";
