/**
 * Public SDK contract surface: re-exports the canonical data-plane leaves only.
 *
 * Every export is the same schema object used by server contracts and covered by
 * existing contract tests. See `sdk-data-plane-surface.parity.test.ts`.
 */
// biome-ignore lint/performance/noBarrelFile: intentional narrow public SDK contract surface
export {
  DataPlaneEvaluateResponseSchema,
  PeekEvaluateResponseSchema,
  type DataPlaneEvaluateResponse,
  type PeekEvaluateResponse,
} from "./leaves/data-plane-evaluate-wire";
export {
  ResolutionDetailsSchema,
  type ResolutionDetails,
  type VariantValue,
} from "./leaves/resolution-details";
export type { ResolutionReason } from "./leaves/resolution-reason";
export { ErrorCodeSchema, type ErrorCode } from "./errors";
