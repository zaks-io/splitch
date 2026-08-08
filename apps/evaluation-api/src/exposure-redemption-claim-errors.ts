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

/**
 * Durable Object returned a non-OK HTTP status. Deterministic only for the
 * handler vocabulary (400 / 404 / 409); other statuses are classified by
 * exposureClaimFaultCode (platform injection → retryable).
 */
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
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "ExposureRedemptionClaimProtocolError";
  }
}
