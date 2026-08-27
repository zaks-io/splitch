import {
  formatSdkErrorMessage,
  type ResolutionDetails,
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
  /** Structured refusal payload from the API; reaches the caller only under `--json`. */
  readonly details?: Record<string, unknown>;
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
  /**
   * The cause verbatim, as the server sent it or the call site wrote it.
   * `causeSummary` is the sentence-cased prose form the human channel prints;
   * re-punctuating a forwarded wire `message` would make the machine-readable
   * answer differ from the same refusal read over MCP.
   */
  readonly summary: string;
  readonly remediation: string;
  readonly docsUrl: string;
  readonly details: Record<string, unknown> | null;

  constructor(detail: CliErrorDetail) {
    super(formatSdkErrorMessage(detail), { cause: detail.originalError });
    this.name = "SplitchCliError";
    this.code = detail.code;
    this.summary = detail.causeSummary.trim();
    this.causeSummary = sentence(detail.causeSummary);
    this.remediation = sentence(detail.remediation);
    this.docsUrl = resolveErrorDocsUrl(detail.code);
    this.details = detail.details ?? null;
  }
}

export function cliErrorCodeForVerifyDetails(
  errorCode: ResolutionDetails["errorCode"],
): SplitchCliErrorCode {
  if (errorCode === "PROVIDER_NOT_READY") {
    throw new SplitchCliError({
      code: "CLI_UNEXPECTED_ERROR",
      causeSummary: "flags verify received the browser-only PROVIDER_NOT_READY staleness signal",
      remediation:
        "Report SDK contract drift; the server data-plane verify path has no stale browser cache",
    });
  }
  return errorCode ?? "CLI_DATA_PLANE_ERROR_CODE_MISSING";
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

/**
 * The one machine-readable failure shape, written to stdout under `--json`.
 *
 * `message` rather than `causeSummary` because the wire `ErrorResponse` already
 * uses it and API refusals are the common case: a caller should not need two
 * key names depending on whether the CLI or the server refused. It carries the
 * server's text verbatim, so the same refusal read over MCP compares equal
 * (`scripts/lib/cli-mcp-shared-operation.ts`). `remediation` and `docsUrl` are
 * the fields the raw wire error lacks, and the reason this shape exists rather
 * than forwarding `ErrorResponse` verbatim.
 */
interface CliErrorJson {
  readonly code: SplitchCliErrorCode;
  readonly message: string;
  readonly remediation: string;
  readonly docsUrl: string;
  readonly details: Record<string, unknown> | null;
}

function cliErrorJson(error: SplitchCliError): CliErrorJson {
  return {
    code: error.code,
    message: error.summary,
    remediation: error.remediation,
    docsUrl: error.docsUrl,
    details: error.details,
  };
}

/**
 * Prose on stderr always; under `--json` the same failure also lands on stdout
 * as one object, so an agent piping to `jq` gets a refusal it can branch on
 * instead of a sentence it has to regex.
 */
export function writeCliError(io: CliIo, error: CliErrorDetail | SplitchCliError): void {
  const normalized = error instanceof SplitchCliError ? error : new SplitchCliError(error);
  if (io.json) {
    io.log(JSON.stringify(cliErrorJson(normalized)));
  }
  io.error(normalized.message);
}
