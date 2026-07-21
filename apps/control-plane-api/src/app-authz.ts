import { appScope } from "@splitch/db";
import { renderError } from "@splitch/worker-runtime";
import { appAdminScope } from "./scope-binding";

const APP_WRITE_ROLES = ["owner", "admin"] as const;
const APP_DELETE_ROLES = ["owner"] as const;

type AppRole = "owner" | "admin" | "member";
interface AppAuthzDeps {
  repo: {
    identity: {
      getAppMembership(
        scope: ReturnType<typeof appScope>,
        userId: string,
      ): PromiseLike<{ role: string } | null>;
    };
  };
}
export interface ScopedActor {
  id: string;
  scopes: readonly string[];
}

export async function requireAppAdmin(
  deps: AppAuthzDeps,
  appId: string,
  actor: ScopedActor,
  requestId: string,
): Promise<Response | null> {
  return requireAppRole(deps, appId, actor, APP_WRITE_ROLES, requestId);
}

export async function requireAppWrite(
  deps: AppAuthzDeps,
  appId: string,
  actor: ScopedActor,
  requestId: string,
): Promise<Response | null> {
  return requireAppRole(deps, appId, actor, APP_WRITE_ROLES, requestId);
}

export async function requireAppDelete(
  deps: AppAuthzDeps,
  appId: string,
  actor: ScopedActor,
  requestId: string,
): Promise<Response | null> {
  return requireAppRole(deps, appId, actor, APP_DELETE_ROLES, requestId);
}

async function requireAppRole(
  deps: AppAuthzDeps,
  appId: string,
  actor: ScopedActor,
  allowedRoles: readonly AppRole[],
  requestId: string,
): Promise<Response | null> {
  const scopeError = requireAppRoleFromScopes(appId, actor.scopes, allowedRoles, requestId);
  if (scopeError) return scopeError;

  const membership = await deps.repo.identity.getAppMembership(appScope(appId), actor.id);
  if (membership && allowedRoles.includes(membership.role as AppRole)) return null;
  return insufficientAppRole(appId, allowedRoles, actor.scopes, requestId);
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
