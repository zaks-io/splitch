import { appDeletionRetryActorHash, appScope, type Repository } from "@splitch/db";

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

interface PanelAppDeletionResumeAccess {
  appId: string;
  appRole: "owner";
}

export interface PanelSessionAccess {
  authorizeApp(
    actorId: string,
    appId: string,
    environmentId?: string,
  ): Promise<PanelAppAccess | null>;
  authorizeAppDeletionResume(
    actorId: string,
    appId: string,
  ): Promise<PanelAppDeletionResumeAccess | null>;
  authorizeOrg(actorId: string, orgId: string): Promise<PanelOrgAccess | null>;
}

/** Resolve current panel authority from D1 instead of trusting cached session roles. */
export function makePanelSessionAccess(repo: Pick<Repository, "identity">): PanelSessionAccess {
  return {
    /**
     * All four reads issue CONCURRENTLY. Loading the App first to learn its Org
     * put a serial D1 round trip in front of every authorized App request, and
     * D1's round trip dominates the query itself; `getOrgMembershipForApp`
     * resolves the same Org from the App id so nothing has to wait for it.
     */
    async authorizeApp(actorId, appId, environmentId) {
      const [app, orgMembership, appMembership, environment] = await Promise.all([
        repo.identity.getApp(appId),
        repo.identity.getOrgMembershipForApp(appId, actorId),
        repo.identity.getAppMembership(appScope(appId), actorId),
        environmentId
          ? repo.identity.getEnvironment(appScope(appId), environmentId)
          : Promise.resolve(true),
      ]);
      if (!(app && orgMembership && appMembership && environment)) return null;

      return {
        appId,
        appRole: appMembership.role as MembershipRole,
        orgId: app.organizationId,
        orgRole: orgMembership.role as MembershipRole,
      };
    },

    /**
     * Once the atomic D1 cascade removes the App and its memberships, only the
     * durable deletion saga can authorize the original owner to finish cleanup.
     * A saga that has not crossed that boundary grants nothing.
     */
    async authorizeAppDeletionResume(actorId, appId) {
      const saga = await repo.identity.getAppDeletionSaga(appId);
      if (!saga || saga.phase === "started") return null;
      const actorMatches =
        saga.phase === "complete"
          ? saga.retryActorHash !== null &&
            saga.retryActorHash === (await appDeletionRetryActorHash(appId, actorId))
          : saga.actorId === actorId;
      return actorMatches ? { appId, appRole: "owner" } : null;
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
