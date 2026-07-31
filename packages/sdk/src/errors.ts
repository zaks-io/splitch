import { ErrorCodeSchema, type ErrorCode } from "./generated/contract-surface.js";

export const sdkClientErrorCodes = [
  "SDK_CREDENTIAL_CONFIGURATION_INVALID",
  "SDK_RETRIES_INVALID",
  "SDK_SEEN_SET_MAX_SIZE_INVALID",
  "SDK_SEEN_SET_TTL_INVALID",
  "SDK_CACHED_TELEMETRY_FAILED",
] as const;

export type SdkClientErrorCode = (typeof sdkClientErrorCodes)[number];
export type SplitchSdkErrorCode = ErrorCode | SdkClientErrorCode;

export const sdkErrorCodes: readonly SplitchSdkErrorCode[] = [
  ...ErrorCodeSchema.options,
  ...sdkClientErrorCodes,
];

export interface ActionableErrorDetail {
  readonly code: SplitchSdkErrorCode;
  readonly cause: string;
  readonly remediation: string;
  readonly status?: number | null;
}

function sentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function formatSdkErrorMessage(detail: ActionableErrorDetail): string {
  return `${detail.code}: Cause: ${sentence(detail.cause)} Remediation: ${sentence(detail.remediation)}`;
}

/** Future per-code documentation seam. Keep undefined until real documentation URLs exist. */
export function resolveErrorDocsUrl(_code: string): string | undefined {
  return undefined;
}

export class SplitchSdkError extends Error {
  readonly code: SplitchSdkErrorCode;
  override readonly cause: string;
  readonly remediation: string;
  readonly status: number | null;
  readonly docsUrl: string | undefined;

  constructor(detail: ActionableErrorDetail) {
    super(formatSdkErrorMessage(detail));
    this.name = "SplitchSdkError";
    this.code = detail.code;
    this.cause = sentence(detail.cause);
    this.remediation = sentence(detail.remediation);
    this.status = detail.status ?? null;
    this.docsUrl = resolveErrorDocsUrl(detail.code);
  }
}
