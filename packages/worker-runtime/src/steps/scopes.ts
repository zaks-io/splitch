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

  // App co-scope. A null `appId` means the credential is bound to NO App (an
  // org-level control-plane token, or a data-plane key not yet app-bound). The
  // App IS the tenant boundary, so a route that co-scopes on `:appId` requires
  // that binding: a null App axis is FORBIDDEN, not a silent pass (principal.ts:
  // "a route that requires co-scope on a null axis is a FORBIDDEN"). This rejects
  // before any repository call, so an app_id-less context never reaches the seam.
  const pathAppId = params.appId;
  if (pathAppId !== undefined && principal.appId !== pathAppId) {
    return forbidden("credential is not scoped to this app");
  }

  // Environment co-scope. Unlike the App axis, a null `environmentId` is NOT a
  // rejection: a control-plane token binds an App but selects the Environment by
  // path within that App (ADR-0027), so it is legitimately env-unbound. Only a
  // credential that IS bound to a specific Environment (a per-Environment
  // data-plane key) is held to it; a mismatch there is FORBIDDEN.
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
