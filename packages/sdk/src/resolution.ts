import type { SplitchSdkErrorCode } from "./errors";
import type {
  ResolutionDetails as ContractResolutionDetails,
  ErrorCode,
  ResolutionReason,
  VariantValue,
} from "./generated/contract-surface.js";
import type { TransportFailure, TransportResult } from "./transport";

/**
 * SDK-facing ResolutionDetails: wire `ErrorCode` values plus client-only
 * `SDK_TRANSPORT_*` codes for failures that never left the process.
 */
export type SdkResolutionDetails = Omit<ContractResolutionDetails, "errorCode"> & {
  readonly errorCode?: SplitchSdkErrorCode;
};

/**
 * Synthesize the OpenFeature `ResolutionDetails` from the `{ variant, variantName }`
 * wire body plus the HTTP status. The wire response is intentionally non-revealing
 * — the resolved arm and nothing about how it was chosen (ADR-0018) — so
 * `reason`/`errorCode` are derived here, never sent by the server. This is the
 * contract that makes fail-loud usable: every transport outcome becomes one
 * structured result the caller branches on via `reason`.
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
 * against the contract it consumes, HTTP outcomes emit the WIRE `ErrorCode` (the
 * spec's "Error responses" status table). Local transport failures emit distinct
 * `SDK_TRANSPORT_*` codes from `sdkClientErrorCodes` — never the server's
 * `SERVICE_UNAVAILABLE`.
 *
 *   200 + variant present  -> SPLIT    (resolved Variant,  Exposure fires)
 *   200 + variant null     -> DEFAULT  (Default Variant,   Exposure fires)
 *   401                    -> ERROR    UNAUTHORIZED
 *   403                    -> ERROR    FORBIDDEN
 *   404                    -> ERROR    FLAG_NOT_FOUND
 *   400                    -> ERROR    VALIDATION_ERROR
 *   429                    -> ERROR    RATE_LIMITED
 *   503                    -> ERROR    SERVICE_UNAVAILABLE  (server said so)
 *   local throw            -> ERROR    SDK_TRANSPORT_NETWORK
 *   timeout / abort        -> ERROR    SDK_TRANSPORT_TIMEOUT
 *   unparseable body       -> ERROR    SDK_TRANSPORT_PARSE
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

// Unexpected HTTP 5xx (not 503) folds to SERVICE_UNAVAILABLE: the provider was
// not reachable as an HTTP peer. `status: null` must never land here — the
// transport classifies local failures into `SDK_TRANSPORT_*` codes.
const FALLBACK_ERROR_CODE: ErrorCode = "SERVICE_UNAVAILABLE";

/** Fallback when a transport-level failure omitted an `errorCode` (should not happen). */
const FALLBACK_TRANSPORT_ERROR_CODE: SplitchSdkErrorCode = "SDK_TRANSPORT_NETWORK";

function isError(status: number | null): boolean {
  return status !== 200;
}

/** The error code the SDK surfaces for a non-200 HTTP outcome. */
export function errorCodeForStatus(status: number | null): SplitchSdkErrorCode {
  if (status === null) {
    return FALLBACK_TRANSPORT_ERROR_CODE;
  }
  return ERROR_CODE_BY_STATUS[status] ?? FALLBACK_ERROR_CODE;
}

function errorMessageForStatus(
  status: number | null,
  errorCode = errorCodeForStatus(status),
): string {
  if (status === null) {
    switch (errorCode) {
      case "SDK_TRANSPORT_TIMEOUT":
        return "splitch evaluate timed out at the transport";
      case "SDK_TRANSPORT_PARSE":
        return "splitch evaluate received an unparseable transport body";
      default:
        return "splitch evaluate failed at the transport (local/network error)";
    }
  }
  return `splitch evaluate failed: HTTP ${status} (${errorCode})`;
}

/**
 * Build a successful (non-error) `ResolutionDetails` for a 200 outcome. A present
 * variant is SPLIT; an absent one is DEFAULT. The caller supplies the Default
 * Variant value used when the wire `variant` is null.
 */
function resolveSuccess(result: TransportResult, defaultValue: VariantValue): SdkResolutionDetails {
  const matched = result.variant !== null;
  const reason: ResolutionReason = matched ? "SPLIT" : "DEFAULT";
  return {
    // The arm label comes off the wire; on a no-match there is no arm, and the
    // value is the caller's Default Variant, which no Variant name describes.
    value: matched ? result.variant : defaultValue,
    variantName: matched ? result.variantName : null,
    reason,
  };
}

/**
 * Fail-loud `ResolutionDetails`: returns the Default Variant with `reason: ERROR`
 * and the mapped `errorCode` so the host app keeps rendering, but the failure is
 * never disguised as a real resolution (ADR-0036). Fires no Exposure (the caller
 * in evaluate.ts never reaches the seen-set write on this path).
 */
function resolveError(result: TransportFailure, defaultValue: VariantValue): SdkResolutionDetails {
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
): SdkResolutionDetails {
  return isError(result.status)
    ? resolveError(result, defaultValue)
    : resolveSuccess(result, defaultValue);
}
