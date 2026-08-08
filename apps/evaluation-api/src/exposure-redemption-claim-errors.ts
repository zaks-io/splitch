/**
 * Typed claim-store faults so the exposures route can distinguish a transient
 * Durable Object transport failure from a deterministic protocol/HTTP fault
 * (docs/spec/sdk/exposures-endpoint.md).
 */

/** stub.fetch threw — retryable SERVICE_UNAVAILABLE. */
export class ExposureRedemptionClaimTransportError extends Error {
  constructor(cause?: unknown) {
    super("exposure redemption claim Durable Object transport failed", { cause });
    this.name = "ExposureRedemptionClaimTransportError";
  }
}

/** Durable Object returned a non-OK HTTP status — deterministic for 400; never silently retryable. */
export class ExposureRedemptionClaimHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`exposure redemption claim Durable Object returned HTTP ${status}`);
    this.name = "ExposureRedemptionClaimHttpError";
    this.status = status;
  }
}

/** DO response body did not match the claim/ack protocol — deterministic. */
export class ExposureRedemptionClaimProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExposureRedemptionClaimProtocolError";
  }
}
