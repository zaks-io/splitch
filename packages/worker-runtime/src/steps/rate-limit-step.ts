import type { ErrorResponse, RouteContract } from "@splitch/contracts";
import type { RegistrarDeps } from "../deps";
import type { Principal } from "../principal";

/** Fail-closed retry window when a guarded limiter throws and gives us no number. */
const FAIL_CLOSED_RETRY_MS = 1000;

/**
 * Step 4. Apply the route's rate-limit class. Returns an ErrorResponse to reject,
 * or null to proceed. `none` short-circuits. Per the spec, a guarded class whose
 * binding throws fails CLOSED — the request is rejected as RATE_LIMITED, never
 * allowed through on binding failure.
 */
export async function applyRateLimit(
  contract: RouteContract,
  deps: RegistrarDeps,
  request: Request,
  principal: Principal,
): Promise<ErrorResponse | null> {
  if (contract.rateLimit === "none") {
    return null;
  }

  try {
    const decision = await deps.rateLimiter({
      class: contract.rateLimit,
      request,
      principal,
    });
    if (!decision.limited) {
      return null;
    }
    return rateLimited(decision.retryAfterMs);
  } catch {
    return rateLimited(FAIL_CLOSED_RETRY_MS);
  }
}

function rateLimited(retryAfterMs: number): ErrorResponse {
  return {
    code: "RATE_LIMITED",
    message: "rate limit exceeded",
    details: { retryAfterMs },
  };
}
