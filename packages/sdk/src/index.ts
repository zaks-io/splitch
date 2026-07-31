export type { SplitchClient, SplitchClientOptions } from "./client";
// biome-ignore lint/performance/noBarrelFile: package public-API entry (exports "." → index.js); the SDK surface is intentionally aggregated here
export { createSplitchClient } from "./client";
export {
  formatSdkErrorMessage,
  resolveErrorDocsUrl,
  sdkClientErrorCodes,
  sdkErrorCodes,
  SplitchSdkError,
} from "./errors";
export type { ActionableErrorDetail, SdkClientErrorCode, SplitchSdkErrorCode } from "./errors";
export type { EvaluateContext, EvaluationContext, Logger } from "./evaluate";
export type {
  ErrorCode,
  ResolutionDetails,
  ResolutionReason,
  VariantValue,
} from "./generated/contract-surface.js";
