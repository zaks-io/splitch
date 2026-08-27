import type { OrganizationMember, UserRole } from "@splitch/contracts";
import { listResponse, OrganizationMemberSchema } from "@splitch/contracts";
import type { ControlPlaneOperationResult } from "./operation-result";
import { parseControlPlaneResponse } from "./operation-result";

const OrganizationMemberListResponseSchema = listResponse(OrganizationMemberSchema);

/**
 * The Org membership surface the Control Panel reaches through its binding
 * delegation. Roles are re-derived from live D1 by the Worker on every call, so
 * this client carries no authority of its own.
 */

export interface PanelOrgMembersListInput {
  orgId: string;
}

export interface PanelOrgMemberAddInput {
  orgId: string;
  userId: string;
  role: UserRole;
}

export interface PanelOrgMemberUpdateInput {
  orgId: string;
  userId: string;
  role: UserRole;
}

export interface PanelOrgMemberRemoveInput {
  orgId: string;
  userId: string;
}

export type PanelOrgMembersListOutput = {
  items: OrganizationMember[];
  readLimit: number;
  readTruncated: boolean;
  cursor: string | null;
};

export interface PanelOrgMemberRemoveOutput {
  deleted: true;
}

export interface PanelOrgMembersClient {
  list(
    input: PanelOrgMembersListInput,
  ): Promise<ControlPlaneOperationResult<PanelOrgMembersListOutput>>;
  add(input: PanelOrgMemberAddInput): Promise<ControlPlaneOperationResult<OrganizationMember>>;
  update(
    input: PanelOrgMemberUpdateInput,
  ): Promise<ControlPlaneOperationResult<OrganizationMember>>;
  remove(
    input: PanelOrgMemberRemoveInput,
  ): Promise<ControlPlaneOperationResult<PanelOrgMemberRemoveOutput>>;
}

export function createPanelOrgMembersClient(options: {
  fetch: typeof fetch;
  baseUrl?: string;
}): PanelOrgMembersClient {
  const baseUrl = options.baseUrl ?? "https://control-plane.internal";
  const memberUrl = (orgId: string, userId?: string) =>
    new URL(
      `/orgs/${encodeURIComponent(orgId)}/members${userId ? `/${encodeURIComponent(userId)}` : ""}`,
      baseUrl,
    );

  return {
    async list(input) {
      const response = await options.fetch(memberUrl(input.orgId));
      return parseControlPlaneResponse(response, "organization_members_list", {
        safeParse: (body) => OrganizationMemberListResponseSchema.safeParse(body),
      });
    },
    async add(input) {
      const response = await options.fetch(memberUrl(input.orgId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: input.userId, role: input.role }),
      });
      return parseControlPlaneResponse(
        response,
        "organization_members_add",
        OrganizationMemberSchema,
      );
    },
    async update(input) {
      const response = await options.fetch(memberUrl(input.orgId, input.userId), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: input.role }),
      });
      return parseControlPlaneResponse(
        response,
        "organization_members_update",
        OrganizationMemberSchema,
      );
    },
    async remove(input) {
      const response = await options.fetch(memberUrl(input.orgId, input.userId), {
        method: "DELETE",
      });
      return parseControlPlaneResponse(response, "organization_members_remove", {
        safeParse: parseDeleted,
      });
    },
  };
}

function parseDeleted(
  input: unknown,
): { success: true; data: PanelOrgMemberRemoveOutput } | { success: false } {
  return isObject(input) && input.deleted === true
    ? { success: true, data: { deleted: true } }
    : { success: false };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
