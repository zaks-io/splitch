import {
  type ErrorResponse,
  MEMBERSHIP_WIDE_READ_AUTHORIZATION,
  type RouteContract,
} from "@splitch/contracts";
import type { Principal, PrincipalMemberships } from "../principal";

/**
 * Step 5. Enforce required scopes, then Org/App/Environment co-scope (ADR-0027).
 * Returns an ErrorResponse to reject, or null to proceed.
 *
 * Scope check first (INSUFFICIENT_SCOPES names what was required vs held), then
 * co-scope: where the path carries `orgId`/`appId`/`environmentId`, the principal
 * must be bound to the same value. A principal not bound to an axis the route
 * scopes on is FORBIDDEN, not a silent pass.
 */
export function enforceScopes(
  contract: RouteContract,
  principal: Principal,
  params: Record<string, string>,
): ErrorResponse | null {
  const authorizationError = membershipWideReadError(contract, principal);
  if (authorizationError) return authorizationError;

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

  // Org co-scope. The Org is the tenant boundary one level above the App, so a
  // route that co-scopes on `:orgId` (every `/orgs/:orgId/*` operation) requires
  // the principal to be bound to that Org. A null `orgId` means the credential is
  // bound to NO single Org (it named zero or many Org scopes), which on an
  // Org-scoped route is FORBIDDEN, not a silent pass: an org-unbound token must
  // not read or manage an Org by path. Authenticated selector normalization may
  // already have run, but an org_id-less context never reaches the handler or an
  // Org resource repository call.
  const pathOrgId = params.orgId;
  if (pathOrgId !== undefined && !organizationAccessCovers(principal, pathOrgId)) {
    return forbidden("credential is not scoped to this organization");
  }

  // App co-scope. A null `appId` means the credential is bound to NO App (an
  // org-level control-plane token, or a data-plane key not yet app-bound). The
  // App IS the tenant boundary, so a route that co-scopes on `:appId` requires
  // that binding: a null App axis is FORBIDDEN, not a silent pass (principal.ts:
  // "a route that requires co-scope on a null axis is a FORBIDDEN"). An opted-in
  // selector resolver may bind a null axis from one matching signed App scope;
  // otherwise it never reaches the handler or an App resource repository call.
  const pathAppId = params.appId;
  if (pathAppId !== undefined && !appAccessCovers(principal, pathAppId)) {
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

function membershipWideReadError(
  contract: RouteContract,
  principal: Principal,
): ErrorResponse | null {
  if (principal.authorization !== MEMBERSHIP_WIDE_READ_AUTHORIZATION) return null;
  if (contract.method !== "GET") return forbidden("credential grants read access only");
  requireWideMemberships(principal);
  return null;
}

export function requireWideMemberships(principal: Principal): PrincipalMemberships {
  if (!principal.memberships) {
    throw new Error("worker-runtime: membership-wide principal has no live memberships");
  }
  return principal.memberships;
}

export function organizationAccessCovers(principal: Principal, organizationId: string): boolean {
  if (principal.authorization === MEMBERSHIP_WIDE_READ_AUTHORIZATION) {
    return requireWideMemberships(principal).organizations.some(
      (membership) => membership.id === organizationId,
    );
  }
  return principal.orgId === organizationId;
}

export function appAccessCovers(principal: Principal, appId: string): boolean {
  if (principal.authorization === MEMBERSHIP_WIDE_READ_AUTHORIZATION) {
    return requireWideMemberships(principal).apps.some((membership) => membership.id === appId);
  }
  return principal.appId === appId;
}

function forbidden(message: string): ErrorResponse {
  return { code: "FORBIDDEN", message, details: {} };
}
