import { getRoute } from "@splitch/contracts";

const IDEMPOTENCY_HEADER = "idempotency-key";

/** The per-request options shape `hcRequestOptions` produces. */
export interface HcRequestOptions {
  headers?: Record<string, string>;
}

/**
 * Lift a route's idempotency key into the `Idempotency-Key` header.
 *
 * `worker-runtime/steps/idempotency.ts` reads the HEADER and nothing else, so a
 * body-only `idempotency_key` does not satisfy an `idempotency: "required"`
 * route (SPL-261). Where the contract gives the route a request body the key
 * travels in BOTH places with the same value, so a JSON-only caller (MCP tools,
 * the CLI) and an SDK caller name the same replay.
 *
 * Fails loud when a `required` route has no key: an unsatisfiable request must
 * name its own defect here rather than come back as a far-end VALIDATION_ERROR
 * the caller has to decode (ADR-0036).
 */
export function withIdempotencyHeader(
  operationId: string,
  options: HcRequestOptions,
  idempotencyKey: string | undefined,
): HcRequestOptions {
  const route = getRoute(operationId);
  if (!route) {
    throw new Error(`control-plane-sdk: unknown operation "${operationId}"`);
  }
  if (route.idempotency === "none") {
    return options;
  }
  if (idempotencyKey === undefined) {
    if (route.idempotency === "required") {
      throw new Error(`control-plane-sdk: ${operationId} requires an idempotency key`);
    }
    return options;
  }
  return { ...options, headers: { ...options.headers, [IDEMPOTENCY_HEADER]: idempotencyKey } };
}
