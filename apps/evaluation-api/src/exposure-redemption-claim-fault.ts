import type { ErrorCode } from "@splitch/contracts";

/**
 * Classified claim-store failure. The exposures route maps `kind` (+ HTTP status)
 * to a per-item ErrorCode so the SDK can distinguish retryable transport blips
 * from deterministic faults that must never be re-queued.
 *
 * docs/spec/sdk/exposures-endpoint.md
 */
export class ExposureRedemptionClaimFault extends Error {
  readonly kind: "transport" | "http" | "protocol";
  readonly status: number | null;

  constructor(
    message: string,
    options: {
      readonly kind: "transport" | "http" | "protocol";
      readonly status?: number;
      readonly cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ExposureRedemptionClaimFault";
    this.kind = options.kind;
    this.status = options.status ?? null;
  }
}

const CALLER_FAULT_CLAIM_HTTP_STATUSES = new Set([400]);

/**
 * Map a thrown claim-store failure to the per-item ErrorCode.
 * Transport (and non-400 DO HTTP) → SERVICE_UNAVAILABLE (SDK retries).
 * Protocol violation, DO HTTP 400, and any other throw (e.g. TypeError) →
 * INTERNAL_SERVER_ERROR (SDK drops).
 */
export function claimFailureCode(cause: unknown): ErrorCode {
  if (cause instanceof ExposureRedemptionClaimFault) {
    if (cause.kind === "transport") return "SERVICE_UNAVAILABLE";
    if (cause.kind === "http") {
      if (cause.status !== null && CALLER_FAULT_CLAIM_HTTP_STATUSES.has(cause.status)) {
        return "INTERNAL_SERVER_ERROR";
      }
      return "SERVICE_UNAVAILABLE";
    }
    return "INTERNAL_SERVER_ERROR";
  }
  return "INTERNAL_SERVER_ERROR";
}
