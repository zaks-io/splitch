import { UserRoleSchema, type User, type UserRole } from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import { objectBody, pathParam } from "./handler-input.js";
import { ORG_ADMIN_ROLES, ORG_MEMBER_ROLES, ORG_OWNER_ROLES, requireOrgRole } from "./org-authz.js";

export interface MemberProfile {
  email: string;
}

export type MemberProfileResolver = (args: {
  orgId: string;
  userId: string;
  request: Request;
}) => Promise<MemberProfile | null> | MemberProfile | null;

interface OrgHandlerDeps {
  repo: Repository;
  memberProfileResolver?: MemberProfileResolver;
  nowIso?: () => string;
}

type OrgMembership = NonNullable<Awaited<ReturnType<Repository["identity"]["getOrgMembership"]>>>;

export function makeOrgHandlers(deps: OrgHandlerDeps) {
  const now = () => deps.nowIso?.() ?? new Date().toISOString();

  return {
    async getOrg({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const orgId = pathParam(input, "orgId");
      const forbidden = await requireOrgRole(
        deps,
        orgId,
        principal.id,
        ORG_MEMBER_ROLES,
        requestId,
      );
      if (forbidden) return forbidden;

      const org = await deps.repo.identity.getOrg(orgId);
      if (!org) return organizationNotFound(requestId);
      return Response.json(orgResponse(org));
    },

    async updateOrg({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const orgId = pathParam(input, "orgId");
      const forbidden = await requireOrgRole(deps, orgId, principal.id, ORG_OWNER_ROLES, requestId);
      if (forbidden) return forbidden;

      const payload = objectBody(input);
      const values = {
        ...(payload.name !== undefined ? { name: payload.name as string } : {}),
        ...(payload.plan !== undefined ? { plan: payload.plan as string } : {}),
        updatedAt: now(),
      };

      const org = await deps.repo.identity.updateOrg(orgId, values);
      if (!org) return organizationNotFound(requestId);
      return Response.json(orgResponse(org));
    },

    async listMembers({ input, request, principal, requestId }: HandlerArgs<unknown>) {
      const orgId = pathParam(input, "orgId");
      const forbidden = await requireOrgRole(deps, orgId, principal.id, ORG_ADMIN_ROLES, requestId);
      if (forbidden) return forbidden;

      const org = await deps.repo.identity.getOrg(orgId);
      if (!org) return organizationNotFound(requestId);

      const rows = await deps.repo.identity.listOrgMemberships(orgId);
      const items: User[] = [];
      for (const row of rows) {
        const member = await memberResponse(deps, row, request, requestId);
        if (member instanceof Response) return member;
        items.push(member);
      }
      return Response.json({ items });
    },

    async addMember({ input, request, principal, requestId }: HandlerArgs<unknown>) {
      const orgId = pathParam(input, "orgId");
      const forbidden = await requireOrgRole(deps, orgId, principal.id, ORG_ADMIN_ROLES, requestId);
      if (forbidden) return forbidden;

      const org = await deps.repo.identity.getOrg(orgId);
      if (!org) return organizationNotFound(requestId);

      const payload = objectBody(input);
      const userId = payload.userId as string;
      const role = UserRoleSchema.parse(payload.role);
      const profile = await resolveProfile(deps, orgId, userId, request, requestId);
      if (profile instanceof Response) return profile;

      const existing = await deps.repo.identity.getOrgMembership(orgId, userId);
      if (existing) return Response.json(userFromMembership(existing, profile));

      const row = await deps.repo.identity.createOrgMembership({
        orgId,
        userId,
        role,
        createdAt: now(),
      });
      return Response.json(userFromMembership(row, profile));
    },

    async updateMember({ input, request, principal, requestId }: HandlerArgs<unknown>) {
      const orgId = pathParam(input, "orgId");
      const userId = pathParam(input, "userId");
      const forbidden = await requireOrgRole(deps, orgId, principal.id, ORG_OWNER_ROLES, requestId);
      if (forbidden) return forbidden;

      const current = await existingMember(deps, orgId, userId, requestId);
      if (current instanceof Response) return current;

      const role = UserRoleSchema.parse(objectBody(input).role);
      const lastOwner = await rejectLastOwnerRemoval(deps, orgId, current, role, requestId);
      if (lastOwner) return lastOwner;

      const profile = await resolveProfile(deps, orgId, userId, request, requestId);
      if (profile instanceof Response) return profile;

      const updated = await deps.repo.identity.updateOrgMembershipRole(orgId, userId, role);
      if (!updated) return failedMemberUpdate(current, role, orgId, requestId);
      return Response.json(userFromMembership(updated, profile));
    },

    async removeMember({ input, principal, requestId }: HandlerArgs<unknown>) {
      const orgId = pathParam(input, "orgId");
      const userId = pathParam(input, "userId");
      const forbidden = await requireOrgRole(deps, orgId, principal.id, ORG_OWNER_ROLES, requestId);
      if (forbidden) return forbidden;

      const current = await existingMember(deps, orgId, userId, requestId);
      if (current instanceof Response) return current;

      const lastOwner = await rejectLastOwnerRemoval(deps, orgId, current, null, requestId);
      if (lastOwner) return lastOwner;

      const deleted = await deps.repo.identity.deleteOrgMembership(orgId, userId);
      if (deleted === 0) return failedMemberDelete(current, orgId, requestId);
      return Response.json({ deleted: true });
    },
  };
}

function failedMemberUpdate(
  current: OrgMembership,
  nextRole: UserRole,
  orgId: string,
  requestId: string,
): Response {
  if (current.role === "owner" && nextRole !== "owner") {
    return lastOwnerRequired(orgId, requestId);
  }
  return userNotFound(requestId);
}

function failedMemberDelete(current: OrgMembership, orgId: string, requestId: string): Response {
  return current.role === "owner" ? lastOwnerRequired(orgId, requestId) : userNotFound(requestId);
}

async function existingMember(
  deps: OrgHandlerDeps,
  orgId: string,
  userId: string,
  requestId: string,
): Promise<OrgMembership | Response> {
  const org = await deps.repo.identity.getOrg(orgId);
  if (!org) return organizationNotFound(requestId);

  const current = await deps.repo.identity.getOrgMembership(orgId, userId);
  if (!current) return userNotFound(requestId);

  return current;
}

function orgResponse(org: NonNullable<Awaited<ReturnType<Repository["identity"]["getOrg"]>>>) {
  return {
    id: org.id,
    name: org.name,
    plan: org.plan,
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
  };
}

async function memberResponse(
  deps: OrgHandlerDeps,
  membership: OrgMembership,
  request: Request,
  requestId: string,
): Promise<User | Response> {
  const profile = await resolveProfile(
    deps,
    membership.orgId,
    membership.userId,
    request,
    requestId,
  );
  if (profile instanceof Response) return profile;
  return userFromMembership(membership, profile);
}

async function resolveProfile(
  deps: OrgHandlerDeps,
  orgId: string,
  userId: string,
  request: Request,
  requestId: string,
): Promise<MemberProfile | Response> {
  if (!deps.memberProfileResolver) return memberProfileUnavailable(requestId);
  const profile = await deps.memberProfileResolver({ orgId, userId, request });
  if (!profile) return userNotFound(requestId);
  return profile;
}

function userFromMembership(membership: OrgMembership, profile: MemberProfile): User {
  return {
    id: membership.userId,
    email: profile.email,
    organizationId: membership.orgId,
    role: UserRoleSchema.parse(membership.role),
    createdAt: membership.createdAt,
  };
}

async function rejectLastOwnerRemoval(
  deps: OrgHandlerDeps,
  orgId: string,
  membership: OrgMembership,
  nextRole: UserRole | null,
  requestId: string,
): Promise<Response | null> {
  if (membership.role !== "owner" || nextRole === "owner") return null;

  const memberships = await deps.repo.identity.listOrgMemberships(orgId);
  const ownerCount = memberships.filter((row) => row.role === "owner").length;
  if (ownerCount > 1) return null;

  return lastOwnerRequired(orgId, requestId);
}

function organizationNotFound(requestId: string): Response {
  return renderError(
    { code: "ORGANIZATION_NOT_FOUND", message: "organization not found", details: {} },
    { requestId },
  );
}

function userNotFound(requestId: string): Response {
  return renderError(
    { code: "USER_NOT_FOUND", message: "user not found", details: {} },
    { requestId },
  );
}

function memberProfileUnavailable(requestId: string): Response {
  return renderError(
    {
      code: "SERVICE_UNAVAILABLE",
      message: "member profile resolver is not configured",
      details: { retryAfterMs: 1000 },
    },
    { requestId },
  );
}

function lastOwnerRequired(orgId: string, requestId: string): Response {
  return renderError(
    {
      code: "LAST_OWNER_REQUIRED",
      message: "organization must retain at least one owner",
      details: { orgId },
    },
    { requestId },
  );
}
