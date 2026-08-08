import { env as workerEnv } from "cloudflare:workers";
import { createRepository } from "@splitch/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { type ControlPanelBindings, controlPanelBindings } from "./bindings";
import { createControlPanelOrgMembersClient } from "./control-plane-org-members";
import { rehydrateLegacySession } from "./membership";
import {
  canViewOrgMembers,
  ORG_MEMBERS_LOCKED_MESSAGE,
  type OrgMemberList,
  type OrgMembersView,
} from "./org-members";
import { loadSessionFromRequest } from "./session";

export type OrgMembersResult =
  | { kind: "ok"; view: OrgMembersView }
  | { kind: "unauthenticated" }
  | { kind: "truncated"; limit: number }
  | { kind: "forbidden" };

/**
 * The Members read. `bindings`/`request` are explicit parameters for the same
 * reason `loadOrgAppListForRequest` takes them: `createServerFn`'s wrapped
 * export only behaves through the framework transform, so a direct test against
 * real Miniflare D1 + KV needs this inner function.
 */
export async function loadOrgMembersForRequest(
  bindings: ControlPanelBindings,
  request: Request,
  orgSlug: string,
): Promise<OrgMembersResult> {
  const loaded = await loadSessionFromRequest(bindings.SESSION_STORE, request);
  if (!loaded.ok) return { kind: "unauthenticated" };

  const session = await rehydrateLegacySession(
    createRepository(bindings.DB),
    bindings.SESSION_STORE,
    loaded.tokenHash,
    loaded.session,
  );
  const organization = session.orgs.find((org) => org.orgSlug === orgSlug);
  if (!organization) {
    return session.orgsTruncated
      ? { kind: "truncated", limit: session.orgs.length }
      : { kind: "forbidden" };
  }

  return {
    kind: "ok",
    view: {
      orgId: organization.orgId,
      orgSlug: organization.orgSlug,
      orgRole: organization.orgRole,
      userId: session.userId,
      members: canViewOrgMembers(organization.orgRole)
        ? await readMembers(bindings, session.userId, loaded.session.expiresAt, organization.orgId)
        : { kind: "locked", message: ORG_MEMBERS_LOCKED_MESSAGE },
    },
  };
}

export const loadOrgMembers = createServerFn({ method: "GET" })
  .validator((orgSlug: string) => orgSlug)
  .handler(({ data: orgSlug }) =>
    loadOrgMembersForRequest(controlPanelBindings(workerEnv), getRequest(), orgSlug),
  );

/**
 * Every non-success path carries the reason the screen will show. An absent
 * marker would be indistinguishable from an Organization with no members
 * (ADR-0036).
 */
async function readMembers(
  bindings: ControlPanelBindings,
  actorId: string,
  sessionExpiresAt: number,
  orgId: string,
): Promise<OrgMemberList> {
  const { CONTROL_PLANE_API, CONTROL_PANEL_DELEGATION_SECRET } = bindings;
  if (!CONTROL_PLANE_API || !CONTROL_PANEL_DELEGATION_SECRET) {
    return { kind: "unavailable", message: "the Control Plane binding is not configured" };
  }
  try {
    const result = await createControlPanelOrgMembersClient(
      CONTROL_PLANE_API,
      { actorId, sessionExpiresAt },
      CONTROL_PANEL_DELEGATION_SECRET,
    ).list({ orgId });
    return result.ok
      ? {
          kind: "ready",
          items: result.data.items.map((user) => ({
            userId: user.id,
            email: user.email,
            role: user.role,
          })),
        }
      : { kind: "unavailable", message: result.error.message };
  } catch (cause) {
    return {
      kind: "unavailable",
      message: cause instanceof Error ? cause.message : "the Control Plane could not be reached",
    };
  }
}
