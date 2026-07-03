import type {
  ErrorCode,
  ResolutionDetails,
  ResolutionReason,
  VariantValue,
} from "@splitch/contracts";
import type { TransportFailure, TransportResult } from "./transport.js";

/**
 * Synthesize the OpenFeature `ResolutionDetails` from the bare `{ variant }` wire
 * body plus the HTTP status. The wire response is intentionally non-revealing —
 * variant only (ADR-0018) — so `reason`/`errorCode` are derived here, never sent
 * by the server. This is the contract that makes fail-loud usable: every transport
 * outcome becomes one structured result the caller branches on via `reason`.
 *
 * Canonical mapping (docs/spec/sdk/public-evaluate-endpoint.md
 * §"HTTP status to ResolutionDetails mapping" + §"Error responses").
 *
 * IMPORTANT — spec/contract drift, resolved toward the type we consume:
 * the spec's mapping table names OpenFeature `errorCode` strings
 * (PROVIDER_NOT_READY, PROVIDER_FATAL, INVALID_CONTEXT, GENERAL). The MERGED
 * `@splitch/contracts` `ResolutionDetails.errorCode` is bound to the WIRE
 * `ErrorCode` enum (errors.ts), which does NOT contain those OpenFeature members
 * — it contains the wire `ErrorResponse.code` set. To keep the SDK type-correct
 * against the contract it consumes, the SDK emits the WIRE `ErrorCode` (the spec's
 * "Error responses" status table, lines 166-174), which the contract validates,
 * rather than an OpenFeature string the contract would reject at parse time.
 *
 *   200 + variant present  -> SPLIT    (resolved Variant,  Exposure fires)
 *   200 + variant null     -> DEFAULT  (Default Variant,   Exposure fires)
 *   401                    -> ERROR    UNAUTHORIZED
 *   403                    -> ERROR    FORBIDDEN
 *   404                    -> ERROR    FLAG_NOT_FOUND
 *   400                    -> ERROR    VALIDATION_ERROR
 *   429                    -> ERROR    RATE_LIMITED
 *   503 / network / timeout / parse -> ERROR SERVICE_UNAVAILABLE
 *
 * DISABLED, CACHED, and STALE are not synthesizable from the bare data-plane body
 * (DISABLED is indistinguishable from DEFAULT on the wire; CACHED is produced by
 * the seen-set path in evaluate.ts, never the transport). A 200 with no variant is
 * therefore reported as DEFAULT, the conservative non-error reading.
 */

const ERROR_CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "FLAG_NOT_FOUND",
  429: "RATE_LIMITED",
  503: "SERVICE_UNAVAILABLE",
};

// A status with no explicit row — incl. `null` (network / timeout / parse) and any
// unexpected 5xx — folds to SERVICE_UNAVAILABLE: the provider was not reachable.
const FALLBACK_ERROR_CODE: ErrorCode = "SERVICE_UNAVAILABLE";

function isError(status: number | null): boolean {
  return status !== 200;
}

/** The wire `ErrorCode` the SDK surfaces for a non-200 outcome. */
export function errorCodeForStatus(status: number | null): ErrorCode {
  if (status === null) {
    return FALLBACK_ERROR_CODE;
  }
  return ERROR_CODE_BY_STATUS[status] ?? FALLBACK_ERROR_CODE;
}

function errorMessageForStatus(
  status: number | null,
  errorCode = errorCodeForStatus(status),
): string {
  if (status === null) {
    return "splitch evaluate failed at the transport (network/timeout/parse)";
  }
  return `splitch evaluate failed: HTTP ${status} (${errorCode})`;
}

/**
 * Build a successful (non-error) `ResolutionDetails` for a 200 outcome. A present
 * variant is SPLIT; an absent one is DEFAULT. The caller supplies the Default
 * Variant value used when the wire `variant` is null.
 */
function resolveSuccess(result: TransportResult, defaultValue: VariantValue): ResolutionDetails {
  const matched = result.variant !== null;
  const reason: ResolutionReason = matched ? "SPLIT" : "DEFAULT";
  return {
    value: matched ? result.variant : defaultValue,
    variantName: null,
    reason,
  };
}

/**
 * Fail-loud `ResolutionDetails`: returns the Default Variant with `reason: ERROR`
 * and the mapped `errorCode` so the host app keeps rendering, but the failure is
 * never disguised as a real resolution (ADR-0036). Fires no Exposure (the caller
 * in evaluate.ts never reaches the seen-set write on this path).
 */
function resolveError(result: TransportFailure, defaultValue: VariantValue): ResolutionDetails {
  const errorCode = result.errorCode ?? errorCodeForStatus(result.status);
  return {
    value: defaultValue,
    variantName: null,
    reason: "ERROR",
    errorCode,
    errorMessage: result.errorMessage ?? errorMessageForStatus(result.status, errorCode),
  };
}

export function synthesizeDetails(
  result: TransportResult,
  defaultValue: VariantValue,
): ResolutionDetails {
  return isError(result.status)
    ? resolveError(result, defaultValue)
    : resolveSuccess(result, defaultValue);
}
