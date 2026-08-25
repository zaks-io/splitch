// biome-ignore-all lint/performance/noBarrelFile: internal sub-barrel of ../index.ts, which stays the only supported import path for these symbols

/**
 * Curated wire-envelope public surface (incl. Exposure batch for ADR-0048).
 * Kept here so packages/contracts/src/index.ts stays under the file-size ratchet
 * without an unbounded `export *` from wire-envelopes-core.
 */
export type {
  DataPlaneEvaluateRequest,
  DataPlaneEvaluateResponse,
  EvaluateAllEntry,
  EvaluateAllReason,
  EvaluateAllRequest,
  EvaluateAllResponse,
  ExposureBatchItem,
  ExposureBatchRequest,
  ExposureBatchResponse,
  ExposureBatchResult,
  ExposureBatchResultStatus,
  PaginationQuery,
  PeekEvaluateResponse,
  RuleSelection,
  TestEvaluationReason,
  TestEvaluationRequest,
  TestEvaluationResponse,
} from "../wire-envelopes-core";
export {
  CachedEvaluationTelemetryRequestSchema,
  CachedEvaluationTelemetryResponseSchema,
  DataPlaneEvaluateRequestSchema,
  DataPlaneEvaluateResponseSchema,
  EvaluateAllEntrySchema,
  EvaluateAllReasonSchema,
  EvaluateAllRequestSchema,
  EvaluateAllResponseSchema,
  EXPOSURE_BATCH_MAX_BODY_BYTES,
  EXPOSURE_BATCH_MAX_ITEMS,
  ExposureBatchItemSchema,
  ExposureBatchRequestSchema,
  ExposureBatchResponseSchema,
  ExposureBatchResultSchema,
  ExposureBatchResultStatusSchema,
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_MAX_LIMIT,
  PaginationQuerySchema,
  PeekEvaluateResponseSchema,
  paginatedResponse,
  RuleSelectionSchema,
  TestEvaluationReasonSchema,
  TestEvaluationRequestSchema,
  TestEvaluationResponseSchema,
} from "../wire-envelopes-core";
export {
  RETRYABLE_EXPOSURE_REJECTION_CODE,
  RETRYABLE_EXPOSURE_REJECTION_CODES,
} from "../exposure-retry-codes";
export type { EnvironmentExposureStatusResponse } from "../environment-exposure-status";
export { EnvironmentExposureStatusResponseSchema } from "../environment-exposure-status";
export type { FlagConfigurationSummary } from "../resource-envelopes-flag";
