import { env as workerEnv } from "cloudflare:workers";
import { type OrganizationMember, UserRoleSchema } from "@splitch/contracts";
import type { ControlPlaneOperationResult } from "@splitch/control-plane-sdk";
import type { PanelOrgMemberRemoveOutput } from "@splitch/control-plane-sdk/panel-org-members";
import { createRepository } from "@splitch/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { type ControlPanelMutationBindings, controlPanelMutationBindings } from "./bindings";
import { createControlPanelOrgMembersClient } from "./control-plane-org-members";
import { rehydrateLegacySession } from "./membership";
import { ORGANIZATIONS_TRUNCATED_DESCRIPTION } from "./organizations-truncated";
import { loadSessionFromRequest } from "./session-refresh";

const OrgScopeSchema = z.object({ orgId: z.string().min(1) });
const MemberScopeSchema = OrgScopeSchema.extend({ userId: z.string().min(1) });
const AddMemberSchema = OrgScopeSchema.extend({
  userId: z.string().trim().min(1),
  role: UserRoleSchema,
});
const UpdateMemberSchema = MemberScopeSchema.extend({ role: UserRoleSchema });

export const addControlPanelOrgMember = createServerFn({ method: "POST" })
  .validator((data: unknown) => AddMemberSchema.safeParse(data))
  .handler(async ({ data: parsed }): Promise<ControlPlaneOperationResult<OrganizationMember>> => {
    if (!parsed.success) return malformed("The member request is malformed");
    const authorized = await authorizedOrgMembersClient(parsed.data.orgId);
    if (!authorized.ok) return authorized.result;
    return authorized.members.add(parsed.data);
  });

export const updateControlPanelOrgMemberRole = createServerFn({ method: "POST" })
  .validator((data: unknown) => UpdateMemberSchema.safeParse(data))
  .handler(async ({ data: parsed }): Promise<ControlPlaneOperationResult<OrganizationMember>> => {
    if (!parsed.success) return malformed("The role change is malformed");
    const authorized = await authorizedOrgMembersClient(parsed.data.orgId);
    if (!authorized.ok) return authorized.result;
    return authorized.members.update(parsed.data);
  });

export const removeControlPanelOrgMember = createServerFn({ method: "POST" })
  .validator((data: unknown) => MemberScopeSchema.safeParse(data))
  .handler(
    async ({ data: parsed }): Promise<ControlPlaneOperationResult<PanelOrgMemberRemoveOutput>> => {
      if (!parsed.success) return malformed("The member removal request is malformed");
      const authorized = await authorizedOrgMembersClient(parsed.data.orgId);
      if (!authorized.ok) return authorized.result;
      return authorized.members.remove(parsed.data);
    },
  );

async function authorizedOrgMembersClient(orgId: string) {
  const bindings = controlPanelMutationBindings(workerEnv);
  return authorizeOrgMembersMutationForRequest(bindings, getRequest(), orgId);
}

export async function authorizeOrgMembersMutationForRequest(
  bindings: ControlPanelMutationBindings,
  request: Request,
  orgId: string,
) {
  const loaded = await loadSessionFromRequest(bindings, request);
  if (!loaded.ok) {
    return {
      ok: false as const,
      result: {
        ok: false as const,
        status: 401,
        error: { code: "UNAUTHORIZED" as const, message: "authentication required", details: {} },
      },
    };
  }
  const session = await rehydrateLegacySession(
    createRepository(bindings.DB),
    bindings.SESSION_STORE,
    loaded.tokenHash,
    loaded.session,
  );
  if (!session.orgs.some((organization) => organization.orgId === orgId)) {
    return {
      ok: false as const,
      result: {
        ok: false as const,
        status: 403,
        error: {
          code: "FORBIDDEN" as const,
          message: session.orgsTruncated
            ? ORGANIZATIONS_TRUNCATED_DESCRIPTION
            : "organization access denied",
          details: {},
        },
      },
    };
  }
  return {
    ok: true as const,
    members: createControlPanelOrgMembersClient(
      bindings.CONTROL_PLANE_API,
      { actorId: session.userId, sessionExpiresAt: session.expiresAt },
      bindings.CONTROL_PANEL_DELEGATION_SECRET,
    ),
  };
}

function malformed<T>(message: string): ControlPlaneOperationResult<T> {
  return {
    ok: false,
    status: 400,
    error: { code: "VALIDATION_ERROR", message, details: { issues: [] } },
  };
}
