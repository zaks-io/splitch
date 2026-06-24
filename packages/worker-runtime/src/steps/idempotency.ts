import type { ErrorResponse, RouteContract } from "@splitch/contracts";

const IDEMPOTENCY_HEADER = "idempotency-key";
const MAX_KEY_LENGTH = 255;

/**
 * Step 6. Validate the Idempotency-Key header against the route's mode. The guard
 * owns header presence/shape only; durable replay claims live in the owning
 * data-access layer (the guard never stores anything).
 *
 * - `required`: header must be present and well-formed, else VALIDATION_ERROR.
 * - `optional`: if present it must be well-formed; absence is fine.
 * - `none`: not validated (a stray header is ignored, not an error).
 */
export function checkIdempotency(contract: RouteContract, request: Request): ErrorResponse | null {
  if (contract.idempotency === "none") {
    return null;
  }

  const key = request.headers.get(IDEMPOTENCY_HEADER);

  if (key === null) {
    if (contract.idempotency === "required") {
      return invalid("Idempotency-Key header is required for this route");
    }
    return null;
  }

  if (!isWellFormed(key)) {
    return invalid("Idempotency-Key header is malformed");
  }

  return null;
}

function isWellFormed(key: string): boolean {
  return key.length > 0 && key.length <= MAX_KEY_LENGTH;
}

function invalid(message: string): ErrorResponse {
  return {
    code: "VALIDATION_ERROR",
    message,
    details: { issues: [{ path: ["headers", "idempotency-key"], message }] },
  };
}
