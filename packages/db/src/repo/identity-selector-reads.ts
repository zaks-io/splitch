import { and, asc, eq } from "drizzle-orm";
import { appMemberships, apps, organizations, orgMemberships } from "../schema/index";
import type { Db } from "./client";

export interface AppSelectorCandidate {
  orgSlug: string;
  appId: string;
  appSlug: string;
}

/** Resolve an App key only through both of the caller's live membership axes. */
export function makeIdentitySelectorReads(db: Db) {
  return {
    findAppSelectorCandidatesForUser(
      userId: string,
      appKey: string,
    ): Promise<AppSelectorCandidate[]> {
      return db
        .select({
          orgSlug: organizations.slug,
          appId: apps.id,
          appSlug: apps.key,
        })
        .from(orgMemberships)
        .innerJoin(apps, and(eq(apps.organizationId, orgMemberships.orgId), eq(apps.key, appKey)))
        .innerJoin(
          appMemberships,
          and(eq(appMemberships.appId, apps.id), eq(appMemberships.userId, userId)),
        )
        .innerJoin(organizations, eq(organizations.id, apps.organizationId))
        .where(eq(orgMemberships.userId, userId))
        .orderBy(asc(organizations.slug), asc(apps.id));
    },
  };
}
