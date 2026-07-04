import { appScope, type Repository } from "@splitch/db";
import { renderError } from "@splitch/worker-runtime";
import { appAdminScope } from "./scope-binding";

const APP_WRITE_ROLES = ["owner", "admin"] as const;
const APP_DELETE_ROLES = ["owner"] as const;

type AppRole = "owner" | "admin" | "member";
type AppAuthzDeps = { repo: Pick<Repository, "identity"> };

export function requireAppAdmin(
  appId: string,
  heldScopes: readonly string[],
  requestId: string,
): Response | null {
  return requireAppRoleFromScopes(appId, heldScopes, ["admin"], requestId);
}

export async function requireAppWrite(
  deps: AppAuthzDeps,
  appId: string,
  userId: string,
  requestId: string,
): Promise<Response | null> {
  return requireAppRoleFromMembership(deps, appId, userId, APP_WRITE_ROLES, requestId);
}

export async function requireAppDelete(
  deps: AppAuthzDeps,
  appId: string,
  userId: string,
  requestId: string,
): Promise<Response | null> {
  return requireAppRoleFromMembership(deps, appId, userId, APP_DELETE_ROLES, requestId);
}

async function requireAppRoleFromMembership(
  deps: AppAuthzDeps,
  appId: string,
  userId: string,
  allowedRoles: readonly AppRole[],
  requestId: string,
): Promise<Response | null> {
  const membership = await deps.repo.identity.getAppMembership(appScope(appId), userId);
  if (membership && allowedRoles.includes(membership.role as AppRole)) return null;
  return insufficientAppRole(
    appId,
    allowedRoles,
    membership ? [`app:${appId}:${membership.role}`] : [],
    requestId,
  );
}

function requireAppRoleFromScopes(
  appId: string,
  heldScopes: readonly string[],
  allowedRoles: readonly AppRole[],
  requestId: string,
): Response | null {
  const requiredScopes = scopesForRoles(appId, allowedRoles);
  if (requiredScopes.some((scope) => heldScopes.includes(scope))) return null;
  return insufficientAppRole(appId, allowedRoles, heldScopes, requestId);
}

function scopesForRoles(appId: string, roles: readonly AppRole[]): string[] {
  return roles.map((role) => (role === "admin" ? appAdminScope(appId) : `app:${appId}:${role}`));
}

function insufficientAppRole(
  appId: string,
  allowedRoles: readonly AppRole[],
  heldScopes: readonly string[],
  requestId: string,
): Response {
  return renderError(
    {
      code: "INSUFFICIENT_SCOPES",
      message: "principal lacks required App role",
      details: { requiredScopes: scopesForRoles(appId, allowedRoles), heldScopes: [...heldScopes] },
    },
    { requestId },
  );
}
