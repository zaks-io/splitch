/**
 * Public SDK contract surface: re-exports the canonical data-plane leaves only.
 *
 * Every export is the same schema object used by server contracts and covered by
 * existing contract tests. See `sdk-data-plane-surface.parity.test.ts`.
 */
// biome-ignore lint/performance/noBarrelFile: intentional narrow public SDK contract surface
export { type ErrorCode, ErrorCodeSchema } from "./errors";
export {
  type DataPlaneEvaluateResponse,
  DataPlaneEvaluateResponseSchema,
  type PeekEvaluateResponse,
  PeekEvaluateResponseSchema,
} from "./leaves/data-plane-evaluate-wire";
export {
  type EvaluateAllEntry,
  EvaluateAllEntrySchema,
  type EvaluateAllReason,
  EvaluateAllReasonSchema,
  type EvaluateAllRequest,
  EvaluateAllRequestSchema,
  type EvaluateAllResponse,
  EvaluateAllResponseSchema,
} from "./leaves/evaluate-all-wire";
export {
  EXPOSURE_BATCH_MAX_BODY_BYTES,
  EXPOSURE_BATCH_MAX_ITEMS,
  type ExposureBatchItem,
  ExposureBatchItemSchema,
  type ExposureBatchRequest,
  ExposureBatchRequestSchema,
  type ExposureBatchResponse,
  ExposureBatchResponseSchema,
  type ExposureBatchResult,
  ExposureBatchResultSchema,
  type ExposureBatchResultStatus,
  ExposureBatchResultStatusSchema,
} from "./leaves/exposures-wire";
export {
  type ResolutionDetails,
  ResolutionDetailsSchema,
  type VariantValue,
} from "./leaves/resolution-details";
export type { ResolutionReason } from "./leaves/resolution-reason";
