import { appScope, type Repository } from "@splitch/db";

type MembershipRole = "owner" | "admin" | "member";

interface PanelAppAccess {
  appId: string;
  appRole: MembershipRole;
  orgId: string;
  orgRole: MembershipRole;
}

interface PanelOrgAccess {
  orgId: string;
  orgRole: MembershipRole;
}

export interface PanelSessionAccess {
  authorizeApp(
    actorId: string,
    appId: string,
    environmentId?: string,
  ): Promise<PanelAppAccess | null>;
  authorizeOrg(actorId: string, orgId: string): Promise<PanelOrgAccess | null>;
}

/** Resolve current panel authority from D1 instead of trusting cached session roles. */
export function makePanelSessionAccess(repo: Pick<Repository, "identity">): PanelSessionAccess {
  return {
    async authorizeApp(actorId, appId, environmentId) {
      const app = await repo.identity.getApp(appId);
      if (!app) return null;

      const [orgMembership, appMembership, environment] = await Promise.all([
        repo.identity.getOrgMembership(app.organizationId, actorId),
        repo.identity.getAppMembership(appScope(appId), actorId),
        environmentId
          ? repo.identity.getEnvironment(appScope(appId), environmentId)
          : Promise.resolve(true),
      ]);
      if (!orgMembership || !appMembership || !environment) return null;

      return {
        appId,
        appRole: appMembership.role as MembershipRole,
        orgId: app.organizationId,
        orgRole: orgMembership.role as MembershipRole,
      };
    },

    /**
     * Org-scoped authority for the Organization-wide reads that name no App.
     * Live membership is the only thing consulted: an actor with no membership
     * row in this Organization gets no principal at all, so a delegation that
     * names someone else's Org cannot become authority over it.
     */
    async authorizeOrg(actorId, orgId) {
      const membership = await repo.identity.getOrgMembership(orgId, actorId);
      if (!membership) return null;
      return { orgId, orgRole: membership.role as MembershipRole };
    },
  };
}
