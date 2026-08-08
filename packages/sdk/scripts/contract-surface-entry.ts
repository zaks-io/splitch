/**
 * Build-only entry: hand-maintained zod-free mirrors for the public SDK
 * contract surface. tsup reads this file and emits
 * src/generated/contract-surface.{js,d.ts}; it does not generate the mirrors
 * from Zod. Authoring source of truth remains the contracts package.
 * `contract-surface-parity.test.ts` is the only lockstep guard. Do not import
 * this module from runtime code outside the build.
 */

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
// biome-ignore lint/performance/noBarrelFile: build-only tsup entry aggregating the hand-maintained mirrors
export {
  DataPlaneEvaluateResponseSchema,
  ErrorCodeSchema,
  EvaluateAllResponseSchema,
  PeekEvaluateResponseSchema,
  ResolutionDetailsSchema,
} from "./contract-surface-validators";
