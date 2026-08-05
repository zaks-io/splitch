import {
  formatSdkErrorMessage,
  resolveErrorDocsUrl,
  SplitchSdkError,
  type SplitchSdkErrorCode,
  sdkErrorCodes,
} from "@splitch/sdk";
import type { CliIo } from "./execute-types.js";

export const cliClientErrorCodes = [
  "CLI_USAGE_INVALID",
  "CLI_VALIDATION_ERROR",
  "CLI_SCOPE_UNRESOLVED",
  "CLI_NOT_AUTHENTICATED",
  "CLI_SESSION_EXPIRED",
  "CLI_TOKEN_BINDING_REFUSED",
  "CLI_EMAIL_UNVERIFIED",
  "CLI_DEVICE_AUTHORIZATION_FAILED",
  "CLI_DEVICE_TOKEN_EXCHANGE_FAILED",
  "CLI_DEVICE_APPROVAL_TIMEOUT",
  "CLI_LOGOUT_REVOKE_FAILED",
  "CLI_API_ORIGIN_MISSING",
  "CLI_ROUTE_SURFACE_UNSUPPORTED",
  "CLI_OPERATION_UNKNOWN",
  "CLI_CONFIG_READ_FAILED",
  "CLI_CREDENTIAL_STORE_FAILED",
  "CLI_DATA_PLANE_ERROR_CODE_MISSING",
  "CLI_SERVER_CODE_UNRECOGNIZED",
  "CLI_UNEXPECTED_ERROR",
] as const;

export type CliClientErrorCode = (typeof cliClientErrorCodes)[number];
export type SplitchCliErrorCode = SplitchSdkErrorCode | CliClientErrorCode;

export const cliErrorCodes: readonly SplitchCliErrorCode[] = [
  ...sdkErrorCodes,
  ...cliClientErrorCodes,
];

export interface CliErrorDetail {
  readonly code: SplitchCliErrorCode;
  readonly causeSummary: string;
  readonly remediation: string;
  readonly originalError?: unknown;
}

export const formatCliError = formatSdkErrorMessage;

function sentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export class SplitchCliError extends Error {
  readonly code: SplitchCliErrorCode;
  readonly causeSummary: string;
  readonly remediation: string;
  readonly docsUrl: string;

  constructor(detail: CliErrorDetail) {
    super(formatSdkErrorMessage(detail), { cause: detail.originalError });
    this.name = "SplitchCliError";
    this.code = detail.code;
    this.causeSummary = sentence(detail.causeSummary);
    this.remediation = sentence(detail.remediation);
    this.docsUrl = resolveErrorDocsUrl(detail.code);
  }
}

export function normalizeCliError(error: unknown): SplitchCliError {
  if (error instanceof SplitchCliError) {
    return error;
  }
  if (error instanceof SplitchSdkError) {
    return new SplitchCliError({
      code: error.code,
      causeSummary: error.causeSummary,
      remediation: error.remediation,
      originalError: error,
    });
  }
  return new SplitchCliError({
    code: "CLI_UNEXPECTED_ERROR",
    causeSummary: error instanceof Error ? error.message : String(error),
    remediation: "Retry the command and report the code if the failure persists",
    originalError: error,
  });
}

export function writeCliError(io: CliIo, error: CliErrorDetail | SplitchCliError): void {
  io.error(error instanceof SplitchCliError ? error.message : formatSdkErrorMessage(error));
}
