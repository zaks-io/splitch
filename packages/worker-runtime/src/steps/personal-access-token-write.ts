import {
  type ApiRouteContract,
  type ApprovalOperation,
  type ErrorResponse,
  getRoute,
  getRouteMembershipGate,
  type PersonalAccessTokenPermission,
  type RouteContract,
  scopeSatisfiesMembershipGate,
} from "@splitch/contracts";
import { scopeBinding } from "../mcp-delegation-auth";
import type { Principal } from "../principal";
import { enforceScopes } from "./scopes";

export type NarrowOutcome =
  | { ok: true; principal: Principal }
  | { ok: false; error: ErrorResponse };

const approvalOperationRoutes = {
  flag_config_update: "flag_config_update",
  flag_targeting_rules_replace: "flag_targeting_rules_replace",
  flags_promote: "flags_promote",
  flag_variants_create: "flag_variants_create",
  flag_variants_update: "flag_variants_update",
  flag_variants_delete: "flag_variants_delete",
  flags_delete: "flags_delete",
  segments_update: "segments_update",
  experiments_start: "experiments_start",
  experiment_winner_promote: "conclusion_promotion_requests_create",
} satisfies Record<ApprovalOperation, string>;

/** Select permission authority before selector resolution and handler role checks. */
export function narrowPersonalAccessTokenForRoute(
  contract: RouteContract,
  principal: Principal,
  params: Record<string, string>,
): NarrowOutcome {
  if (!principal.personalAccessToken) return { ok: true, principal };
  const route = getRoute(contract.id);
  if (!route)
    return refuse(`personal access token cannot authorize unregistered operation ${contract.id}`);
  switch (route.permission) {
    case "read":
    case "owner-cleanup":
    case "derived":
      return { ok: true, principal };
    case "session-only":
      return refuse("a login session is required; run splitch login");
    case "write":
    case "delete":
    case "credentials":
    case "members":
    case "privacy":
      return narrowPersonalAccessTokenForPermission(route.permission, principal, params, {
        targeted: /:(orgId|appId)\b/.test(route.path),
      });
    default:
      return refuse(
        `personal access token cannot authorize operation ${contract.id} without a permission declaration`,
      );
  }
}

/** Used for the write permission on a decline, whose route otherwise derives its permission. */
export function narrowPersonalAccessTokenForPermission(
  permission: PersonalAccessTokenPermission,
  principal: Principal,
  params: Record<string, string>,
  options: { targeted: boolean },
): NarrowOutcome {
  const token = principal.personalAccessToken;
  if (!token) return { ok: true, principal };
  const authority = token.permissions[permission];
  if (!options.targeted && !authority.all) return missingPermission(permission, "all");
  const target = targetOf(params);
  const canonical = params.appId?.startsWith("app_") || params.orgId?.startsWith("org_");
  if (
    options.targeted &&
    !authority.scopes.some((scope) =>
      canonical ? scope.startsWith(`${target}:`) : scope.startsWith(params.appId ? "app:" : "org:"),
    )
  )
    return missingPermission(permission, target);
  return {
    ok: true,
    principal: { ...principal, scopes: authority.scopes, ...scopeBinding(authority.scopes) },
  };
}

/** Recheck a stored proposal using the current token, never the proposer's authority. */
export function narrowPersonalAccessTokenForOperation(
  operationId: string,
  principal: Principal,
  params: Record<string, string>,
): NarrowOutcome {
  const routeId = Object.hasOwn(approvalOperationRoutes, operationId)
    ? approvalOperationRoutes[operationId as ApprovalOperation]
    : operationId;
  const route = getRoute(routeId);
  if (!route)
    return refuse(`personal access token cannot authorize unregistered operation ${operationId}`);
  const narrowed = narrowPersonalAccessTokenForRoute(route, principal, params);
  if (!narrowed.ok || !principal.personalAccessToken) return narrowed;
  return enforceOperationRole(route, narrowed.principal, params);
}

function enforceOperationRole(
  route: ApiRouteContract,
  principal: Principal,
  params: Record<string, string>,
): NarrowOutcome {
  const gate = getRouteMembershipGate(route.operationId);
  const target = gate.axis === "app" ? params.appId : params.orgId;
  if (!hasRequiredRole(gate, principal.scopes, target))
    return refuse(
      `personal access token needs ${route.permission} permission at ${gate.minimumRole} role for ${targetOf(params)}`,
    );
  const bound = {
    ...principal,
    ...(gate.axis === "app" ? { appId: target ?? null } : {}),
    ...(gate.axis === "org" ? { orgId: target ?? null } : {}),
  };
  const scopeError = enforceScopes(route, bound, params);
  return scopeError ? { ok: false, error: scopeError } : { ok: true, principal: bound };
}

function hasRequiredRole(
  gate: ReturnType<typeof getRouteMembershipGate>,
  scopes: readonly string[],
  target: string | undefined,
): boolean {
  if (!gate.minimumRole) return true;
  if (!target) return false;
  return scopes.some(
    (scope) =>
      scope.startsWith(`${gate.axis}:${target}:`) &&
      scopeSatisfiesMembershipGate(scope, `${gate.axis}:${gate.minimumRole}`),
  );
}

/** Selector failures must retain the permission and user-supplied target that were narrowed. */
export function personalAccessTokenSelectorError(
  contract: RouteContract,
  principal: Principal,
  params: Record<string, string>,
  error: ErrorResponse,
): ErrorResponse {
  if (!principal.personalAccessToken) return error;
  const permission = getRoute(contract.id)?.permission;
  if (!permission || ["read", "owner-cleanup", "session-only", "derived"].includes(permission))
    return error;
  if (
    error.code !== "FORBIDDEN" &&
    !(error.code === "APP_NOT_FOUND" && params.appId && !params.appId.startsWith("app_"))
  )
    return error;
  return {
    code: "FORBIDDEN",
    message: `personal access token needs ${permission} permission for ${targetOf(params)}; target could not be authorized`,
    details: {},
  };
}

function targetOf(params: Record<string, string>): string {
  return params.appId ? `app:${params.appId}` : params.orgId ? `org:${params.orgId}` : "all";
}

function missingPermission(
  permission: PersonalAccessTokenPermission,
  target: string,
): NarrowOutcome {
  return refuse(`personal access token needs ${permission} permission for ${target}`);
}

function refuse(message: string): NarrowOutcome {
  return { ok: false, error: { code: "FORBIDDEN", message, details: {} } };
}
