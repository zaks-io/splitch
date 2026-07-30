import { and, desc, eq, inArray } from "drizzle-orm";
import { appMemberships, apps, organizations, orgMemberships } from "../schema/index";
import type { Db } from "./client";

/**
 * The two reads that materialize a sign-in session.
 *
 * Split out of `makeIdentityRepo` because they belong together: both exist to
 * keep session materialization at a FLAT query count regardless of how many
 * Organizations and Apps a User belongs to.
 */
export function makeSessionReads(db: Db) {
  return {
    /**
     * The User's Organization memberships joined to the Organizations themselves,
     * in one query whatever the membership count.
     *
     * This exists because the per-membership `getOrg` it replaces made session
     * materialization cost O(N) SEQUENTIAL D1 round trips inside a single Worker
     * invocation. A User who creates Organizations in a loop drives their own
     * session rebuild past the Workers subrequest ceiling, and since nothing
     * deletes the Organizations, the session can then never be rebuilt: a
     * durable self-inflicted sign-in lockout.
     *
     * LEFT joined on purpose. An inner join would make a membership row pointing
     * at a missing Organization silently vanish, turning a broken foreign key
     * into a smaller-but-plausible list. The null reaches the caller, which
     * refuses (ADR-0036).
     *
     * `limit` is the caller's bound. Ask for one more row than you intend to
     * keep and you learn whether you truncated.
     *
     * NEWEST FIRST, so the row a `LIMIT` drops is the membership the User has
     * gone longest without acquiring. Ascending order made the create-at-cap
     * case maximally bad: the Organization dropped was by construction the one
     * just created, which is also the one being navigated to. An Organization
     * you have not touched in a long time is the safe one to lose to the cap,
     * and the truncation notice covers it.
     */
    listOrgMembershipsWithOrgForUser(userId: string, limit: number) {
      return (
        db
          .select({ role: orgMemberships.role, org: organizations })
          .from(orgMemberships)
          .leftJoin(organizations, eq(organizations.id, orgMemberships.orgId))
          .where(eq(orgMemberships.userId, userId))
          // `orgId` is the tiebreaker, so the LIMIT+1 boundary is stable across
          // rebuilds instead of shuffling which Organizations a User can see.
          .orderBy(desc(orgMemberships.createdAt), desc(orgMemberships.orgId))
          .limit(limit)
      );
    },

    /**
     * The User's App memberships joined to their Apps, restricted to the given
     * Organizations. One query covering every Organization at once, replacing a
     * `listAppsForOrg` + per-App `getAppMembership` loop that was quadratic in
     * (Organizations x Apps).
     */
    listAppMembershipsWithAppForUser(userId: string, orgIds: readonly string[]) {
      if (orgIds.length === 0) {
        return Promise.resolve([]);
      }
      return db
        .select({ role: appMemberships.role, app: apps })
        .from(appMemberships)
        .innerJoin(apps, eq(apps.id, appMemberships.appId))
        .where(and(eq(appMemberships.userId, userId), inArray(apps.organizationId, [...orgIds])))
        .orderBy(apps.createdAt, apps.id);
    },
  };
}
