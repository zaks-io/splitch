export type { SplitchClient, SplitchClientOptions } from "./client";
// biome-ignore lint/performance/noBarrelFile: package public-API entry (exports "." → index.js); the SDK surface is intentionally aggregated here
export { createSplitchClient } from "./client";
export type { ActionableErrorDetail, SdkClientErrorCode, SplitchSdkErrorCode } from "./errors";
export {
  formatSdkErrorMessage,
  resolveErrorDocsUrl,
  SplitchSdkError,
  sdkClientErrorCodes,
  sdkErrorCodes,
} from "./errors";
export type { EvaluateContext, EvaluationContext, Logger } from "./evaluate";
export type {
  ErrorCode,
  ResolutionReason,
  VariantValue,
} from "./generated/contract-surface.js";
export type { SdkResolutionDetails as ResolutionDetails } from "./resolution";
