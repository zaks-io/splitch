import { type ErrorCode, ErrorCodeSchema } from "./generated/contract-surface.js";

export const sdkClientErrorCodes = [
  "SDK_CREDENTIAL_CONFIGURATION_INVALID",
  "SDK_RETRIES_INVALID",
  "SDK_SEEN_SET_MAX_SIZE_INVALID",
  "SDK_SEEN_SET_TTL_INVALID",
  "SDK_CACHED_TELEMETRY_FAILED",
  /** Local throw before/during fetch (network down, illegal invocation, etc.). */
  "SDK_TRANSPORT_NETWORK",
  /** Per-call timeout / AbortSignal abort — the request did not complete in time. */
  "SDK_TRANSPORT_TIMEOUT",
  /** HTTP 200 body that could not be parsed as the expected shape. */
  "SDK_TRANSPORT_PARSE",
] as const;

export type SdkClientErrorCode = (typeof sdkClientErrorCodes)[number];
export type SplitchSdkErrorCode = ErrorCode | SdkClientErrorCode;

export const sdkErrorCodes: readonly SplitchSdkErrorCode[] = [
  ...ErrorCodeSchema.options,
  ...sdkClientErrorCodes,
];

export interface ActionableErrorDetail<Code extends string = SplitchSdkErrorCode> {
  readonly code: Code;
  readonly causeSummary: string;
  readonly remediation: string;
  readonly status?: number | null;
  readonly originalError?: unknown;
}

function sentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function formatSdkErrorMessage(detail: ActionableErrorDetail<string>): string {
  return `${detail.code}: Cause: ${sentence(detail.causeSummary)} Remediation: ${sentence(detail.remediation)} Docs: ${resolveErrorDocsUrl(detail.code)}`;
}

/**
 * Public documentation origin. Every documented failure code (server `ErrorCode`,
 * `SDK_*`, `CLI_*`) has a page at `/docs/error/{code}`, so the code itself is the
 * slug and no lookup table can drift from the enum.
 */
const DOCS_ORIGIN = "https://splitch.dev";

export function resolveErrorDocsUrl(code: string): string {
  return `${DOCS_ORIGIN}/docs/error/${code}`;
}

export class SplitchSdkError extends Error {
  readonly code: SplitchSdkErrorCode;
  readonly causeSummary: string;
  readonly remediation: string;
  readonly status: number | null;
  readonly docsUrl: string;

  constructor(detail: ActionableErrorDetail) {
    super(formatSdkErrorMessage(detail), { cause: detail.originalError });
    this.name = "SplitchSdkError";
    this.code = detail.code;
    this.causeSummary = sentence(detail.causeSummary);
    this.remediation = sentence(detail.remediation);
    this.status = detail.status ?? null;
    this.docsUrl = resolveErrorDocsUrl(detail.code);
  }
}
