import { UserRoleSchema, type UserRole } from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import { renderError } from "@splitch/worker-runtime";

export const ORG_MEMBER_ROLES: readonly UserRole[] = ["owner", "admin", "member"];
export const ORG_ADMIN_ROLES: readonly UserRole[] = ["owner", "admin"];
export const ORG_OWNER_ROLES: readonly UserRole[] = ["owner"];

interface OrgAuthzDeps {
  repo: Repository;
}

export async function requireOrgRole(
  deps: OrgAuthzDeps,
  orgId: string,
  actorId: string,
  allowed: readonly UserRole[],
  requestId: string,
): Promise<Response | null> {
  const membership = await deps.repo.identity.getOrgMembership(orgId, actorId);
  if (membership) {
    const role = UserRoleSchema.safeParse(membership.role);
    if (role.success && allowed.includes(role.data)) return null;
  }
  return renderError(
    { code: "FORBIDDEN", message: "credential is not allowed for this organization", details: {} },
    { requestId },
  );
}
