import { appScope, type Repository } from "@splitch/db";

type MembershipRole = "owner" | "admin" | "member";

interface PanelAppAccess {
  appId: string;
  appRole: MembershipRole;
  orgId: string;
  orgRole: MembershipRole;
}

export interface PanelSessionAccess {
  authorizeApp(
    actorId: string,
    appId: string,
    environmentId?: string,
  ): Promise<PanelAppAccess | null>;
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
  };
}
