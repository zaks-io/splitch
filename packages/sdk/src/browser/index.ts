export type { ActionableErrorDetail, SdkClientErrorCode, SplitchSdkErrorCode } from "../errors";
// biome-ignore lint/performance/noBarrelFile: package public-API entry for `@splitch/sdk/browser`
export {
  formatSdkErrorMessage,
  resolveErrorDocsUrl,
  SplitchSdkError,
  sdkClientErrorCodes,
  sdkErrorCodes,
} from "../errors";
export type { EvaluateContext, Logger } from "../evaluate";
export type {
  ErrorCode,
  EvaluateAllEntry,
  EvaluateAllReason,
  ExposureBatchResult,
  ResolutionReason,
  VariantValue,
} from "../generated/contract-surface.js";
export type { SdkResolutionDetails as ResolutionDetails } from "../resolution";
export type {
  FlagChangeListener,
  SplitchBrowserClient,
  SplitchBrowserClientOptions,
} from "./client";
export { createSplitchBrowserClient } from "./client";
