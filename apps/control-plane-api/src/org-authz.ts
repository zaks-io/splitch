import {
  MEMBERSHIP_WIDE_READ_AUTHORIZATION,
  type UserRole,
  UserRoleSchema,
} from "@splitch/contracts";
import type { Principal } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";

export const ORG_MEMBER_ROLES: readonly UserRole[] = ["owner", "admin", "member"];
export const ORG_ADMIN_ROLES: readonly UserRole[] = ["owner", "admin"];
export const ORG_OWNER_ROLES: readonly UserRole[] = ["owner"];

interface OrgAuthzDeps {
  repo: {
    identity: {
      getOrgMembership(orgId: string, actorId: string): PromiseLike<{ role: string } | null>;
    };
  };
}

type ScopedActor = Pick<Principal, "id" | "scopes" | "authorization" | "memberships">;

export async function requireOrgRole(
  deps: OrgAuthzDeps,
  orgId: string,
  actor: ScopedActor,
  allowed: readonly UserRole[],
  requestId: string,
): Promise<Response | null> {
  const hasAuthority =
    allowed.some((role) => actor.scopes.includes(`org:${orgId}:${role}`)) ||
    (actor.authorization === MEMBERSHIP_WIDE_READ_AUTHORIZATION &&
      actor.memberships?.organizations.some(
        (membership) => membership.id === orgId && allowed.includes(membership.role),
      ));
  if (!hasAuthority) return forbidden(requestId);

  const membership = await deps.repo.identity.getOrgMembership(orgId, actor.id);
  if (membership) {
    const role = UserRoleSchema.safeParse(membership.role);
    if (role.success && allowed.includes(role.data)) return null;
  }
  return forbidden(requestId);
}

function forbidden(requestId: string): Response {
  return renderError(
    { code: "FORBIDDEN", message: "credential is not allowed for this organization", details: {} },
    { requestId },
  );
}
