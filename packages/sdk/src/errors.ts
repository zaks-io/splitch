import { type ErrorCode, errorCodes } from "./generated/contract-surface.js";

export const sdkClientErrorCodes = [
  "SDK_CREDENTIAL_CONFIGURATION_INVALID",
  "SDK_RETRIES_INVALID",
  "SDK_SEEN_SET_MAX_SIZE_INVALID",
  "SDK_SEEN_SET_TTL_INVALID",
  "SDK_CACHED_TELEMETRY_FAILED",
  /** `crypto.randomUUID` is missing, so the SDK cannot mint a replay identity. */
  "SDK_IDEMPOTENCY_KEY_UNAVAILABLE",
  /** Browser client read before `init()` resolved (and no bootstrap). */
  "SDK_NOT_INITIALIZED",
  /** Browser client constructed with an invalid Evaluation Context. */
  "SDK_CONTEXT_INVALID",
  /** Browser bootstrap was evaluated for a different Evaluation Context. */
  "SDK_BOOTSTRAP_CONTEXT_MISMATCH",
  /** A React binding hook rendered outside SplitchProvider. */
  "SDK_REACT_PROVIDER_MISSING",
  /** Local throw before/during fetch (network down, illegal invocation, etc.). */
  "SDK_TRANSPORT_NETWORK",
  /** Per-call timeout / AbortSignal abort — the request did not complete in time. */
  "SDK_TRANSPORT_TIMEOUT",
  /** HTTP 200 body that could not be parsed as the expected shape. */
  "SDK_TRANSPORT_PARSE",
] as const;

export type SdkClientErrorCode = (typeof sdkClientErrorCodes)[number];
export type SplitchSdkErrorCode = ErrorCode | SdkClientErrorCode;

// `concat` + `@__PURE__` (not an array-literal spread) so bundlers drop this
// binding — and with it the server code table — when a consumer never imports
// it; the browser payload budget assumes that.
export const sdkErrorCodes: readonly SplitchSdkErrorCode[] = /* @__PURE__ */ (
  errorCodes as readonly SplitchSdkErrorCode[]
).concat(sdkClientErrorCodes);

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
