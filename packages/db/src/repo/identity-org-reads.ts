import { and, asc, eq } from "drizzle-orm";
import { apps, organizations, orgMemberships } from "../schema/index";
import type { Db } from "./client";

/**
 * Organization and membership READS, the mirror of `makeOrgMutations`.
 *
 * Org-or-identity scoped, NOT app-scoped (ADR-0018): an Org sits above Apps, so
 * these are bound by `org_id` or by their own primary key rather than routed
 * through `scopedTable`. Split out of `identity.ts` so that file stays inside
 * the repo file-size guard.
 */
export function makeOrgReads(db: Db) {
  return {
    async getOrg(orgId: string): Promise<typeof organizations.$inferSelect | null> {
      const rows = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      return rows[0] ?? null;
    },

    listOrgMemberships(orgId: string, options?: { limit?: number }) {
      const query = db
        .select()
        .from(orgMemberships)
        .where(eq(orgMemberships.orgId, orgId))
        .orderBy(asc(orgMemberships.createdAt), asc(orgMemberships.userId));
      return options?.limit === undefined ? query : query.limit(options.limit);
    },

    listOrgMembershipsForUser(userId: string, options?: { limit?: number }) {
      const query = db
        .select()
        .from(orgMemberships)
        .where(eq(orgMemberships.userId, userId))
        .orderBy(asc(orgMemberships.createdAt), asc(orgMemberships.orgId));
      return options?.limit === undefined ? query : query.limit(options.limit);
    },

    getOrgMembership(orgId: string, userId: string) {
      return db
        .select()
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
    },

    /**
     * The actor's membership in the Org that OWNS an App, resolved in one read.
     *
     * Authorizing an App-scoped call needs the owning Org's membership, and the
     * owning Org is only known from the App row. Fetching the App first makes
     * that a two-round-trip chain in front of every App request, and D1's round
     * trip dominates the query itself; naming the App instead of the Org makes
     * it one, so every other membership read in the same authorization can
     * issue concurrently rather than waiting behind it.
     */
    getOrgMembershipForApp(appId: string, userId: string) {
      return db
        .select()
        .from(orgMemberships)
        .where(
          and(
            eq(
              orgMemberships.orgId,
              db.select({ orgId: apps.organizationId }).from(apps).where(eq(apps.id, appId)),
            ),
            eq(orgMemberships.userId, userId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
    },

    /** Apps for an Org. Scoped by org_id (the tier above App), never by app_id. */
    listAppsForOrg(orgId: string, options?: { limit?: number }) {
      const query = db
        .select()
        .from(apps)
        .where(eq(apps.organizationId, orgId))
        .orderBy(asc(apps.createdAt), asc(apps.id));
      return options?.limit === undefined ? query : query.limit(options.limit);
    },
  };
}
