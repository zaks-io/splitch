import { MEMBERSHIP_WIDE_READ_AUTHORIZATION } from "@splitch/contracts";
import { appScope } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import { appAdminScope } from "./scope-binding";

const APP_WRITE_ROLES = ["owner", "admin"] as const;
const APP_DELETE_ROLES = ["owner"] as const;
const APP_MEMBER_ROLES = ["owner", "admin", "member"] as const;

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
export type ScopedActor = Pick<Principal, "id" | "scopes" | "authorization" | "memberships">;

export async function requireAppAdmin(
  deps: AppAuthzDeps,
  appId: string,
  actor: ScopedActor,
  requestId: string,
): Promise<Response | null> {
  return requireAppRole(deps, appId, actor, APP_WRITE_ROLES, requestId);
}

export async function requireAppMember(
  deps: AppAuthzDeps,
  appId: string,
  actor: ScopedActor,
  requestId: string,
): Promise<Response | null> {
  return requireAppRole(deps, appId, actor, APP_MEMBER_ROLES, requestId);
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
  const hasWideRole =
    actor.authorization === MEMBERSHIP_WIDE_READ_AUTHORIZATION &&
    actor.memberships?.apps.some(
      (membership) =>
        membership.id === appId &&
        allowedRoles.includes(membership.role) &&
        actor.memberships?.organizations.some(
          (organization) => organization.id === membership.organizationId,
        ),
    );
  if (!hasWideRole) {
    const scopeError = requireAppRoleFromScopes(appId, actor.scopes, allowedRoles, requestId);
    if (scopeError) return scopeError;
  }

  const membership = await deps.repo.identity.getAppMembership(appScope(appId), actor.id);
  if (membership && allowedRoles.includes(membership.role as AppRole)) return null;
  // Scopes already matched; naming the same scope as both required and held under
  // INSUFFICIENT_SCOPES is self-contradictory and hides a live-membership miss
  // (SPL-298). Fail closed as FORBIDDEN, matching Org authz.
  return renderError(
    { code: "FORBIDDEN", message: "credential is not allowed for this App", details: {} },
    { requestId },
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
