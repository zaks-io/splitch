import type { ErrorResponse, RouteContract } from "@splitch/contracts";
import type { Principal } from "../principal.js";

/**
 * Step 5. Enforce required scopes, then App/Environment co-scope (ADR-0027).
 * Returns an ErrorResponse to reject, or null to proceed.
 *
 * Scope check first (INSUFFICIENT_SCOPES names what was required vs held), then
 * co-scope: where the path carries `appId`/`environmentId`, the principal must be
 * bound to the same value. A principal not bound to an axis the route scopes on
 * is FORBIDDEN, not a silent pass.
 */
export function enforceScopes(
  contract: RouteContract,
  principal: Principal,
  params: Record<string, string>,
): ErrorResponse | null {
  const held = new Set(principal.scopes);
  const missing = contract.scopes.filter((scope) => !held.has(scope));
  if (missing.length > 0) {
    return {
      code: "INSUFFICIENT_SCOPES",
      message: "credential lacks required scopes",
      details: {
        requiredScopes: [...contract.scopes],
        heldScopes: [...principal.scopes],
      },
    };
  }

  const pathAppId = params.appId;
  if (pathAppId !== undefined && principal.appId !== null && principal.appId !== pathAppId) {
    return forbidden("credential is not scoped to this app");
  }

  const pathEnvId = params.environmentId;
  if (
    pathEnvId !== undefined &&
    principal.environmentId !== null &&
    principal.environmentId !== pathEnvId
  ) {
    return forbidden("credential is not scoped to this environment");
  }

  return null;
}

function forbidden(message: string): ErrorResponse {
  return { code: "FORBIDDEN", message, details: {} };
}
