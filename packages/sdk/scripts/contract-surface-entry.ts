/**
 * Build-only entry: zod-free surface for the public SDK contract types. tsup
 * reads this file and emits src/generated/contract-surface.{js,d.ts}. Its enum
 * members and required-key lists are generated from the contracts package by
 * `scripts/generate-contract-surface.mjs`, which runs first in the same
 * `generate` script; contracts remains the authoring source of truth. Lockstep
 * guards: `contract-surface-structural.test.ts` (shape),
 * `contract-surface-parity.test.ts` (behavior),
 * `contract-surface-proto-safe.test.ts` (derived runtime refinements), and
 * `contract-surface-assignability.ts` (types). Do not import this module from
 * runtime code outside the build.
 */

export type {
  ExposureBatchItem,
  ExposureBatchRequest,
  ExposureBatchResponse,
  ExposureBatchResult,
  ExposureBatchResultStatus,
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

import {
  EXPOSURE_BATCH_MAX_BODY_BYTES,
  EXPOSURE_BATCH_MAX_ITEMS,
  ExposureBatchRequestSchema,
  ExposureBatchResponseSchema,
} from "./contract-surface-exposures";
import {
  DataPlaneEvaluateResponseSchema,
  ErrorCodeSchema,
  EvaluateAllResponseSchema,
  PeekEvaluateResponseSchema,
  ResolutionDetailsSchema,
} from "./contract-surface-validators";

export {
  DataPlaneEvaluateResponseSchema,
  ErrorCodeSchema,
  EvaluateAllResponseSchema,
  EXPOSURE_BATCH_MAX_BODY_BYTES,
  EXPOSURE_BATCH_MAX_ITEMS,
  ExposureBatchRequestSchema,
  ExposureBatchResponseSchema,
  PeekEvaluateResponseSchema,
  ResolutionDetailsSchema,
};
